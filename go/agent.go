package verify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
)

// ModelTurn is one model turn of a step run on your model.
type ModelTurn struct {
	// Action is the action the model chose, as text, such as `tap "General"` or "verdict true".
	Action string
	// OK reports whether the action ran; a failed action goes back to the model on its next turn.
	OK             bool
	ModelDuration  time.Duration
	ActionDuration time.Duration
	InputTokens    int
	OutputTokens   int
}

// ModelRun is how a step ran on your model instead of Revyl's agent.
type ModelRun struct {
	// ID is the model's name, such as "anthropic/claude-sonnet-5-5".
	ID           string
	Grounding    Grounding
	Turns        []ModelTurn
	InputTokens  int
	OutputTokens int
}

type deviceAction struct {
	kind       string
	at         Location
	to         Location
	text       string
	clear      bool
	direction  SwipeDirection
	key        Key
	modifiers  []KeyModifier
	durationMs int
	url        string
}

type screen struct {
	png   []byte
	token string
}

// controls is what the agent loop needs from a session.
type controls interface {
	capture(ctx context.Context) (screen, error)
	readScreenSize(ctx context.Context) (Size, error)
	perform(ctx context.Context, action deviceAction, screenToken string) (*Point, error)
}

type localResult struct {
	passed bool
	reason string
	run    *ModelRun
}

const (
	validationAttempts = 3
	noToolLimit        = 3
)

var abortingCodes = map[Code]bool{ErrSessionEnded: true, ErrSessionBusy: true, ErrAuthRejected: true, ErrEdgeBlocked: true, ErrModelError: true, ErrTimeout: true, ErrAPI: true, ErrActionUncertain: true}

