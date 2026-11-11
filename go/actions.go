package verify

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Location is where an exact action acts: a Point in device units, or an Element that Revyl's grounding
// model finds on the current screen.
type Location interface{ location() }

// Point is a position in device units: iOS points, Android and Web pixels, from the top-left corner.
type Point struct{ X, Y int }

// Element describes an element by its visible text or look, such as "Login button".
type Element string

func (Point) location()   {}
func (Element) location() {}

// Size is a screen size in device units.
type Size struct{ Width, Height int }

// SwipeDirection is the way the finger moves: SwipeUp scrolls content down.
type SwipeDirection string

const (
	SwipeUp    SwipeDirection = "up"
	SwipeDown  SwipeDirection = "down"
	SwipeLeft  SwipeDirection = "left"
	SwipeRight SwipeDirection = "right"
)

// Key is a key PressKey can press on the focused field.
type Key string

const (
	KeyEnter     Key = "enter"
	KeyBackspace Key = "backspace"
)

// TypeOptions configures Type.
type TypeOptions struct {
	// Clear empties the field before typing. Defaults to true.
	Clear *bool
}

// SwipeOptions configures Swipe.
type SwipeOptions struct {
	// From is where the swipe starts. Defaults to the screen's center.
	From Location
}

func validDirection(direction SwipeDirection) bool {
	return direction == SwipeUp || direction == SwipeDown || direction == SwipeLeft || direction == SwipeRight
}

func checkLocation(at Location) (Location, error) {
	switch at := at.(type) {
	case Element:
		target := strings.TrimSpace(string(at))
		if target == "" || textLength(string(at)) > 500 {
			return nil, failure(ErrInvalidArgument, "An Element is a description of 1 to 500 characters.")
		}
		return Element(target), nil
	case Point:
		if at.X >= 0 && at.Y >= 0 {
			return at, nil
		}
	}
	return nil, failure(ErrInvalidArgument, "A location is a Point in non-negative whole device units, or an Element description.")
}

// Tap taps a point, or an element Revyl locates from a description, and returns the point tapped.
func (s *Session) Tap(ctx context.Context, at Location) (Point, error) {
	if s.platform.computer() {
		return Point{}, s.computerAgentUnavailable("Tap")
	}
	at, err := checkLocation(at)
	if err != nil {
		return Point{}, err
	}
	point, err := s.perform(ctx, deviceAction{kind: "tap", at: at}, "")
	if err != nil {
		return Point{}, err
	}
	return *point, nil
}

// Type taps a text field and types into it, clearing it first unless TypeOptions.Clear is false. It returns the point tapped.
func (s *Session) Type(ctx context.Context, at Location, text string, options ...TypeOptions) (Point, error) {
	if s.platform.computer() {
		return Point{}, s.computerAgentUnavailable("Type")
	}
	if len(options) > 1 {
		return Point{}, failure(ErrInvalidArgument, "Type accepts at most one options value.")
	}
	if textLength(text) > 16384 {
		return Point{}, failure(ErrInvalidArgument, "Type takes text of at most 16384 characters.")
	}
	at, err := checkLocation(at)
	if err != nil {
		return Point{}, err
	}
	clearFirst := len(options) == 0 || options[0].Clear == nil || *options[0].Clear
	point, err := s.perform(ctx, deviceAction{kind: "type", at: at, text: text, clear: clearFirst}, "")
	if err != nil {
		return Point{}, err
	}
	return *point, nil
}

// Swipe swipes from a location or the screen's center. SwipeUp moves the finger up, which scrolls content down.
func (s *Session) Swipe(ctx context.Context, direction SwipeDirection, options ...SwipeOptions) error {
	if s.platform.computer() {
		return s.computerAgentUnavailable("Swipe")
	}
	if len(options) > 1 {
		return failure(ErrInvalidArgument, "Swipe accepts at most one options value.")
	}
	if !validDirection(direction) {
		return failure(ErrInvalidArgument, "Swipe takes SwipeUp, SwipeDown, SwipeLeft or SwipeRight.")
	}
	action := deviceAction{kind: "swipe", direction: direction}
	if len(options) == 1 && options[0].From != nil {
		from, err := checkLocation(options[0].From)
		if err != nil {
			return err
		}
		action.at = from
	}
	_, err := s.perform(ctx, action, "")
	return err
}

