package verify

import (
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

type Platform string

const (
	Web     Platform = "web"
	IOS     Platform = "ios"
	Android Platform = "android"
)

type Viewport struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"device_scale_factor,omitempty"`
}

type SignIn struct {
	Path    string `json:"path"`
	Secret  string `json:"secret_name"`
	Persona string `json:"persona,omitempty"`
}

type Target struct {
	Platform           Platform
	AppID              string
	BundleID           string
	URL                string
	BuildID            string
	ArtifactURL        string
	Branch             string
	DeviceModel        string
	OSVersion          string
	StartTimeout       time.Duration
	IdleTimeoutSeconds int
	Viewport           *Viewport
	SignIn             *SignIn
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var webPattern = regexp.MustCompile(`^https://[^/?#@\s]+(/[^?#\s]*)?$`)
var signInPathPattern = regexp.MustCompile(`^/[^?#\\\s]{0,511}$`)
var personaPattern = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

func textLength(s string) int { return len(utf16.Encode([]rune(s))) }

func (t *Target) validate() error {
	bad := func(message string) error { return failure(ErrInvalidArgument, message) }
	if t.Platform == "mac" || t.Platform == "linux" {
		return failure(ErrNotAvailableOnPlatform, "Go Verify supports web, iOS, and Android only.")
	}
	if t.Platform != Web && t.Platform != IOS && t.Platform != Android {
		return bad("Platform must be web, ios, or android.")
	}
	if t.StartTimeout == 0 {
		t.StartTimeout = 10 * time.Minute
	}
	if t.StartTimeout < 10*time.Second || t.StartTimeout > 30*time.Minute {
		return bad("StartTimeout must be between 10 seconds and 30 minutes.")
	}
	if t.IdleTimeoutSeconds == 0 {
		t.IdleTimeoutSeconds = 600
	}
	if t.IdleTimeoutSeconds < 60 || t.IdleTimeoutSeconds > 3600 {
		return bad("IdleTimeoutSeconds must be between 60 and 3600.")
	}
	for _, id := range []string{t.AppID, t.BuildID} {
		if id != "" && !uuidPattern.MatchString(id) {
			return bad("AppID and BuildID must be Revyl UUIDs.")
		}
	}
	if t.Platform == Web {
		if t.AppID == "" || t.BundleID != "" || t.ArtifactURL != "" || t.DeviceModel != "" || t.OSVersion != "" {
			return bad("Web needs AppID and does not accept mobile app or device options.")
		}
		if t.URL != "" {
			parsed, err := url.Parse(t.URL)
			if err != nil || parsed.Host == "" || !webPattern.MatchString(t.URL) || textLength(t.URL) > 2048 {
				return bad("URL must be public HTTPS without credentials, query, or fragment.")
			}
		}
		if t.BuildID != "" && (t.URL != "" || t.Branch != "") {
			return bad("BuildID cannot be combined with URL or Branch.")
		}
		if t.Branch != "" && (strings.TrimSpace(t.Branch) == "" || textLength(t.Branch) > 255) {
			return bad("Branch must be non-empty and at most 255 characters.")
		}
		if v := t.Viewport; v != nil {
			if v.Width < 320 || v.Width > 3840 || v.Height < 240 || v.Height > 2160 || (v.DeviceScaleFactor != 0 && !(v.DeviceScaleFactor >= 1 && v.DeviceScaleFactor <= 3)) {
				return bad("Viewport dimensions must be 320–3840 by 240–2160, with scale 1–3 when set.")
			}
		}
		if s := t.SignIn; s != nil {
			if !signInPathPattern.MatchString(s.Path) || strings.HasPrefix(s.Path, "//") || strings.TrimSpace(s.Secret) == "" || (s.Persona != "" && !personaPattern.MatchString(s.Persona)) {
				return bad("SignIn needs a local path, a secret name, and an optional [a-z0-9_-] persona of at most 32 characters.")
			}
		}
		return nil
	}
	if t.URL != "" || t.Branch != "" || t.Viewport != nil || t.SignIn != nil {
		return bad("URL, Branch, Viewport, and SignIn apply only to web targets.")
	}
	sources := 0
	for _, source := range []string{t.AppID, t.BuildID, t.ArtifactURL, t.BundleID} {
		if source != "" {
			sources++
		}
	}
	if sources != 1 {
		return bad("Mobile needs exactly one of AppID, BuildID, ArtifactURL, or BundleID.")
	}
	if t.ArtifactURL != "" && !strings.HasPrefix(t.ArtifactURL, "https://") {
		return bad("ArtifactURL must use HTTPS.")
	}
	for _, item := range []struct {
		value string
		limit int
	}{{t.BundleID, 255}, {t.DeviceModel, 128}, {t.OSVersion, 64}} {
		if item.value != "" && (strings.TrimSpace(item.value) == "" || textLength(item.value) > item.limit) {
			return bad("Mobile identifiers must be non-empty and within their length limits.")
		}
	}
	return nil
}
