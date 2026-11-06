package verify

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// EnvironmentOptions configures Environment. Expose is required; every other field is optional.
type EnvironmentOptions struct {
	// Start is a shell command that starts the stack, run through sh -c in its own process group. It may keep
	// running or exit 0 once it has started things in the background. It gets the exposed URLs as environment
	// variables.
	Start string
	// Stop is a shell command run on Close, after the tunnels are gone and before the start command's process
	// group is stopped.
	Stop string
	// Seed is a shell command run once every exposed name is ready, with the URLs in its environment.
	Seed string
	// Expose gives each local port a public URL, published under the environment variable name it is keyed by.
	Expose map[string]int
	// Ready is an HTTP path per exposed name that must answer 2xx or 3xx, on localhost and through the public
	// URL, before Environment returns. A name without one waits for its port to accept connections and for its
	// URL to reach it.
	Ready map[string]string
	// Provider is how ports get public URLs. Only "quick-tunnel", a Cloudflare quick tunnel per port, exists;
	// it is the default.
	Provider string
	// Dir is the working directory for Start, Stop, and Seed. Defaults to the current directory.
	Dir string
	// Env adds environment variables to Start, Stop, and Seed.
	Env map[string]string
	// UnsetEnv removes inherited environment variables from Start, Stop, and Seed.
	UnsetEnv []string
	// ReadyTimeout bounds how long the stack may take to become ready on localhost and through every public
	// URL. Defaults to 5 minutes.
	ReadyTimeout time.Duration
	// SeedTimeout bounds the seed command. Defaults to 5 minutes.
	SeedTimeout time.Duration
	// StopTimeout bounds the stop command. Defaults to 2 minutes.
	StopTimeout time.Duration
	// ShowURLs prints each public URL. URLs are hidden by default because anyone who has one can reach the
	// stack, and CI logs can be public.
	ShowURLs bool
	// Log receives progress lines and the commands' output, possibly from several goroutines one line at a
	// time. Nil writes them to stderr; pass func(string) {} to turn them off.
	Log func(string)
}

// Env is a running stack with a public URL per exposed port. Close it after the run that uses the URLs has
// finished.
type Env struct {
	settings  environmentSettings
	urls      map[string]string
	mu        sync.Mutex
	logMu     sync.Mutex
	tunnels   map[string]*quickTunnel
	started   *envCommand
	closeOnce sync.Once
	closeErr  error
}

type environmentSettings struct {
	start, stop, seed string
	expose            []exposedPort
	dir               string
	env               map[string]string
	readyTimeout      time.Duration
	seedTimeout       time.Duration
	stopTimeout       time.Duration
	showURLs          bool
	log               func(string)
}

type exposedPort struct {
	name      string
	port      int
	readyPath string
}

type envCommand struct {
	label    string
	cmd      *exec.Cmd
	exited   chan struct{}
	readDone chan struct{}
	mu       sync.Mutex
	tail     []string
}

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const (
	startGroupGrace     = 10 * time.Second
	commandGrace        = 5 * time.Second
	readyPoll           = time.Second
	readyRequestTimeout = 5 * time.Second
	outputTailLines     = 40
	commandTimedOut     = -1
)

// Environment starts a stack on this machine and gives each exposed port a public URL, so a Revyl run in the
// cloud can reach it. Each port gets a Cloudflare quick tunnel before Start runs, so Start, Seed, and the run
// see the URLs. Environment returns once every name is ready and Seed has finished.
//
// Cancelling ctx aborts setup and tears down what was started. A setup error tears down too. After a
// successful return, call Close once the run that uses the URLs has settled; Verify installs no signal
// handlers, so use signal.NotifyContext for ctx and defer Close to clean up on Ctrl+C or SIGTERM. Errors use
// ErrEnvironmentStartFailed, ErrEnvironmentNotReady, ErrTunnelFailed, ErrTunnelUnavailable, and
// ErrCleanupFailed. Environment runs on macOS and Linux.
func Environment(ctx context.Context, options EnvironmentOptions) (*Env, error) {
	settings, err := validateEnvironment(options)
	if err != nil {
		return nil, err
	}
	e := &Env{settings: settings, urls: map[string]string{}, tunnels: map[string]*quickTunnel{}}
	if err := e.setUp(ctx); err != nil {
		if ctx.Err() != nil {
			err = &Error{Code: ErrEnvironmentStartFailed, Message: "Environment setup was cancelled.", Cause: context.Cause(ctx)}
		}
		if closeErr := e.Close(context.Background()); closeErr != nil {
			e.log(closeErr.Error())
		}
		return nil, err
	}
	return e, nil
}

