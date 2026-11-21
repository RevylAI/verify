package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"
)

// CDPEndpoint is a Chrome DevTools Protocol browser endpoint for a web session, from CDP. URL is a credential: it works
// for one connection and expires at ExpiresAt, 60 seconds after CDP returned it. Don't log it or store it; String and
// GoString leave it out.
type CDPEndpoint struct {
	// URL is the CDP browser websocket URL, for chromedp.NewRemoteAllocator(ctx, URL, chromedp.NoModifyURL).
	URL string
	// ExpiresAt is when URL stops accepting a connection.
	ExpiresAt time.Time
}

func (e CDPEndpoint) String() string {
	return "CDPEndpoint{URL: [redacted], ExpiresAt: " + e.ExpiresAt.Format(time.RFC3339) + "}"
}

func (e CDPEndpoint) GoString() string { return e.String() }

const cdpWebOnly = "CDP is available only on web sessions. On iOS and Android, use Instruction, Validation, Screenshot and exact actions such as Tap; a Mac computer has no browser CDP endpoint, so use Exec and Screenshot."

var cdpURLPattern = regexp.MustCompile(`(?i)^wss?://\S+$`)

// CDP returns a Chrome DevTools Protocol endpoint for this web session's browser, to attach chromedp, Playwright or
// Puppeteer while Instruction and Validation keep working. Each connection needs a fresh URL: it works once and expires
// after 60 seconds. Web only.
func (s *Session) CDP(ctx context.Context) (CDPEndpoint, error) {
	if s.platform != Web {
		return CDPEndpoint{}, failure(ErrNotAvailableOnPlatform, cdpWebOnly)
	}
	ctx, cancel := context.WithTimeout(ctx, 95*time.Second)
	defer cancel()
	r, err := s.worker(ctx, http.MethodPost, "cdp", map[string]any{}, true, 30*time.Second)
	if err != nil {
		var refusal struct {
			Error  string `json:"error"`
			Detail string `json:"detail"`
		}
		_ = json.Unmarshal(r.body, &refusal)
		switch {
		case r.status == 400 && refusal.Error == "not_available_on_platform":
			return CDPEndpoint{}, &Error{Code: ErrNotAvailableOnPlatform, Reason: ReasonNotAvailableOnPlatform, HTTPStatus: 400, Message: "Revyl does not offer CDP on this session (not_available_on_platform). Use Instruction, Validation and the exact actions instead. See " + s.viewer}
		case r.status == 404 && refusal.Detail != "Session not found":
			return CDPEndpoint{}, &Error{Code: ErrNotAvailableOnPlatform, HTTPStatus: 404, Message: fmt.Sprintf("The Revyl backend at %s does not offer CDP yet, so CDP has no endpoint to return. Use Instruction, Validation and the exact actions until it does.", s.client.base)}
		case r.status == 503:
			return CDPEndpoint{}, responseFailure(r, ErrAPI, "Revyl could not hand out a CDP endpoint just then (HTTP 503). It is safe to call CDP again. See "+s.viewer)
		}
		return CDPEndpoint{}, err
	}
	var endpoint struct {
		URL       string    `json:"url"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if json.Unmarshal(r.body, &endpoint) != nil || !cdpURLPattern.MatchString(endpoint.URL) || endpoint.ExpiresAt.IsZero() {
		return CDPEndpoint{}, failure(ErrAPI, "Revyl returned an invalid CDP endpoint response.")
	}
	return CDPEndpoint{URL: endpoint.URL, ExpiresAt: endpoint.ExpiresAt}, nil
}
