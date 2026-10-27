package verify

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type readinessTransport func(*http.Request) (*http.Response, error)

func (transport readinessTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return transport(r)
}

func readinessPNG(t *testing.T, paint func(*image.NRGBA)) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 100, 100))
	for y := 0; y < 100; y++ {
		for x := 0; x < 100; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	if paint != nil {
		paint(img)
	}
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestNonBlankPNG(t *testing.T) {
	blank := readinessPNG(t, nil)
	for _, tc := range []struct {
		name  string
		paint func(*image.NRGBA)
		ready bool
	}{
		{name: "blank"},
		{name: "content", paint: func(img *image.NRGBA) { img.SetNRGBA(50, 50, color.NRGBA{A: 255}) }, ready: true},
		{name: "status and navigation bars", paint: func(img *image.NRGBA) {
			for x := 0; x < 100; x++ {
				img.SetNRGBA(x, 0, color.NRGBA{A: 255})
				img.SetNRGBA(x, 99, color.NRGBA{A: 255})
			}
		}},
		{name: "side edges", paint: func(img *image.NRGBA) {
			img.SetNRGBA(9, 50, color.NRGBA{A: 255})
			img.SetNRGBA(90, 50, color.NRGBA{A: 255})
		}},
		{name: "alpha ignored", paint: func(img *image.NRGBA) {
			img.SetNRGBA(50, 50, color.NRGBA{R: 255, G: 255, B: 255, A: 128})
		}},
		{name: "transparent alpha ignored", paint: func(img *image.NRGBA) {
			img.SetNRGBA(50, 50, color.NRGBA{R: 255, G: 255, B: 255})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ready, err := nonBlankPNG(readinessPNG(t, tc.paint))
			if err != nil || ready != tc.ready {
				t.Fatalf("nonBlankPNG = %v, %v; want %v", ready, err, tc.ready)
			}
		})
	}
	oversized := bytes.Clone(blank)
	binary.BigEndian.PutUint32(oversized[16:20], 4001)
	binary.BigEndian.PutUint32(oversized[20:24], 4000)
	binary.BigEndian.PutUint32(oversized[29:33], crc32.ChecksumIEEE(oversized[12:29]))
	for name, data := range map[string][]byte{
		"not PNG": []byte("not PNG"), "header only": blank[:33], "truncated": blank[:len(blank)-10],
		"pixel limit": oversized, "byte limit": make([]byte, 16*1024*1024+1),
	} {
		t.Run(name, func(t *testing.T) {
			if ready, err := nonBlankPNG(data); ready || err == nil {
				t.Fatalf("invalid PNG = %v, %v", ready, err)
			}
		})
	}
}

func readinessServer(t *testing.T, screenshot http.HandlerFunc) (OpenOptions, func() []string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("REVYL_API_KEY", "readiness-test-token")
	var mu sync.Mutex
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, r.Method+" "+r.URL.Path)
		mu.Unlock()
		var result any
		switch r.URL.Path {
		case "/api/v1/execution/start_device":
			result = map[string]string{"session_id": "screen-session", "workflow_run_id": "screen-run"}
		case "/api/v1/execution/streaming/worker-connection/screen-run":
			result = map[string]string{"status": "ready", "worker_ws_url": "wss://worker.test"}
		case "/api/v1/execution/device-proxy/screen-run/health":
			result = map[string]bool{"device_connected": true}
		case "/api/v1/execution/device-proxy/screen-run/launch":
			result = map[string]bool{"success": true}
		case "/api/v1/execution/device-proxy/screen-run/screenshot":
			screenshot(w, r)
			return
		case "/api/v1/execution/device/sessions/screen-session/stop":
			result = map[string]bool{"success": true}
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(500)
			return
		}
		_ = json.NewEncoder(w).Encode(result)
	}))
	t.Cleanup(server.Close)
	return OpenOptions{BackendURL: server.URL, AppURL: "https://viewer.test", HTTPClient: server.Client()}, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), calls...)
	}
}

func TestMobileFirstScreenAfterLaunch(t *testing.T) {
	blank := readinessPNG(t, nil)
	content := readinessPNG(t, func(img *image.NRGBA) { img.SetNRGBA(50, 50, color.NRGBA{A: 255}) })
	for _, platform := range []Platform{IOS, Android} {
		t.Run(string(platform), func(t *testing.T) {
			var shots atomic.Int32
			opt, calls := readinessServer(t, func(w http.ResponseWriter, _ *http.Request) {
				if shots.Add(1) == 1 {
					_, _ = w.Write(blank)
					return
				}
				_, _ = w.Write(content)
			})
			start := time.Now()
			s, err := Open(context.Background(), Target{Platform: platform, BundleID: "com.example.app"}, opt)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close(context.Background())
			want := []string{
				"POST /api/v1/execution/start_device",
				"GET /api/v1/execution/streaming/worker-connection/screen-run",
				"GET /api/v1/execution/device-proxy/screen-run/health",
				"POST /api/v1/execution/device-proxy/screen-run/launch",
				"GET /api/v1/execution/device-proxy/screen-run/screenshot",
				"GET /api/v1/execution/device-proxy/screen-run/screenshot",
			}
			if !reflect.DeepEqual(calls(), want) || time.Since(start) < 500*time.Millisecond {
				t.Fatalf("startup calls = %v; elapsed = %s", calls(), time.Since(start))
			}
		})
	}
}

