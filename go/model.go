package verify

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// ModelTool is one tool offered to the model, with its arguments as a JSON Schema object.
type ModelTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// ModelImage is the current screenshot as a PNG, downscaled to the agent's MaxImageSide.
type ModelImage struct {
	PNG    []byte
	Width  int
	Height int
}

// ModelRequest is one stateless turn: the system prompt, the task and history as text, and the current screenshot.
type ModelRequest struct {
	System string
	Text   string
	Image  ModelImage
	Tools  []ModelTool
}

// ModelToolCall is the tool the model chose and its arguments.
type ModelToolCall struct {
	Name      string
	Arguments map[string]any
}

// ModelUsage counts one turn's tokens. Input includes cached input tokens.
type ModelUsage struct {
	InputTokens  int
	OutputTokens int
}

// ModelReply is the model's answer to one turn.
type ModelReply struct {
	// ToolCall is nil when the model called no tool.
	ToolCall *ModelToolCall
	Text     string
	Usage    ModelUsage
	// Truncated is true when the reply stopped at the output token cap.
	Truncated bool
}

// ModelAdapter is the only contract a model has to meet to drive a Verify session. Implement it to plug in
// any provider, a local model or an agent runtime. Each call is independent: Verify sends the full context every turn.
type ModelAdapter interface {
	// Name is shown in logs, step results and the Revyl session report, so never put a secret in it.
	Name() string
	// Complete answers one turn. ctx carries the step deadline and the agent's ModelTimeout.
	Complete(ctx context.Context, request ModelRequest) (ModelReply, error)
}

// AnthropicOptions configures Claude through Anthropic's Messages API.
type AnthropicOptions struct {
	// Model is the model name, such as "claude-sonnet-5-5".
	Model string
	// APIKey defaults to the ANTHROPIC_API_KEY environment variable. It is sent only to BaseURL.
	APIKey string
	// BaseURL defaults to the ANTHROPIC_BASE_URL environment variable, then https://api.anthropic.com.
	BaseURL string
	// MaxTokens caps output per turn, thinking included. Defaults to 4096.
	MaxTokens int
	// MaxRetries is the attempts after a rate limit, a 5xx or a network error, from 0 to 5. Defaults to 2.
	MaxRetries *int
}

// OpenAICompatibleOptions configures any server that speaks OpenAI's chat completions with tools and image input.
type OpenAICompatibleOptions struct {
	// Model is the model name, such as "gpt-5.5", "qwen-3.8-27b" or "qwen3-vl:8b".
	Model string
	// BaseURL is the API root that serves /chat/completions. Defaults to the OPENAI_BASE_URL environment
	// variable, then https://api.openai.com/v1. Ollama is http://localhost:11434/v1.
	BaseURL string
	// APIKey is sent as a bearer token only to BaseURL. It defaults to OPENAI_API_KEY when BaseURL is empty,
	// and to no key otherwise, so a key for one provider never reaches another.
	APIKey string
	// Headers are extra headers sent only to BaseURL, such as a gateway's key header. Never logged.
	Headers map[string]string
	// Provider prefixes the model in logs and reports, such as "cerebras". BaseURL itself is never reported.
	Provider string
	// MaxTokens caps output per turn, reasoning included. Defaults to 4096 for OpenAI and 2048 elsewhere.
	MaxTokens int
	// MaxRetries is the attempts after a rate limit, a 5xx or a network error, from 0 to 5. Defaults to 2.
	MaxRetries *int
}

type modelCall struct {
	endpoint  string
	host      string
	appended  string
	name      string
	model     string
	secrets   []string
	keySource string
	urlSource string
	retries   int
}

type anthropicModel struct {
	call      modelCall
	apiKey    string
	maxTokens int
}

type chatQuirks struct {
	toolChoice string
	keySource  string
}

type chatModel struct {
	call       modelCall
	apiKey     string
	headers    map[string]string
	maxTokens  int
	tokenField string
	toolChoice string
}

