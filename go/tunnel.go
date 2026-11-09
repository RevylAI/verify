package verify

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	quickTunnelURL  = regexp.MustCompile(`(?i)https://[a-z0-9-]+\.trycloudflare\.com`)
	quickTunnelHost = regexp.MustCompile(`(?i)[a-z0-9-]+\.trycloudflare\.com`)
	rateLimitLine   = regexp.MustCompile(`\b429\b`)
	versionLine     = regexp.MustCompile(`version (\d+\.\d+\.\d+)`)
)

const (
	minCloudflaredVersion    = "2026.10.2"
	pinnedCloudflaredVersion = "2026.10.7"
	downloadTimeout          = 120 * time.Second
	downloadMaxBytes         = 150 * 1024 * 1024
	tunnelStartTimeout       = 60 * time.Second
	tunnelStopGrace          = 5 * time.Second
	probeTimeout             = 5 * time.Second
	logTailLines             = 20
)

var rateLimitBackoff = []time.Duration{5 * time.Second, 15 * time.Second}

type pinnedAsset struct {
	asset        string
	assetSHA256  string
	binarySHA256 string
}

var pinnedCloudflared = map[string]pinnedAsset{
	"linux-x64": {
		asset:        "cloudflared-linux-amd64",
		assetSHA256:  "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872",
		binarySHA256: "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872",
	},
	"linux-arm64": {
		asset:        "cloudflared-linux-arm64",
		assetSHA256:  "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775",
		binarySHA256: "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775",
	},
	"darwin-arm64": {
		asset:        "cloudflared-darwin-arm64.tgz",
		assetSHA256:  "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd",
		binarySHA256: "2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12",
	},
	"darwin-x64": {
		asset:        "cloudflared-darwin-amd64.tgz",
		assetSHA256:  "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848",
		binarySHA256: "5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86",
	},
}

type cloudflaredLookup struct {
	done chan struct{}
	path string
	err  error
}

var (
	cloudflaredMu sync.Mutex
	cloudflared   *cloudflaredLookup
	edgeOnce      sync.Once
	edgeAddress   string
)

// quickTunnel is a Cloudflare quick tunnel for one local port, served by cloudflared in its own process group.
type quickTunnel struct {
	port       int
	cmd        *exec.Cmd
	exited     chan struct{}
	readDone   chan struct{}
	mu         sync.Mutex
	url        string
	registered bool
	tail       []string
}

func spawnQuickTunnel(binary string, port int) (*quickTunnel, error) {
	configDir, err := os.MkdirTemp("", "verify-tunnel-")
	if err != nil {
		return nil, &Error{Code: ErrTunnelFailed, Message: "Could not create a cloudflared config: " + err.Error(), Cause: err}
	}
	configFile := filepath.Join(configDir, "config.yml")
	if err := os.WriteFile(configFile, []byte("no-autoupdate: true\n"), 0o600); err != nil {
		_ = os.RemoveAll(configDir)
		return nil, &Error{Code: ErrTunnelFailed, Message: "Could not create a cloudflared config: " + err.Error(), Cause: err}
	}
	cmd := exec.Command(binary, "tunnel", "--no-autoupdate", "--config", configFile, "--metrics", "127.0.0.1:0", "--grace-period", "1s", "--url", "http://localhost:"+strconv.Itoa(port))
	setProcessGroup(cmd)
	reader, writer, err := os.Pipe()
	if err != nil {
		_ = os.RemoveAll(configDir)
		return nil, &Error{Code: ErrTunnelFailed, Message: "Could not run cloudflared: " + err.Error(), Cause: err}
	}
	cmd.Stderr = writer
	if err := cmd.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		_ = os.RemoveAll(configDir)
		return nil, &Error{Code: ErrTunnelFailed, Message: "Could not run cloudflared: " + err.Error(), Cause: err}
	}
	_ = writer.Close()
	t := &quickTunnel{port: port, cmd: cmd, exited: make(chan struct{}), readDone: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(t.exited)
	}()
	go func() {
		defer close(t.readDone)
		defer os.RemoveAll(configDir)
		defer reader.Close()
		lines := bufio.NewReader(reader)
		for {
			line, err := lines.ReadString('\n')
			if line != "" {
				t.read(strings.TrimRight(line, "\r\n"))
			}
			if err != nil {
				return
			}
		}
	}()
	return t, nil
}

func (t *quickTunnel) read(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.url == "" {
		t.url = quickTunnelURL.FindString(line)
	}
	if strings.Contains(line, "Registered tunnel connection") {
		t.registered = true
	}
	if strings.Contains(line, " INF ") {
		return
	}
	t.tail = append(t.tail, quickTunnelURL.ReplaceAllString(line, "<tunnel url>"))
	if len(t.tail) > logTailLines {
		t.tail = t.tail[1:]
	}
}

func (t *quickTunnel) URL() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.url
}

func (t *quickTunnel) running() bool {
	select {
	case <-t.exited:
		return false
	default:
		return true
	}
}