// runLocalStep runs one instruction or validation through the agent's model. ctx carries the step deadline.
func runLocalStep(ctx context.Context, kind, task string, a *agent, platform Platform, c controls, log func(string)) (localResult, error) {
	name := a.model.Name()
	run := &ModelRun{ID: name, Grounding: a.grounding}
	var history []string
	size, err := c.readScreenSize(ctx)
	if err != nil {
		return localResult{}, err
	}
	tools, turns, system := []ModelTool{verdictTool}, validationAttempts, validationPrompt(platform)
	if kind == "instruction" {
		tools, turns, system = instructionTools(platform, a.grounding), a.maxTurns, instructionPrompt(platform, a.grounding)
	}
	withoutTool := 0
	for turn := 1; turn <= turns; turn++ {
		if ctx.Err() != nil {
			return localResult{}, contextError(ctx)
		}
		shot, err := c.capture(ctx)
		if err != nil {
			return localResult{}, err
		}
		image, err := fitPNG(shot.png, a.maxImageSide)
		if err != nil {
			return localResult{}, err
		}
		modelStarted := time.Now()
		modelCtx, cancel := context.WithTimeout(ctx, a.modelTimeout)
		reply, err := a.model.Complete(modelCtx, ModelRequest{System: system, Text: turnText(kind, task, image, history), Image: image, Tools: tools})
		cancel()
		if err != nil {
			return localResult{}, err
		}
		run.Turns = append(run.Turns, ModelTurn{Action: "no tool call", ModelDuration: time.Since(modelStarted), InputTokens: reply.Usage.InputTokens, OutputTokens: reply.Usage.OutputTokens})
		record := &run.Turns[len(run.Turns)-1]
		run.InputTokens += record.InputTokens
		run.OutputTokens += record.OutputTokens
		modelMs := record.ModelDuration.Milliseconds()
		call := reply.ToolCall
		if reply.Truncated {
			where := "before it called a tool"
			if call != nil {
				where = "in the middle of a tool call, so Verify did not use it"
			}
			return localResult{}, failure(ErrModelError, name+"'s reply was cut off at its output token cap "+where+". Pass the model to LocalAgent through an adapter with a higher MaxTokens, such as Anthropic(AnthropicOptions{Model: model, MaxTokens: 8192}) or OpenAICompatible(OpenAICompatibleOptions{Model: model, BaseURL: baseURL, MaxTokens: 8192}).")
		}
		if call == nil {
			withoutTool++
			if withoutTool == noToolLimit {
				return localResult{}, failure(ErrModelError, fmt.Sprintf("%s answered %d times in a row without calling a tool. Pick a model that supports tool calls.", name, noToolLimit))
			}
			history = append(history, fmt.Sprintf("%d. You answered without calling a tool. Call exactly one tool.", turn))
			log(fmt.Sprintf("  · turn %d: no tool call (%d ms)", turn, modelMs))
			continue
		}
		withoutTool = 0
		offered := make([]string, len(tools))
		for i, tool := range tools {
			offered[i] = tool.Name
		}
		if !slices.Contains(offered, call.Name) {
			record.Action = clip(call.Name, 40)
			history = append(history, fmt.Sprintf("%d. %s: failed: not one of the offered tools (%s).", turn, record.Action, strings.Join(offered, ", ")))
			log(fmt.Sprintf("  · turn %d: %s is not an offered tool (%d ms)", turn, record.Action, modelMs))
			continue
		}
		if call.Name == "done" || call.Name == "verdict" {
			flag := "success"
			if call.Name == "verdict" {
				flag = "passed"
			}
			passed := call.Arguments[flag] == true
			reason, _ := call.Arguments["reason"].(string)
			record.Action = call.Name + " " + strconv.FormatBool(passed)
			record.OK = true
			log(fmt.Sprintf("  · turn %d: %s (%d ms)", turn, record.Action, modelMs))
			return localResult{passed: passed, reason: clip(reason, 1000), run: run}, nil
		}
		actionStarted := time.Now()
		action, err := toAction(call, platform, a.grounding, image, size)
		var at *Point
		if err == nil {
			record.Action = describe(action)
			at, err = c.perform(ctx, action, shot.token)
		}
		if err == nil {
			record.OK = true
			where := ""
			if at != nil {
				where = fmt.Sprintf(" at (%d, %d)", at.X, at.Y)
			}
			history = append(history, fmt.Sprintf("%d. %s%s: done.", turn, record.Action, where))
		} else {
			var sdkError *Error
			if errors.As(err, &sdkError) && abortingCodes[sdkError.Code] {
				return localResult{}, err
			}
			if record.Action == "no tool call" {
				record.Action = call.Name
			}
			message := err.Error()
			if sdkError != nil {
				message = sdkError.Message
			}
			history = append(history, fmt.Sprintf("%d. %s: failed: %s", turn, record.Action, clip(message, 300)))
		}
		record.ActionDuration = time.Since(actionStarted)
		failed := ""
		if !record.OK {
			failed = " (failed)"
		}
		log(fmt.Sprintf("  · turn %d: %s%s (model %d ms, action %d ms)", turn, record.Action, failed, modelMs, record.ActionDuration.Milliseconds()))
		settle := time.Second
		if platform == Web {
			settle = 500 * time.Millisecond
		}
		if err := pause(ctx, settle); err != nil {
			return localResult{}, err
		}
	}
	if kind == "validation" {
		return localResult{}, failure(ErrStepFailed, fmt.Sprintf("%s gave no verdict in %d attempts.", name, turns))
	}
	return localResult{reason: fmt.Sprintf("%s did not finish within %d turns.", name, turns), run: run}, nil
}