// Anthropic returns an adapter for Claude through Anthropic's Messages API.
func Anthropic(options AnthropicOptions) (ModelAdapter, error) {
	model := strings.TrimSpace(options.Model)
	if model == "" {
		return nil, failure(ErrInvalidArgument, "Anthropic Model must be a non-empty string.")
	}
	apiKey := strings.TrimSpace(options.APIKey)
	keySource := "the APIKey you passed"
	if options.APIKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
		keySource = "ANTHROPIC_API_KEY"
	}
	if apiKey == "" {
		return nil, failure(ErrModelKeyMissing, "Anthropic needs APIKey or ANTHROPIC_API_KEY in the environment. Create a key in the Anthropic Console.")
	}
	root, urlSource := options.BaseURL, ""
	if root == "" {
		root = "https://api.anthropic.com"
		if env := os.Getenv("ANTHROPIC_BASE_URL"); strings.TrimSpace(env) != "" {
			root, urlSource = env, "ANTHROPIC_BASE_URL"
		}
	}
	call, err := newModelCall(root, "messages", false, urlSource, "anthropic/"+model, model, options.MaxRetries)
	if err != nil {
		return nil, err
	}
	maxTokens, err := tokenCap(options.MaxTokens, 4096)
	if err != nil {
		return nil, err
	}
	call.secrets, call.keySource = []string{apiKey}, keySource
	return &anthropicModel{call: call, apiKey: apiKey, maxTokens: maxTokens}, nil
}

// OpenAICompatible returns an adapter for any server that speaks OpenAI's chat completions with tools and image
// input: OpenAI, Ollama, vLLM, OpenRouter, Cerebras and others.
func OpenAICompatible(options OpenAICompatibleOptions) (ModelAdapter, error) {
	return chatCompletions(options, chatQuirks{})
}

var headerName = regexp.MustCompile("^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$")

func chatCompletions(options OpenAICompatibleOptions, quirks chatQuirks) (ModelAdapter, error) {
	model := strings.TrimSpace(options.Model)
	if model == "" {
		return nil, failure(ErrInvalidArgument, "OpenAICompatible Model must be a non-empty string.")
	}
	openAI := options.BaseURL == ""
	root, urlSource := options.BaseURL, ""
	apiKey := strings.TrimSpace(options.APIKey)
	if openAI {
		root = "https://api.openai.com/v1"
		if env := os.Getenv("OPENAI_BASE_URL"); strings.TrimSpace(env) != "" {
			root, urlSource = env, "OPENAI_BASE_URL"
		}
		if options.APIKey == "" {
			apiKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
		}
	}
	if len(options.Headers) > 20 {
		return nil, failure(ErrInvalidArgument, "Pass at most 20 model headers.")
	}
	secrets := []string{}
	if apiKey != "" {
		secrets = append(secrets, apiKey)
	}
	for name, value := range options.Headers {
		if !headerName.MatchString(name) || len(value) > 8192 || strings.ContainsAny(value, "\r\n\x00") {
			return nil, failure(ErrInvalidArgument, "Model headers need valid names and single-line string values.")
		}
		if value != "" {
			secrets = append(secrets, value)
		}
	}
	name := model
	if options.Provider != "" {
		name = options.Provider + "/" + model
	}
	call, err := newModelCall(root, "chat/completions", true, urlSource, name, model, options.MaxRetries)
	if err != nil {
		return nil, err
	}
	defaultTokens, tokenField := 2048, "max_tokens"
	if openAI || call.host == "api.openai.com" {
		defaultTokens, tokenField = 4096, "max_completion_tokens"
	}
	maxTokens, err := tokenCap(options.MaxTokens, defaultTokens)
	if err != nil {
		return nil, err
	}
	toolChoice := quirks.toolChoice
	if toolChoice == "" {
		toolChoice = "required"
	}
	call.secrets, call.keySource = secrets, quirks.keySource
	if call.keySource == "" && options.APIKey != "" {
		call.keySource = "the APIKey you passed"
	} else if call.keySource == "" && apiKey != "" {
		call.keySource = "OPENAI_API_KEY"
	}
	return &chatModel{call: call, apiKey: apiKey, headers: options.Headers, maxTokens: maxTokens, tokenField: tokenField, toolChoice: toolChoice}, nil
}

func tokenCap(value, fallback int) (int, error) {
	if value < 0 {
		return 0, failure(ErrInvalidArgument, "MaxTokens must not be negative.")
	}
	if value == 0 {
		return fallback, nil
	}
	return value, nil
}