// URLs returns the public URL of each exposed name.
func (e *Env) URLs() map[string]string {
	urls := make(map[string]string, len(e.urls))
	for name, value := range e.urls {
		urls[name] = value
	}
	return urls
}

// Variables returns the same URLs as plain values, ready to pass to a Revyl run as environment variables.
func (e *Env) Variables() map[string]string { return e.URLs() }

func validateEnvironment(options EnvironmentOptions) (environmentSettings, error) {
	bad := func(message string) (environmentSettings, error) {
		return environmentSettings{}, failure(ErrInvalidArgument, "Environment: "+message)
	}
	if !processGroupsSupported {
		return environmentSettings{}, failure(ErrInvalidArgument, "Environment runs on macOS and Linux runners.")
	}
	for _, command := range []struct{ name, value string }{{"Start", options.Start}, {"Stop", options.Stop}, {"Seed", options.Seed}} {
		if command.value != "" && strings.TrimSpace(command.value) == "" {
			return bad(command.name + " must be a non-empty shell command.")
		}
	}
	if len(options.Expose) == 0 {
		return bad("Expose must name at least one port, as map[string]int{\"NAME\": port}.")
	}
	for name := range options.Ready {
		if _, ok := options.Expose[name]; !ok {
			return bad(fmt.Sprintf("Ready[%q] has no matching Expose[%q].", name, name))
		}
	}
	if options.Provider != "" && options.Provider != "quick-tunnel" {
		return bad("Provider must be \"quick-tunnel\".")
	}
	settings := environmentSettings{
		start: options.Start, stop: options.Stop, seed: options.Seed, dir: options.Dir, showURLs: options.ShowURLs,
		readyTimeout: options.ReadyTimeout, seedTimeout: options.SeedTimeout, stopTimeout: options.StopTimeout, log: options.Log,
	}
	for _, timeout := range []struct {
		name     string
		value    *time.Duration
		fallback time.Duration
	}{{"ReadyTimeout", &settings.readyTimeout, 5 * time.Minute}, {"SeedTimeout", &settings.seedTimeout, 5 * time.Minute}, {"StopTimeout", &settings.stopTimeout, 2 * time.Minute}} {
		if *timeout.value < 0 {
			return bad(timeout.name + " must be positive.")
		}
		if *timeout.value == 0 {
			*timeout.value = timeout.fallback
		}
	}
	if settings.log == nil {
		settings.log = func(line string) { fmt.Fprintf(os.Stderr, "[verify] %s\n", line) }
	}
	for name, port := range options.Expose {
		if !environmentName.MatchString(name) {
			return bad(fmt.Sprintf("Expose name %q must be a valid environment variable name.", name))
		}
		if port < 1 || port > 65535 {
			return bad(fmt.Sprintf("Expose[%q] must be a port from 1 to 65535.", name))
		}
		path, ok := options.Ready[name]
		if ok && !strings.HasPrefix(path, "/") {
			return bad(fmt.Sprintf("Ready[%q] must be a path starting with /.", name))
		}
		settings.expose = append(settings.expose, exposedPort{name: name, port: port, readyPath: path})
	}
	sortExposed(settings.expose)
	settings.env = map[string]string{}
	for _, entry := range os.Environ() {
		if key, value, ok := strings.Cut(entry, "="); ok {
			settings.env[key] = value
		}
	}
	for _, key := range options.UnsetEnv {
		delete(settings.env, key)
	}
	for key, value := range options.Env {
		settings.env[key] = value
	}
	return settings, nil
}

func sortExposed(expose []exposedPort) {
	for i := 1; i < len(expose); i++ {
		for j := i; j > 0 && expose[j].name < expose[j-1].name; j-- {
			expose[j], expose[j-1] = expose[j-1], expose[j]
		}
	}
}

func (e *Env) log(line string) {
	e.logMu.Lock()
	defer e.logMu.Unlock()
	e.settings.log(line)
}