// PressKey presses KeyEnter or KeyBackspace on the focused field.
func (s *Session) PressKey(ctx context.Context, key Key) error {
	if s.platform.computer() {
		return s.computerAgentUnavailable("PressKey")
	}
	if key != KeyEnter && key != KeyBackspace {
		return failure(ErrInvalidArgument, "PressKey takes KeyEnter or KeyBackspace.")
	}
	_, err := s.perform(ctx, deviceAction{kind: "key", key: key}, "")
	return err
}

// Back goes back: browser history on Web, the back button on Android. iOS has no back button.
func (s *Session) Back(ctx context.Context) error {
	if s.platform.computer() {
		return s.computerAgentUnavailable("Back")
	}
	_, err := s.perform(ctx, deviceAction{kind: "back"}, "")
	return err
}

// OpenURL opens a URL or deep link on a device, or loads an http(s) URL in a browser.
func (s *Session) OpenURL(ctx context.Context, rawURL string) error {
	if s.platform.computer() {
		return s.computerAgentUnavailable("OpenURL")
	}
	if length := textLength(rawURL); length == 0 || length > 8192 {
		return failure(ErrInvalidArgument, "OpenURL takes a URL of 1 to 8192 characters.")
	}
	if lower := strings.ToLower(rawURL); s.platform == Web && !strings.HasPrefix(lower, "http:") && !strings.HasPrefix(lower, "https:") {
		return failure(ErrInvalidArgument, "On web, OpenURL takes an http(s) URL; deep links such as myapp://orders/42 open only on iOS and Android.")
	}
	_, err := s.perform(ctx, deviceAction{kind: "open_url", url: rawURL}, "")
	return err
}

var bundleIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,255}$`)

// LaunchApp launches an installed app by bundle ID or package name. Devices only.
func (s *Session) LaunchApp(ctx context.Context, bundleID string) error {
	if s.platform.computer() {
		return s.computerAgentUnavailable("LaunchApp")
	}
	if s.platform == Web {
		return failure(ErrNotAvailableOnPlatform, "LaunchApp is available only on iOS and Android sessions; on web, use OpenURL or Navigate.")
	}
	if !bundleIDPattern.MatchString(bundleID) {
		return failure(ErrInvalidArgument, "LaunchApp takes a bundle ID or package name.")
	}
	return s.act(ctx, "launch", map[string]any{"bundle_id": bundleID})
}

// Locate asks Revyl's grounding model where an element is on the current screen, in device units, without acting.
func (s *Session) Locate(ctx context.Context, target string) (Point, error) {
	if s.platform.computer() {
		return Point{}, s.computerAgentUnavailable("Locate")
	}
	at, err := checkLocation(Element(target))
	if err != nil {
		return Point{}, err
	}
	point, _, err := s.resolve(ctx, at, "")
	return point, err
}

// ScreenSize returns the screen size in device units: iOS points, Android and Web pixels.
func (s *Session) ScreenSize(ctx context.Context) (Size, error) {
	if s.platform.computer() {
		return Size{}, s.computerAgentUnavailable("ScreenSize")
	}
	return s.readScreenSize(ctx)
}

func (s *Session) readScreenSize(ctx context.Context) (Size, error) {
	s.mu.Lock()
	size := s.size
	s.mu.Unlock()
	if size != nil {
		return *size, nil
	}
	found := Size{}
	if s.platform != Web {
		r, err := s.worker(ctx, http.MethodGet, "health", nil, true, 30*time.Second)
		if err != nil {
			return Size{}, err
		}
		var health struct {
			Width  float64 `json:"screen_width"`
			Height float64 `json:"screen_height"`
		}
		if err := decode(r, &health); err != nil {
			return Size{}, err
		}
		if health.Width > 0 && health.Height > 0 && health.Width == math.Trunc(health.Width) && health.Height == math.Trunc(health.Height) {
			found = Size{Width: int(health.Width), Height: int(health.Height)}
		}
	}
	if found.Width == 0 {
		shot, err := s.capture(ctx)
		if err != nil {
			return Size{}, err
		}
		found = Size{Width: int(binary.BigEndian.Uint32(shot.png[16:20])), Height: int(binary.BigEndian.Uint32(shot.png[20:24]))}
	}
	s.mu.Lock()
	s.size = &found
	s.mu.Unlock()
	return found, nil
}

func (s *Session) capture(ctx context.Context) (screen, error) {
	r, err := s.worker(ctx, http.MethodGet, "screenshot", nil, true, 30*time.Second)
	if err != nil {
		return screen{}, err
	}
	if !validPNG(r.body) {
		return screen{}, failure(ErrActionFailed, "Revyl returned a screenshot that is not a PNG image.")
	}
	shot := screen{png: r.body}
	if s.platform == Web {
		shot.token = r.screenToken
	}
	return shot, nil
}

func (s *Session) perform(ctx context.Context, action deviceAction, screenToken string) (*Point, error) {
	switch action.kind {
	case "tap":
		if target, ok := action.at.(Element); ok && s.platform != Web {
			r, err := s.post(ctx, "tap_target", s.withSession(map[string]any{"target": string(target)}))
			if err != nil {
				return nil, err
			}
			var result struct {
				Success *bool    `json:"success"`
				Found   *bool    `json:"found"`
				X       *float64 `json:"x"`
				Y       *float64 `json:"y"`
				Error   *string  `json:"error"`
			}
			if err := decode(r, &result); err != nil {
				return nil, err
			}
			if result.Found != nil && !*result.Found {
				return nil, failure(ErrActionFailed, "Revyl could not find \""+string(target)+"\" on the screen.")
			}
			if result.Success == nil || !*result.Success || result.X == nil || result.Y == nil {
				return nil, failure(ErrActionFailed, "tap failed: "+orNoReason(result.Error))
			}
			return &Point{X: round(*result.X), Y: round(*result.Y)}, nil
		}
		point, token, err := s.resolve(ctx, action.at, screenToken)
		if err != nil {
			return nil, err
		}
		return &point, s.act(ctx, "tap", pointBody(point, token, action.at))
	case "type":
		point, token, err := s.resolve(ctx, action.at, screenToken)
		if err != nil {
			return nil, err
		}
		body := pointBody(point, token, action.at)
		body["text"], body["clear_first"] = action.text, action.clear
		return &point, s.act(ctx, "input", body)
	case "swipe":
		var point Point
		var token string
		var err error
		if action.at != nil {
			point, token, err = s.resolve(ctx, action.at, screenToken)
		} else {
			var size Size
			size, err = s.readScreenSize(ctx)
			point = Point{X: size.Width / 2, Y: size.Height / 2}
		}
		if err != nil {
			return nil, err
		}
		body := pointBody(point, token, action.at)
		direction := action.direction
		if s.platform == Web {
			direction = map[SwipeDirection]SwipeDirection{SwipeUp: SwipeDown, SwipeDown: SwipeUp, SwipeLeft: SwipeRight, SwipeRight: SwipeLeft}[direction]
		}
		body["direction"], body["duration_ms"] = string(direction), 500
		return nil, s.act(ctx, "swipe", body)
	case "key":
		key := strings.ToUpper(string(action.key))
		if s.platform == Web {
			key = map[Key]string{KeyEnter: "Enter", KeyBackspace: "Backspace"}[action.key]
		}
		return nil, s.act(ctx, "key", map[string]any{"key": key})
	case "back":
		if s.platform == IOS {
			return nil, failure(ErrNotAvailableOnPlatform, "Back is not available on iOS; tap the on-screen back control.")
		}
		return nil, s.act(ctx, "back", map[string]any{})
	}
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	if s.platform == Web {
		return nil, s.uncertain(ctx, "open_url", s.Navigate(ctx, action.url))
	}
	return nil, s.act(ctx, "open_url", map[string]any{"url": action.url})
}

func (s *Session) resolve(ctx context.Context, at Location, screenToken string) (Point, string, error) {
	if point, ok := at.(Point); ok {
		return point, screenToken, nil
	}
	target := string(at.(Element))
	body := s.withSession(map[string]any{"target": target})
	if screenToken != "" {
		body["screen_token"] = screenToken
	}
	r, err := s.post(ctx, "resolve_target", body)
	if err != nil {
		return Point{}, "", err
	}
	var result struct {
		Found       *bool    `json:"found"`
		X           *float64 `json:"x"`
		Y           *float64 `json:"y"`
		Error       *string  `json:"error"`
		ScreenToken *string  `json:"screen_token"`
	}
	if err := decode(r, &result); err != nil {
		return Point{}, "", err
	}
	if result.Found == nil || !*result.Found || result.X == nil || result.Y == nil {
		detail := ""
		if result.Error != nil && *result.Error != "" && s.platform != Web {
			detail = ": " + *result.Error
		}
		return Point{}, "", failure(ErrActionFailed, "Revyl could not find \""+target+"\" on the screen"+detail+".")
	}
	token := ""
	if result.ScreenToken != nil {
		token = *result.ScreenToken
	}
	return Point{X: round(*result.X), Y: round(*result.Y)}, token, nil
}

func (s *Session) act(ctx context.Context, action string, body map[string]any) error {
	r, err := s.post(ctx, action, body)
	if err != nil {
		return err
	}
	var result struct {
		Success *bool   `json:"success"`
		Error   *string `json:"error"`
	}
	if err := decode(r, &result); err != nil {
		return err
	}
	if result.Success == nil || !*result.Success {
		return failure(ErrActionFailed, fmt.Sprintf("%s failed on the %s session: %s. See %s", action, s.platform, orNoReason(result.Error), s.viewer))
	}
	return nil
}

// post sends a device action once. A mutating action cut off by the caller's deadline may have been applied,
// so it reports ACTION_UNCERTAIN rather than a timeout.
func (s *Session) post(ctx context.Context, action string, body map[string]any) (response, error) {
	if ctx.Err() != nil {
		return response{}, contextError(ctx)
	}
	r, err := s.worker(ctx, http.MethodPost, action, body, false, 30*time.Second)
	if action == "resolve_target" {
		return r, err
	}
	return r, s.uncertain(ctx, action, err)
}

func (s *Session) uncertain(ctx context.Context, action string, err error) error {
	if err != nil && ctx.Err() != nil && errors.Is(err, ErrTimeout) {
		return &Error{Code: ErrActionUncertain, Message: "The deadline passed while " + action + " was in flight, so it may have been applied. Verify did not repeat it. See " + s.viewer, Cause: err}
	}
	return err
}

func (s *Session) withSession(body map[string]any) map[string]any {
	if s.id != "" {
		body["session_id"] = s.id
	}
	return body
}

func pointBody(point Point, screenToken string, at Location) map[string]any {
	body := map[string]any{"x": point.X, "y": point.Y}
	if screenToken != "" {
		body["screen_token"] = screenToken
	}
	if target, ok := at.(Element); ok {
		body["target"] = string(target)
	}
	return body
}

func orNoReason(reason *string) string {
	if reason == nil {
		return "no reason given"
	}
	return *reason
}

func round(value float64) int { return int(math.Floor(value + 0.5)) }