func TestMobileFirstScreenTransientStatuses(t *testing.T) {
	content := readinessPNG(t, func(img *image.NRGBA) { img.SetNRGBA(50, 50, color.NRGBA{A: 255}) })
	var shots atomic.Int32
	opt, calls := readinessServer(t, func(w http.ResponseWriter, _ *http.Request) {
		switch shots.Add(1) {
		case 1:
			w.WriteHeader(409)
		case 2:
			w.WriteHeader(503)
		default:
			_, _ = w.Write(content)
		}
	})
	s, err := Open(context.Background(), Target{Platform: IOS, AppID: "11111111-2222-4333-8444-555555555555"}, opt)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close(context.Background())
	if shots.Load() != 3 || strings.Contains(strings.Join(calls(), " "), "/launch") {
		t.Fatalf("unexpected retry or launch: %v", calls())
	}
}

func TestMobileFirstScreenBestEffortErrors(t *testing.T) {
	blank := readinessPNG(t, nil)
	for _, status := range []int{200, 400, 401, 403, 404, 410, 429, 500, 501, 502, 504} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var shots atomic.Int32
			opt, _ := readinessServer(t, func(w http.ResponseWriter, _ *http.Request) {
				shots.Add(1)
				w.WriteHeader(status)
				_, _ = w.Write(blank[:33])
			})
			var logs []string
			opt.Log = func(line string) { logs = append(logs, line) }
			start := time.Now()
			s, err := Open(context.Background(), Target{Platform: IOS, BundleID: "com.example.app"}, opt)
			if err != nil {
				t.Fatalf("optional screenshot failed Open: %v", err)
			}
			defer s.Close(context.Background())
			if shots.Load() != 1 || time.Since(start) > 2*time.Second || len(logs) != 1 || !strings.Contains(logs[0], "skipped") {
				t.Fatalf("shots = %d, elapsed = %s, logs = %v", shots.Load(), time.Since(start), logs)
			}
		})
	}
	t.Run("transport", func(t *testing.T) {
		var shots atomic.Int32
		opt, _ := readinessServer(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected screenshot") })
		transport := opt.HTTPClient.Transport
		opt.HTTPClient.Transport = readinessTransport(func(r *http.Request) (*http.Response, error) {
			if strings.HasSuffix(r.URL.Path, "/screenshot") {
				shots.Add(1)
				return nil, io.ErrUnexpectedEOF
			}
			return transport.RoundTrip(r)
		})
		s, err := Open(context.Background(), Target{Platform: IOS, BundleID: "com.example.app"}, opt)
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close(context.Background())
		if shots.Load() != 1 {
			t.Fatalf("transport request replayed %d times", shots.Load())
		}
	})
}

func TestMobileFirstScreenBoundedExhaustion(t *testing.T) {
	blank := readinessPNG(t, nil)
	var shots atomic.Int32
	opt, _ := readinessServer(t, func(w http.ResponseWriter, _ *http.Request) {
		shots.Add(1)
		_, _ = w.Write(blank)
	})
	var logs []string
	opt.Log = func(line string) { logs = append(logs, line) }
	start := time.Now()
	s, err := Open(context.Background(), Target{Platform: IOS, BundleID: "com.example.app"}, opt)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close(context.Background())
	if elapsed := time.Since(start); elapsed < 10*time.Second || elapsed > 12*time.Second {
		t.Fatalf("wait duration = %s", elapsed)
	}
	if shots.Load() < 2 || shots.Load() > 20 || len(logs) != 1 || !strings.Contains(logs[0], "timed out") {
		t.Fatalf("shots = %d, logs = %v", shots.Load(), logs)
	}
}

func TestMobileFirstScreenCancellationCleansUp(t *testing.T) {
	blank := readinessPNG(t, nil)
	for _, inFlight := range []bool{false, true} {
		t.Run(map[bool]string{false: "between requests", true: "in flight"}[inFlight], func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			opt, calls := readinessServer(t, func(w http.ResponseWriter, r *http.Request) {
				if inFlight {
					cancel()
					<-r.Context().Done()
					return
				}
				_, _ = w.Write(blank)
				time.AfterFunc(50*time.Millisecond, cancel)
			})
			s, err := Open(ctx, Target{Platform: IOS, BundleID: "com.example.app"}, opt)
			if s != nil || !errors.Is(err, context.Canceled) || !errors.Is(err, ErrTimeout) {
				t.Fatalf("Open = %v, %v", s, err)
			}
			got := calls()
			if got[len(got)-1] != "POST /api/v1/execution/device/sessions/screen-session/stop" {
				t.Fatalf("missing cancellation cleanup: %v", got)
			}
		})
	}
	t.Run("startup deadline", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		opt, calls := readinessServer(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(blank) })
		s, err := Open(ctx, Target{Platform: IOS, BundleID: "com.example.app"}, opt)
		if s != nil || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Open = %v, %v", s, err)
		}
		got := calls()
		if got[len(got)-1] != "POST /api/v1/execution/device/sessions/screen-session/stop" {
			t.Fatalf("missing timeout cleanup: %v", got)
		}
	})
}