func (e *Env) setUp(ctx context.Context) error {
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	s := e.settings
	errs := make([]error, len(s.expose))
	var workers sync.WaitGroup
	for i, entry := range s.expose {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, errs[i] = startQuickTunnel(ctx, entry.port, e.log, func(t *quickTunnel) {
				e.mu.Lock()
				e.tunnels[entry.name] = t
				e.mu.Unlock()
			})
		}()
	}
	workers.Wait()
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	for _, entry := range s.expose {
		u := e.tunnels[entry.name].URL()
		e.urls[entry.name] = u
		if os.Getenv("GITHUB_ACTIONS") == "true" && !s.showURLs {
			fmt.Fprintf(os.Stdout, "::add-mask::%s\n", u)
		}
		if s.showURLs {
			e.log(fmt.Sprintf("Exposed port %d as %s=%s", entry.port, entry.name, u))
		} else {
			e.log(fmt.Sprintf("Exposed port %d as %s through a quick tunnel. The URL is hidden; set ShowURLs to print it.", entry.port, entry.name))
		}
	}
	if s.start != "" {
		started, err := e.run("start", s.start, true)
		if err != nil {
			return err
		}
		e.started = started
	}
	if err := e.waitUntilReady(ctx); err != nil {
		return err
	}
	names := make([]string, len(s.expose))
	for i, entry := range s.expose {
		names[i] = entry.name
	}
	e.log("Environment ready: " + strings.Join(names, ", ") + ".")
	if s.seed == "" {
		return nil
	}
	seed, err := e.run("seed", s.seed, true)
	if err != nil {
		return err
	}
	code, err := seed.finish(ctx, s.seedTimeout)
	if err != nil {
		return err
	}
	if code != 0 {
		return failure(ErrEnvironmentStartFailed, fmt.Sprintf("The seed command %s. Its last output:\n%s", describeOutcome(code, s.seedTimeout), seed.output()))
	}
	return nil
}

func (e *Env) waitUntilReady(ctx context.Context) error {
	s := e.settings
	deadline := time.Now().Add(s.readyTimeout)
	local := map[string]bool{}
	last := map[string]string{}
	pending := append([]exposedPort(nil), s.expose...)
	for {
		for i := 0; i < len(pending); i++ {
			entry := pending[i]
			if ctx.Err() != nil {
				return context.Cause(ctx)
			}
			if err := e.checkStart(entry.name); err != nil {
				return err
			}
			tunnel := e.tunnels[entry.name]
			if !tunnel.running() {
				return failure(ErrTunnelFailed, fmt.Sprintf("The quick tunnel for %s exited. cloudflared's last output:\n%s", entry.name, tunnel.diagnostics()))
			}
			if !local[entry.name] {
				var status int
				var problem string
				if entry.readyPath != "" {
					status, problem = probeHTTP(&http.Client{Transport: &http.Transport{DisableKeepAlives: true}}, "http://localhost:"+strconv.Itoa(entry.port)+entry.readyPath)
					local[entry.name] = status >= 200 && status < 400
				} else {
					problem = probeLocalPort(entry.port)
					local[entry.name] = problem == "open"
				}
				last[entry.name] = statusText(status, problem)
				if local[entry.name] {
					last[entry.name] = "no response"
				}
			}
			if local[entry.name] {
				status, problem := tunnel.probe(entry.readyPath)
				last[entry.name] = statusText(status, problem)
				if (entry.readyPath != "" && status >= 200 && status < 400) || (entry.readyPath == "" && status != 0 && status != 502 && status != 530) {
					pending = append(pending[:i], pending[i+1:]...)
					i--
					continue
				}
			}
			if time.Now().After(deadline) {
				where := "on localhost:" + strconv.Itoa(entry.port)
				if local[entry.name] {
					where = "through its public URL"
				}
				what := "the port"
				if entry.readyPath != "" {
					what = "GET " + entry.readyPath
				}
				if last[entry.name] == "" {
					last[entry.name] = "no response"
				}
				return failure(ErrEnvironmentNotReady, fmt.Sprintf("%s was not ready %s after %d s: %s last answered %s.", entry.name, where, int(s.readyTimeout.Round(time.Second)/time.Second), what, last[entry.name]))
			}
		}
		if len(pending) == 0 {
			return nil
		}
		if err := pause(ctx, readyPoll); err != nil {
			return context.Cause(ctx)
		}
	}
}

func (t *quickTunnel) probe(path string) (int, string) {
	if path == "" {
		path = "/"
	}
	return probeQuickTunnel(t.URL(), path)
}

func statusText(status int, problem string) string {
	if status != 0 {
		return "HTTP " + strconv.Itoa(status)
	}
	return problem
}

func probeLocalPort(port int) string {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("localhost", strconv.Itoa(port)), readyRequestTimeout)
	if err != nil {
		return networkError(err)
	}
	_ = conn.Close()
	return "open"
}

func (e *Env) checkStart(name string) error {
	if e.started == nil {
		return nil
	}
	select {
	case <-e.started.exited:
	default:
		return nil
	}
	state := e.started.cmd.ProcessState
	if state.Success() {
		return nil
	}
	how := "exited with code " + exitDescription(state)
	if state.ExitCode() < 0 {
		how = "was killed by " + exitDescription(state)
	}
	return failure(ErrEnvironmentStartFailed, fmt.Sprintf("The start command %s before %s was ready. Its last output:\n%s", how, name, e.started.output()))
}