func (m *anthropicModel) Name() string { return m.call.name }

func (m *anthropicModel) Complete(ctx context.Context, turn ModelRequest) (ModelReply, error) {
	type tool struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"input_schema"`
	}
	tools := make([]tool, len(turn.Tools))
	for i, t := range turn.Tools {
		tools[i] = tool{t.Name, t.Description, t.Parameters}
	}
	body, err := m.call.post(ctx, map[string]any{
		"model":       m.call.model,
		"max_tokens":  m.maxTokens,
		"system":      turn.System,
		"tools":       tools,
		"tool_choice": map[string]string{"type": "any"},
		"messages": []any{map[string]any{
			"role": "user",
			"content": []any{
				map[string]any{"type": "image", "source": map[string]string{"type": "base64", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(turn.Image.PNG)}},
				map[string]any{"type": "text", "text": turn.Text},
			},
		}},
	}, map[string]string{"x-api-key": m.apiKey, "anthropic-version": "2023-06-01"})
	if err != nil {
		return ModelReply{}, err
	}
	var reply ModelReply
	content, _ := body["content"].([]any)
	var texts []string
	toolSeen := false
	for _, item := range content {
		block := record(item)
		switch block["type"] {
		case "tool_use":
			if name, ok := block["name"].(string); ok && !toolSeen {
				reply.ToolCall = &ModelToolCall{Name: name, Arguments: record(block["input"])}
			}
			toolSeen = true
		case "text":
			text, _ := block["text"].(string)
			texts = append(texts, text)
		}
	}
	reply.Text = strings.TrimSpace(strings.Join(texts, "\n"))
	usage := record(body["usage"])
	reply.Usage = ModelUsage{InputTokens: count(usage["input_tokens"]) + count(usage["cache_creation_input_tokens"]) + count(usage["cache_read_input_tokens"]), OutputTokens: count(usage["output_tokens"])}
	reply.Truncated = body["stop_reason"] == "max_tokens"
	return reply, nil
}

func (m *chatModel) Name() string { return m.call.name }

func (m *chatModel) Complete(ctx context.Context, turn ModelRequest) (ModelReply, error) {
	tools := make([]any, len(turn.Tools))
	for i, t := range turn.Tools {
		tools[i] = map[string]any{"type": "function", "function": t}
	}
	headers := map[string]string{}
	for name, value := range m.headers {
		headers[name] = value
	}
	if m.apiKey != "" {
		headers["Authorization"] = "Bearer " + m.apiKey
	}
	body, err := m.call.post(ctx, map[string]any{
		"model":       m.call.model,
		m.tokenField:  m.maxTokens,
		"tool_choice": m.toolChoice,
		"tools":       tools,
		"messages": []any{
			map[string]any{"role": "system", "content": turn.System},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": turn.Text},
				map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(turn.Image.PNG)}},
			}},
		},
	}, headers)
	if err != nil {
		return ModelReply{}, err
	}
	choices, _ := body["choices"].([]any)
	choice := map[string]any{}
	if len(choices) > 0 {
		choice = record(choices[0])
	}
	message := record(choice["message"])
	function := map[string]any{}
	if calls, _ := message["tool_calls"].([]any); len(calls) > 0 {
		function = record(record(calls[0])["function"])
	}
	var reply ModelReply
	if text, ok := message["content"].(string); ok {
		reply.Text = strings.TrimSpace(text)
	}
	if name, ok := function["name"].(string); ok {
		reply.ToolCall = &ModelToolCall{Name: name, Arguments: arguments(function["arguments"])}
	} else {
		reply.ToolCall = toolCallFromText(reply.Text)
	}
	usage := record(body["usage"])
	reply.Usage = ModelUsage{InputTokens: count(usage["prompt_tokens"]), OutputTokens: count(usage["completion_tokens"])}
	reply.Truncated = choice["finish_reason"] == "length"
	return reply, nil
}

var modelHTTP = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
	return errors.New("redirects are not followed")
}}

var retryableStatus = map[int]bool{408: true, 409: true, 429: true, 500: true, 502: true, 503: true, 504: true, 529: true}

func (c modelCall) post(ctx context.Context, payload any, headers map[string]string) (map[string]any, error) {
	where := c.name + " at " + c.host
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, failure(ErrInvalidArgument, "The model request cannot be encoded as JSON.")
	}
	timedOut := func() error {
		return &Error{Code: ErrTimeout, Message: where + " did not answer in time. Raise LocalAgent ModelTimeout for slow or local models.", Cause: ctx.Err()}
	}
	for attempt := 0; ; attempt++ {
		backoff := time.Duration(math.Pow(3, float64(attempt))) * time.Second
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(encoded))
		if err != nil {
			return nil, failure(ErrInvalidArgument, "The model request cannot be built.")
		}
		req.Header.Set("Content-Type", "application/json")
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		r, err := modelHTTP.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, timedOut()
			}
			if attempt < c.retries {
				if pause(ctx, backoff) != nil {
					return nil, timedOut()
				}
				continue
			}
			var urlError *url.Error
			if errors.As(err, &urlError) {
				err = urlError.Err
			}
			return nil, failure(ErrModelError, fmt.Sprintf("Could not reach %s: %s. Check the BaseURL and that the server is running.", where, scrub(err.Error(), c.secrets)))
		}
		data, readErr := io.ReadAll(io.LimitReader(r.Body, 16*1024*1024))
		r.Body.Close()
		if readErr != nil {
			if ctx.Err() != nil {
				return nil, timedOut()
			}
			return nil, failure(ErrModelError, "Could not read the answer from "+where+".")
		}
		if r.StatusCode >= 200 && r.StatusCode < 300 {
			var body any
			if json.Unmarshal(data, &body) != nil {
				return nil, failure(ErrModelError, where+" returned a response that is not JSON. Check that the BaseURL serves OpenAI-style chat completions.")
			}
			return record(body), nil
		}
		if retryableStatus[r.StatusCode] && attempt < c.retries {
			wait := backoff
			if seconds, err := strconv.ParseFloat(strings.TrimSpace(r.Header.Get("Retry-After")), 64); err == nil && seconds > 0 && !math.IsInf(seconds, 0) {
				wait = min(time.Duration(seconds*float64(time.Second)), 10*time.Second)
			}
			if pause(ctx, wait) != nil {
				return nil, timedOut()
			}
			continue
		}
		message := strings.TrimRightFunc(providerMessage(string(data), c.secrets), func(r rune) bool { return r == '.' || unicode.IsSpace(r) }) + "."
		text := fmt.Sprintf("%s refused the request (HTTP %d): %s", where, r.StatusCode, message)
		if step := c.nextStep(r.StatusCode, message); step != "" {
			text += " " + step
		}
		return nil, &Error{Code: ErrModelError, HTTPStatus: r.StatusCode, Message: text}
	}
}

var (
	unsupportedMessage = regexp.MustCompile(`(?i)not support|unsupported|only supported|not enabled|not allowed|cannot (accept|process|read)`)
	imageMessage       = regexp.MustCompile(`(?i)image|vision|multimodal|modalit`)
	toolMessage        = regexp.MustCompile(`(?i)tool|function`)
	unknownModel       = regexp.MustCompile(`(?i)model.*(not.?found|not exist|invalid|unknown|not a valid|no such)|(invalid|unknown|no such|not a valid).*model`)
)

func (c modelCall) nextStep(status int, message string) string {
	if status == 401 || status == 403 {
		address := ""
		if c.urlSource != "" {
			address = " (from " + c.urlSource + ")"
		}
		if c.keySource != "" {
			return c.host + address + " rejected the key from " + c.keySource + ". Check that the key is valid for that endpoint."
		}
		return c.host + address + " needs a key: pass APIKey or Headers."
	}
	if status == 429 {
		return fmt.Sprintf("Still rate limited after %d retries. Wait and rerun, run fewer sessions at once, or raise your limit with the provider.", c.retries)
	}
	unsupported := unsupportedMessage.MatchString(message)
	if unsupported && imageMessage.MatchString(message) {
		return c.model + " does not accept images. Pick a model that takes image input."
	}
	if unsupported && toolMessage.MatchString(message) {
		return c.model + " does not support tool calls. Pick a model that does."
	}
	if unknownModel.MatchString(message) {
		return "Check that '" + c.model + "' is a model name this provider serves."
	}
	if status == 404 {
		address := c.urlSource
		if address == "" {
			address = "the BaseURL"
		}
		return "Verify added " + c.appended + " to " + address + ". Check that '" + c.model + "' is a model this provider serves, and whether " + address + " should include /v1."
	}
	if status >= 500 {
		return "The provider failed; try again later."
	}
	return ""
}

func providerMessage(text string, secrets []string) string {
	var parsed any
	if json.Unmarshal([]byte(text), &parsed) == nil {
		body := record(parsed)
		message, ok := body["error"].(string)
		if !ok {
			value := record(body["error"])["message"]
			if value == nil {
				value = body["message"]
			}
			message, ok = value.(string)
		}
		if !ok {
			return "no error message"
		}
		return clip(scrub(message, secrets), 300)
	}
	plain := strings.Join(strings.Fields(text), " ")
	if plain == "" || strings.HasPrefix(plain, "<") {
		return "no error message"
	}
	return clip(scrub(plain, secrets), 300)
}

func scrub(text string, secrets []string) string {
	for _, secret := range secrets {
		if len(secret) >= 4 {
			text = strings.ReplaceAll(text, secret, "[redacted]")
		}
	}
	return text
}

func clip(text string, limit int) string {
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}

func toolCallFromText(text string) *ModelToolCall {
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return nil
	}
	var parsed any
	if json.Unmarshal([]byte(text[start:end+1]), &parsed) != nil {
		return nil
	}
	call := record(parsed)
	name := call["name"]
	if name == nil {
		name = call["tool"]
	}
	text, ok := name.(string)
	if !ok {
		return nil
	}
	args := call["arguments"]
	if args == nil {
		args = call["parameters"]
	}
	return &ModelToolCall{Name: text, Arguments: arguments(args)}
}

func arguments(value any) map[string]any {
	text, ok := value.(string)
	if !ok {
		return record(value)
	}
	var parsed any
	if json.Unmarshal([]byte(text), &parsed) != nil {
		return map[string]any{}
	}
	return record(parsed)
}

func record(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func count(value any) int {
	n, ok := value.(float64)
	if !ok || math.IsInf(n, 0) || math.IsNaN(n) || n < 0 {
		return 0
	}
	return int(n)
}

var versionedPath = regexp.MustCompile(`(?i)/v\d+[a-z0-9]*/$`)

// newModelCall builds the request URL from a base address given with or without its /v1 suffix. Anthropic's
// habit (atHostRoot false) adds v1/ unless the address already ends in a version such as /v1. OpenAI-compatible
// addresses (atHostRoot true) get v1/ only on a bare host, since other paths such as /openai/v1 are complete.
func newModelCall(root, path string, atHostRoot bool, urlSource, name, model string, maxRetries *int) (modelCall, error) {
	source := urlSource
	if source == "" {
		source = "The model BaseURL"
	}
	root = strings.TrimSpace(root)
	if !strings.HasSuffix(root, "/") {
		root += "/"
	}
	u, err := url.Parse(root)
	if err != nil {
		return modelCall{}, failure(ErrInvalidArgument, source+" is not a valid URL.")
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return modelCall{}, failure(ErrInvalidArgument, source+" must be an http(s) URL without credentials.")
	}
	if u.Host == "" {
		return modelCall{}, failure(ErrInvalidArgument, source+" is not a valid URL.")
	}
	addVersion := !versionedPath.MatchString(u.EscapedPath())
	if atHostRoot {
		addVersion = u.EscapedPath() == "/"
	}
	appended := path
	if addVersion {
		appended = "v1/" + path
	}
	retries := 2
	if maxRetries != nil {
		retries = *maxRetries
	}
	if retries < 0 || retries > 5 {
		return modelCall{}, failure(ErrInvalidArgument, "MaxRetries must be from 0 to 5.")
	}
	hostname := strings.ToLower(u.Hostname())
	host := hostname
	if port := u.Port(); port != "" && !(u.Scheme == "http" && port == "80") && !(u.Scheme == "https" && port == "443") {
		host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	return modelCall{
		endpoint:  u.ResolveReference(&url.URL{Path: appended}).String(),
		host:      host,
		appended:  "/" + appended,
		name:      name,
		model:     model,
		urlSource: urlSource,
		retries:   retries,
	}, nil
}