func toAction(call *ModelToolCall, platform Platform, grounding Grounding, image ModelImage, size Size) (deviceAction, error) {
	args := call.Arguments
	bad := func(message string) (deviceAction, error) {
		return deviceAction{}, failure(ErrInvalidArgument, message)
	}
	location := func(required bool, prefix string) (Location, error) {
		if grounding == GroundingRevyl {
			if target, ok := args[prefix+"target"].(string); ok && strings.TrimSpace(target) != "" {
				return Element(clip(strings.TrimSpace(target), 500)), nil
			}
			if required {
				return nil, failure(ErrInvalidArgument, prefix+"target is required: describe the element by its visible text or appearance.")
			}
			return nil, nil
		}
		x, xOK := number(args[prefix+"x"])
		y, yOK := number(args[prefix+"y"])
		if !xOK || !yOK {
			if required {
				return nil, failure(ErrInvalidArgument, prefix+"x and "+prefix+"y are required.")
			}
			return nil, nil
		}
		if x < 0 || y < 0 || x >= float64(image.Width) || y >= float64(image.Height) {
			return nil, failure(ErrInvalidArgument, fmt.Sprintf("(%s, %s) is outside the %dx%d screenshot.", formatNumber(x), formatNumber(y), image.Width, image.Height))
		}
		return Point{X: int(math.Floor(x*float64(size.Width)/float64(image.Width) + 0.5)), Y: int(math.Floor(y*float64(size.Height)/float64(image.Height) + 0.5))}, nil
	}
	switch call.Name {
	case "tap", "double_tap", "long_press":
		at, err := location(true, "")
		return deviceAction{kind: call.Name, at: at}, err
	case "type":
		text, ok := args["text"].(string)
		if !ok {
			return bad("text is required.")
		}
		at, err := location(true, "")
		return deviceAction{kind: "type", at: at, text: text, clear: args["clear"] != false}, err
	case "type_focused":
		if platform != Web {
			return deviceAction{}, failure(ErrNotAvailableOnPlatform, "type_focused is available only in a web browser; use type, which taps the field first.")
		}
		text, ok := args["text"].(string)
		if !ok {
			return bad("text is required.")
		}
		return deviceAction{kind: "type_focused", text: text, clear: args["clear"] != false}, nil
	case "drag":
		from, err := location(true, "from_")
		if err != nil {
			return deviceAction{}, err
		}
		to, err := location(true, "to_")
		return deviceAction{kind: "drag", at: from, to: to}, err
	case "swipe":
		direction, _ := args["direction"].(string)
		if !validDirection(SwipeDirection(direction)) {
			return bad("direction must be up, down, left or right.")
		}
		from, err := location(false, "")
		return deviceAction{kind: "swipe", direction: SwipeDirection(direction), at: from}, err
	case "press_key":
		if platform != Web {
			if args["key"] != "enter" && args["key"] != "backspace" {
				return bad("key must be enter or backspace.")
			}
			return deviceAction{kind: "key", key: Key(args["key"].(string))}, nil
		}
		var modifiers []KeyModifier
		switch raw := args["modifiers"].(type) {
		case nil:
		case []any:
			for _, value := range raw {
				modifier, ok := value.(string)
				if !ok {
					return bad(webKeyMessage)
				}
				modifiers = append(modifiers, KeyModifier(modifier))
			}
		default:
			return bad(webKeyMessage)
		}
		key, _ := args["key"].(string)
		if checkKey(platform, Key(key), modifiers) != nil {
			return bad(webKeyMessage)
		}
		return deviceAction{kind: "key", key: Key(key), modifiers: modifiers}, nil
	case "back":
		if platform == IOS {
			return deviceAction{}, failure(ErrNotAvailableOnPlatform, "iOS has no back button; tap the on-screen back control.")
		}
		return deviceAction{kind: "back"}, nil
	case "go_home":
		if platform == Web {
			return deviceAction{}, failure(ErrNotAvailableOnPlatform, "A web browser has no home screen; use open_url to load a page.")
		}
		return deviceAction{kind: "go_home"}, nil
	case "open_url":
		url, _ := args["url"].(string)
		if url == "" {
			return bad("url is required.")
		}
		return deviceAction{kind: "open_url", url: url}, nil
	}
	return bad(call.Name + " is not a tool.")
}