func (t *quickTunnel) diagnostics() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.tail) == 0 {
		return "(nothing beyond informational lines)"
	}
	return strings.Join(t.tail, "\n")
}

func (t *quickTunnel) rateLimited() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, line := range t.tail {
		if rateLimitLine.MatchString(line) {
			return true
		}
	}
	return false
}

func (t *quickTunnel) close() error {
	return stopProcessGroup(t.cmd.Process.Pid, tunnelStopGrace, "cloudflared")
}

func (t *quickTunnel) waitStarted(ctx context.Context, deadline time.Time) error {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		t.mu.Lock()
		up := t.url != "" && t.registered
		t.mu.Unlock()
		if up {
			return nil
		}
		select {
		case <-t.exited:
			select {
			case <-t.readDone:
			case <-time.After(time.Second):
			}
			return &Error{Code: ErrTunnelFailed, Message: fmt.Sprintf("cloudflared exited (%s) before the quick tunnel for port %d was up. Its last output:\n%s", exitDescription(t.cmd.ProcessState), t.port, t.diagnostics())}
		default:
		}
		if time.Now().After(deadline) {
			return &Error{Code: ErrTunnelFailed, Message: fmt.Sprintf("The quick tunnel for port %d was not up after %d s. cloudflared's last output:\n%s", t.port, int(tunnelStartTimeout/time.Second), t.diagnostics())}
		}
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-ticker.C:
		}
	}
}

// startQuickTunnel starts a quick tunnel for a local port, retrying Cloudflare rate limiting within 60 s.
// register receives each spawned tunnel before it is up, so teardown can stop it.
func startQuickTunnel(ctx context.Context, port int, log func(string), register func(*quickTunnel)) (*quickTunnel, error) {
	binary, err := resolveCloudflared(ctx, log)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(tunnelStartTimeout)
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			return nil, context.Cause(ctx)
		}
		t, err := spawnQuickTunnel(binary, port)
		if err != nil {
			return nil, err
		}
		register(t)
		err = t.waitStarted(ctx, deadline)
		if err == nil {
			return t, nil
		}
		_ = t.close()
		if ctx.Err() != nil || !t.rateLimited() {
			return nil, err
		}
		if attempt == len(rateLimitBackoff) || time.Now().Add(rateLimitBackoff[attempt]).After(deadline) {
			return nil, &Error{Code: ErrTunnelFailed, Message: fmt.Sprintf("Cloudflare refused to create a quick tunnel for port %d (HTTP 429). Quick tunnels are rate-limited per network address, so wait a few minutes before trying again.", port), Cause: err}
		}
		log(fmt.Sprintf("Cloudflare rate-limited the quick tunnel for port %d; trying again in %d s.", port, int(rateLimitBackoff[attempt]/time.Second)))
		if err := pause(ctx, rateLimitBackoff[attempt]); err != nil {
			return nil, context.Cause(ctx)
		}
	}
}

// probeQuickTunnel returns the HTTP status a quick tunnel URL answers with right now, or a network error code.
// A new quick-tunnel hostname takes a few seconds to appear in DNS, and a lookup made before then is cached as
// missing for up to a minute. So the probe reaches Cloudflare's edge by the address of trycloudflare.com and
// names the tunnel host in TLS and the Host header, and the tunnel host is never looked up early. The
// certificate is still checked against the tunnel host.
func probeQuickTunnel(rawURL, path string) (int, string) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return 0, "INVALID_URL"
	}
	host := u.Hostname()
	edgeOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
		defer cancel()
		for _, network := range []string{"ip4", "ip"} {
			if addresses, err := net.DefaultResolver.LookupIP(ctx, network, "trycloudflare.com"); err == nil && len(addresses) > 0 {
				edgeAddress = addresses[0].String()
				return
			}
		}
	})
	dial := host
	if edgeAddress != "" {
		dial = edgeAddress
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(dial, "443"))
		},
		TLSClientConfig:   &tls.Config{ServerName: host},
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	return probeHTTP(&http.Client{Transport: transport}, "https://"+host+path)
}