// run starts a shell command in its own process group, streaming its output to the log with a label prefix.
func (e *Env) run(label, script string, withURLs bool) (*envCommand, error) {
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = e.settings.dir
	for key, value := range e.settings.env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	if withURLs {
		for key, value := range e.urls {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	setProcessGroup(cmd)
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, &Error{Code: ErrEnvironmentStartFailed, Message: fmt.Sprintf("Could not run the %s command: %v", label, err), Cause: err}
	}
	cmd.Stdout, cmd.Stderr = writer, writer
	if err := cmd.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, &Error{Code: ErrEnvironmentStartFailed, Message: fmt.Sprintf("Could not run the %s command: %v", label, err), Cause: err}
	}
	_ = writer.Close()
	c := &envCommand{label: label, cmd: cmd, exited: make(chan struct{}), readDone: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(c.exited)
	}()
	go func() {
		defer close(c.readDone)
		defer reader.Close()
		lines := bufio.NewReader(reader)
		for {
			line, err := lines.ReadString('\n')
			if line != "" {
				line = strings.TrimRight(line, "\r\n")
				if !e.settings.showURLs {
					line = quickTunnelURL.ReplaceAllString(line, "<tunnel url>")
				}
				c.mu.Lock()
				c.tail = append(c.tail, line)
				if len(c.tail) > outputTailLines {
					c.tail = c.tail[1:]
				}
				c.mu.Unlock()
				e.log(label + ": " + line)
			}
			if err != nil {
				return
			}
		}
	}()
	return c, nil
}

func (c *envCommand) output() string {
	select {
	case <-c.readDone:
	case <-time.After(time.Second):
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.tail, "\n")
}

// finish waits for a foreground command, stopping its process group when it overruns or ctx ends. It returns
// the exit code, or commandTimedOut.
func (c *envCommand) finish(ctx context.Context, timeout time.Duration) (int, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-c.exited:
		select {
		case <-c.readDone:
		case <-time.After(time.Second):
		}
		return exitStatus(c.cmd.ProcessState), nil
	case <-timer.C:
		return commandTimedOut, stopProcessGroup(c.cmd.Process.Pid, commandGrace, "command")
	case <-ctx.Done():
		if err := stopProcessGroup(c.cmd.Process.Pid, commandGrace, "command"); err != nil {
			return 0, err
		}
		return 0, context.Cause(ctx)
	}
}

func describeOutcome(code int, timeout time.Duration) string {
	if code == commandTimedOut {
		return fmt.Sprintf("ran longer than %d s and was stopped", int(timeout.Round(time.Second)/time.Second))
	}
	return fmt.Sprintf("exited with code %d", code)
}

// Close removes the public URLs, runs Stop, and stops the start command's process group, in that order. Every
// step is attempted and bounded; a cancelled ctx cuts only the stop command short. It returns
// ErrCleanupFailed naming the steps that failed. Calling it again returns the first call's result.
func (e *Env) Close(ctx context.Context) error {
	e.closeOnce.Do(func() { e.closeErr = e.tearDown(ctx) })
	return e.closeErr
}

func (e *Env) tearDown(ctx context.Context) error {
	s := e.settings
	var failures []string
	e.mu.Lock()
	tunnels := make([]*quickTunnel, len(s.expose))
	for i, entry := range s.expose {
		tunnels[i] = e.tunnels[entry.name]
	}
	e.mu.Unlock()
	tunnelErrs := make([]error, len(tunnels))
	var closing sync.WaitGroup
	for i, tunnel := range tunnels {
		if tunnel == nil {
			continue
		}
		closing.Add(1)
		go func() {
			defer closing.Done()
			tunnelErrs[i] = tunnel.close()
		}()
	}
	closing.Wait()
	for i, err := range tunnelErrs {
		if err != nil {
			failures = append(failures, fmt.Sprintf("the quick tunnel for %s: %v", s.expose[i].name, err))
		}
	}
	if s.stop != "" && (e.started != nil || s.start == "") {
		stop, err := e.run("stop", s.stop, false)
		if err == nil {
			var code int
			code, err = stop.finish(ctx, s.stopTimeout)
			if err == nil && code != 0 {
				failures = append(failures, "the stop command "+describeOutcome(code, s.stopTimeout))
			}
		}
		if err != nil {
			var sdkErr *Error
			if errors.As(err, &sdkErr) {
				err = errors.New(sdkErr.Message)
			}
			failures = append(failures, fmt.Sprintf("the stop command: %v", err))
		}
	}
	if e.started != nil {
		if err := stopProcessGroup(e.started.cmd.Process.Pid, startGroupGrace, "the start command"); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) > 0 {
		return failure(ErrCleanupFailed, "Environment cleanup failed: "+strings.Join(failures, "; ")+". Check the runner for leftover processes before reusing it.")
	}
	e.log("Environment closed.")
	return nil
}