func number(value any) (float64, bool) {
	switch n := value.(type) {
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case int:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

func formatNumber(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }

func describe(action deviceAction) string {
	where := func(at Location) string {
		switch at := at.(type) {
		case Element:
			return " \"" + string(at) + "\""
		case Point:
			return fmt.Sprintf(" (%d, %d)", at.X, at.Y)
		}
		return ""
	}
	quote := func(text string) string {
		if len([]rune(text)) > 40 {
			text = clip(text, 40) + "…"
		}
		var quoted bytes.Buffer
		encoder := json.NewEncoder(&quoted)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(text)
		return strings.TrimSpace(quoted.String())
	}
	switch action.kind {
	case "tap":
		return "tap" + where(action.at)
	case "double_tap":
		return "double tap" + where(action.at)
	case "long_press":
		return "long press" + where(action.at)
	case "type":
		return "type " + quote(action.text) + " into" + where(action.at)
	case "type_focused":
		return "type " + quote(action.text) + " into the focused field"
	case "swipe":
		if action.at != nil {
			return "swipe " + string(action.direction) + " from" + where(action.at)
		}
		return "swipe " + string(action.direction)
	case "drag":
		return "drag from" + where(action.at) + " to" + where(action.to)
	case "key":
		keys := make([]string, 0, len(action.modifiers)+1)
		for _, modifier := range action.modifiers {
			keys = append(keys, string(modifier))
		}
		return "press " + strings.Join(append(keys, string(action.key)), "+")
	case "back":
		return "back"
	case "go_home":
		return "home"
	}
	return "open " + action.url
}

var platformLabel = map[Platform]string{IOS: "iPhone simulator", Android: "Android emulator", Web: "web browser"}

func instructionPrompt(platform Platform, grounding Grounding) string {
	point := "To point at an element, give the pixel coordinates of its center in the screenshot, x to the right and y down from the top-left corner."
	if grounding == GroundingRevyl {
		point = "To point at an element, describe it in target by its visible text or look, for example \"General row\" or \"Search field\". Do not give coordinates."
	}
	return strings.Join([]string{
		"You operate a " + platformLabel[platform] + " to carry out a task. Every turn you see the current screenshot and the actions taken so far, and you call exactly one tool.",
		point,
		"Check the screenshot before each action: the previous action may not have done what you expected. To see content further down, swipe up.",
		"Call done with success true as soon as the screenshot shows the task is complete. Call done with success false and a reason if it cannot be done.",
	}, "\n")
}

func validationPrompt(platform Platform) string {
	return "You check whether a statement holds on the current screen of a " + platformLabel[platform] + ". Judge only what the screenshot shows, then call verdict with passed and a one-sentence reason."
}

func turnText(kind, task string, image ModelImage, history []string) string {
	lines := []string{"Statement: " + task, fmt.Sprintf("The screenshot is %dx%d pixels.", image.Width, image.Height)}
	if kind == "instruction" {
		lines[0] = "Task: " + task
		if len(history) == 0 {
			lines = append(lines, "No actions yet.")
		} else {
			lines = append(lines, "Actions so far:\n"+strings.Join(history[max(0, len(history)-30):], "\n"))
		}
	} else if len(history) > 0 {
		lines = append(lines, "Earlier attempts:\n"+strings.Join(history, "\n"))
	}
	return strings.Join(lines, "\n")
}

var verdictTool = ModelTool{Name: "verdict", Description: "Report whether the statement holds on the screen.", Parameters: json.RawMessage(`{"type":"object","properties":{"passed":{"type":"boolean"},"reason":{"type":"string"}},"required":["passed","reason"]}`)}

var webKeyMessage = "key must be one of " + webKeyNames() + ", or a lowercase letter or digit with modifiers; modifiers are up to four of ctrl, shift, alt and meta."

func webKeyNames() string {
	names := make([]string, len(webKeys))
	for i, entry := range webKeys {
		names[i] = string(entry.key)
	}
	return strings.Join(names, ", ")
}

func instructionTools(platform Platform, grounding Grounding) []ModelTool {
	at := func(prefix string) (string, string) {
		if grounding == GroundingRevyl {
			return `"` + prefix + `target":{"type":"string","description":"The element, by its visible text or look."}`, `"` + prefix + `target"`
		}
		return `"` + prefix + `x":{"type":"integer","description":"Screenshot pixel x."},"` + prefix + `y":{"type":"integer","description":"Screenshot pixel y."}`, `"` + prefix + `x","` + prefix + `y"`
	}
	properties, required := at("")
	fromProperties, fromRequired := at("from_")
	toProperties, toRequired := at("to_")
	location := json.RawMessage(`{"type":"object","properties":{` + properties + `},"required":[` + required + `]}`)
	noParameters := json.RawMessage(`{"type":"object","properties":{}}`)
	openURL := "Open a URL or deep link on the device."
	if platform == Web {
		openURL = "Load a URL in the current tab."
	}
	tools := []ModelTool{
		{Name: "tap", Description: "Tap an element.", Parameters: location},
		{Name: "double_tap", Description: "Double-tap an element.", Parameters: location},
		{Name: "long_press", Description: "Press and hold an element, for example to open a context menu.", Parameters: location},
		{Name: "type", Description: "Tap a text field and type into it. Clears the field first unless clear is false.", Parameters: json.RawMessage(`{"type":"object","properties":{` + properties + `,"text":{"type":"string"},"clear":{"type":"boolean"}},"required":[` + required + `,"text"]}`)},
	}
	if platform == Web {
		tools = append(tools, ModelTool{Name: "type_focused", Description: "Type into the field that already has focus, without tapping. Clears the field first unless clear is false.", Parameters: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"},"clear":{"type":"boolean"}},"required":["text"]}`)})
	}
	tools = append(tools,
		ModelTool{Name: "swipe", Description: "Swipe from a point, or from the screen's center. up moves the finger up, which scrolls content down.", Parameters: json.RawMessage(`{"type":"object","properties":{"direction":{"type":"string","enum":["up","down","left","right"]},` + properties + `},"required":["direction"]}`)},
		ModelTool{Name: "drag", Description: "Press an element, move it to another place and release, for example to reorder a list or move a slider.", Parameters: json.RawMessage(`{"type":"object","properties":{` + fromProperties + `,` + toProperties + `},"required":[` + fromRequired + `,` + toRequired + `]}`)},
	)
	switch platform {
	case Web:
		tools = append(tools,
			ModelTool{Name: "press_key", Description: "Press a key on the focused element, optionally with modifiers held, such as escape, tab, arrowdown, or a with ctrl.", Parameters: json.RawMessage(`{"type":"object","properties":{"key":{"type":"string","description":"One of ` + webKeyNames() + `, or a lowercase letter or digit when modifiers are given."},"modifiers":{"type":"array","items":{"type":"string","enum":["ctrl","shift","alt","meta"]}}},"required":["key"]}`)},
			ModelTool{Name: "back", Description: "Go back in browser history.", Parameters: noParameters},
		)
	case Android:
		tools = append(tools,
			ModelTool{Name: "press_key", Description: "Press a key on the focused field.", Parameters: json.RawMessage(`{"type":"object","properties":{"key":{"type":"string","enum":["enter","backspace"]}},"required":["key"]}`)},
			ModelTool{Name: "back", Description: "Press the Android back button.", Parameters: noParameters},
			ModelTool{Name: "go_home", Description: "Go to the home screen.", Parameters: noParameters},
		)
	default:
		tools = append(tools,
			ModelTool{Name: "press_key", Description: "Press a key on the focused field.", Parameters: json.RawMessage(`{"type":"object","properties":{"key":{"type":"string","enum":["enter","backspace"]}},"required":["key"]}`)},
			ModelTool{Name: "go_home", Description: "Go to the home screen.", Parameters: noParameters},
		)
	}
	return append(tools,
		ModelTool{Name: "open_url", Description: openURL, Parameters: json.RawMessage(`{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}`)},
		ModelTool{Name: "done", Description: "Finish the task.", Parameters: json.RawMessage(`{"type":"object","properties":{"success":{"type":"boolean"},"reason":{"type":"string"}},"required":["success","reason"]}`)},
	)
}