func probeHTTP(c *http.Client, target string) (int, string) {
	c.Timeout = probeTimeout
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := c.Get(target)
	if err != nil {
		return 0, networkError(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode, ""
}

func networkError(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "TIMEOUT"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "ENOTFOUND"
	}
	var certErr *tls.CertificateVerificationError
	var hostErr x509.HostnameError
	if errors.As(err, &certErr) || errors.As(err, &hostErr) {
		return "CERTIFICATE_VERIFY_FAILED"
	}
	if name, ok := errnoName(err); ok {
		return name
	}
	return quickTunnelHost.ReplaceAllString(err.Error(), "<tunnel host>")
}

// resolveCloudflared finds or downloads cloudflared once per process. Waiting for it ends when ctx does; the
// lookup itself keeps running for later callers, bounded by its own timeouts.
func resolveCloudflared(ctx context.Context, log func(string)) (string, error) {
	cloudflaredMu.Lock()
	lookup := cloudflared
	if lookup == nil {
		lookup = &cloudflaredLookup{done: make(chan struct{})}
		cloudflared = lookup
		go func() {
			lookup.path, lookup.err = findCloudflared(log)
			if lookup.err != nil {
				cloudflaredMu.Lock()
				cloudflared = nil
				cloudflaredMu.Unlock()
			}
			close(lookup.done)
		}()
	}
	cloudflaredMu.Unlock()
	select {
	case <-lookup.done:
		return lookup.path, lookup.err
	case <-ctx.Done():
		return "", context.Cause(ctx)
	}
}

func findCloudflared(log func(string)) (string, error) {
	ctx := context.Background()
	installed := cloudflaredVersion(ctx, "cloudflared")
	if installed != "" && compareVersions(installed, minCloudflaredVersion) >= 0 {
		return "cloudflared", nil
	}
	if installed != "" {
		log(fmt.Sprintf("Ignoring cloudflared %s on PATH: releases before %s trust revoked certificates. Using the pinned %s instead.", installed, minCloudflaredVersion, pinnedCloudflaredVersion))
	}
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	key := runtime.GOOS + "-" + arch
	pinned, ok := pinnedCloudflared[key]
	if !ok {
		return "", failure(ErrTunnelUnavailable, fmt.Sprintf("cloudflared is not on PATH, and Verify has no pinned cloudflared for %s-%s. Install cloudflared %s or later.", runtime.GOOS, runtime.GOARCH, minCloudflaredVersion))
	}
	cache := os.Getenv("XDG_CACHE_HOME")
	if cache == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cache = filepath.Join(home, ".cache")
		}
	}
	var errs []string
	for _, base := range []string{cache, os.TempDir()} {
		if base == "" {
			continue
		}
		directory := filepath.Join(base, "revyl-verify", "cloudflared", pinnedCloudflaredVersion)
		binary := filepath.Join(directory, "cloudflared")
		if fileHasSHA256(binary, pinned.binarySHA256) {
			return binary, nil
		}
		err := os.MkdirAll(directory, 0o755)
		if err == nil {
			log(fmt.Sprintf("cloudflared is not on PATH. Downloading cloudflared %s into %s.", pinnedCloudflaredVersion, directory))
			err = downloadCloudflared(ctx, pinned, directory, binary)
		}
		if err == nil {
			return binary, nil
		}
		errs = append(errs, directory+": "+err.Error())
	}
	return "", failure(ErrTunnelUnavailable, fmt.Sprintf("cloudflared is not on PATH, and downloading the pinned cloudflared %s failed (%s). Install cloudflared %s or later on the runner.", pinnedCloudflaredVersion, strings.Join(errs, "; "), minCloudflaredVersion))
}

func downloadCloudflared(ctx context.Context, pinned pinnedAsset, directory, binary string) error {
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://github.com/cloudflare/cloudflared/releases/download/"+pinnedCloudflaredVersion+"/"+pinned.asset, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("GitHub returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > downloadMaxBytes {
		return errors.New("the download is larger than expected")
	}
	asset, err := io.ReadAll(io.LimitReader(resp.Body, downloadMaxBytes+1))
	if err != nil {
		return err
	}
	if len(asset) > downloadMaxBytes {
		return errors.New("the download is larger than expected")
	}
	if sha256Hex(asset) != pinned.assetSHA256 {
		return fmt.Errorf("%s did not match its pinned sha256", pinned.asset)
	}
	staging, err := os.MkdirTemp(directory, ".download-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	contents := asset
	if strings.HasSuffix(pinned.asset, ".tgz") {
		if contents, err = extractCloudflared(asset); err != nil {
			return err
		}
	}
	if sha256Hex(contents) != pinned.binarySHA256 {
		return errors.New("the extracted cloudflared did not match its pinned sha256")
	}
	staged := filepath.Join(staging, "cloudflared")
	if err := os.WriteFile(staged, contents, 0o755); err != nil {
		return err
	}
	return os.Rename(staged, binary)
}

func extractCloudflared(archive []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err != nil {
			return nil, errors.New("the archive has no cloudflared binary")
		}
		if header.Name == "cloudflared" {
			return io.ReadAll(io.LimitReader(reader, downloadMaxBytes))
		}
	}
}

func fileHasSHA256(path, expected string) bool {
	data, err := os.ReadFile(path)
	return err == nil && sha256Hex(data) == expected
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func cloudflaredVersion(ctx context.Context, binary string) string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, binary, "--version").Output()
	if err != nil {
		return ""
	}
	if match := versionLine.FindSubmatch(output); match != nil {
		return string(match[1])
	}
	return ""
}

func compareVersions(a, b string) int {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		var l, r int
		if i < len(left) {
			l, _ = strconv.Atoi(left[i])
		}
		if i < len(right) {
			r, _ = strconv.Atoi(right[i])
		}
		if l != r {
			return l - r
		}
	}
	return 0
}
