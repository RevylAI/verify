package verify

import (
	"os"
	"strings"
	"time"
)

// Grounding decides who finds the element your model wants to act on.
type Grounding string

const (
	// GroundingRevyl has the model describe the element, such as "General row", and Revyl's grounding model
	// find it, so element descriptions reach Revyl too. The default.
	GroundingRevyl Grounding = "revyl"
	// GroundingModel has the model give screenshot coordinates, so only device actions reach Revyl.
	GroundingModel Grounding = "model"
)

// LocalAgent runs instructions and validations on a model you choose, in your process. Revyl only
// receives device actions. Zero fields take their defaults.
type LocalAgent struct {
	// Model is a ModelAdapter, such as one from Anthropic or OpenAICompatible.
	Model ModelAdapter
	// Grounding defaults to GroundingRevyl.
	Grounding Grounding
	// MaxTurns is the model turns an instruction may take, each ending in one action. Defaults to 20, at most 100.
	MaxTurns int
	// ModelTimeout bounds one model call, retries included. Defaults to 60 seconds, from 1 second to 10 minutes.
	ModelTimeout time.Duration
	// MaxImageSide is the longest screenshot side sent to the model, in pixels. Defaults to 1280, from 256 to 4096.
	MaxImageSide int
}

// CustomModel is your own OpenAI-compatible endpoint, such as vLLM, LiteLLM or a gateway.
// Its key comes only from APIKey: Verify never reads an environment variable for it.
type CustomModel struct {
	// ID is the model name the endpoint expects.
	ID string
	// BaseURL is the API root that serves /chat/completions.
	BaseURL string
	// APIKey is sent as a bearer token only to BaseURL. Never logged or sent to Revyl.
	APIKey string
	// Headers are extra headers sent only to BaseURL.
	Headers map[string]string
	// Provider prefixes the model in step results and reports, such as "anthropic" for "anthropic/claude-sonnet-5-5".
	Provider string
	// Grounding defaults to GroundingRevyl.
	Grounding Grounding
}

// Option runs steps on your own model instead of Revyl's agent. Pass one to Open to cover every step,
// or to Instruction or Validation to cover one step.
type Option struct {
	resolve func() (*agent, error)
}

// WithModel runs steps on a built-in provider's model, such as "anthropic/claude-sonnet-5-5". The key is
// read from the provider's usual environment variable.
func WithModel(model string) Option {
	return Option{resolve: func() (*agent, error) { return modelAgent(model) }}
}

// WithCustomModel runs steps on your own OpenAI-compatible endpoint.
func WithCustomModel(model CustomModel) Option {
	return Option{resolve: func() (*agent, error) { return customAgent(model) }}
}

// WithAgent runs steps on a LocalAgent you configure.
func WithAgent(agent LocalAgent) Option {
	return Option{resolve: agent.build}
}

func (Option) openOption()       {}
func (Option) stepOption()       {}
func (Option) validationOption() {}

type agent struct {
	model        ModelAdapter
	grounding    Grounding
	maxTurns     int
	modelTimeout time.Duration
	maxImageSide int
}

func (a LocalAgent) build() (*agent, error) {
	if a.Model == nil {
		return nil, failure(ErrInvalidArgument, "LocalAgent needs a model adapter, such as Anthropic() or OpenAICompatible().")
	}
	built := &agent{model: a.Model, grounding: a.Grounding, maxTurns: a.MaxTurns, modelTimeout: a.ModelTimeout, maxImageSide: a.MaxImageSide}
	if built.grounding == "" {
		built.grounding = GroundingRevyl
	}
	if built.grounding != GroundingRevyl && built.grounding != GroundingModel {
		return nil, failure(ErrInvalidArgument, "LocalAgent Grounding must be GroundingModel or GroundingRevyl.")
	}
	if built.maxTurns == 0 {
		built.maxTurns = 20
	}
	if built.modelTimeout == 0 {
		built.modelTimeout = time.Minute
	}
	if built.maxImageSide == 0 {
		built.maxImageSide = 1280
	}
	if built.maxTurns < 1 || built.maxTurns > 100 {
		return nil, failure(ErrInvalidArgument, "LocalAgent MaxTurns must be from 1 to 100.")
	}
	if built.modelTimeout < time.Second || built.modelTimeout > 10*time.Minute {
		return nil, failure(ErrInvalidArgument, "LocalAgent ModelTimeout must be from 1 second to 10 minutes.")
	}
	if built.maxImageSide < 256 || built.maxImageSide > 4096 {
		return nil, failure(ErrInvalidArgument, "LocalAgent MaxImageSide must be from 256 to 4096.")
	}
	return built, nil
}

type provider struct {
	name       string
	label      string
	env        []string
	baseURL    string
	toolChoice string
	maxTokens  int
}

var providers = []provider{
	{name: "anthropic", label: "Anthropic", env: []string{"ANTHROPIC_API_KEY"}},
	{name: "openai", label: "OpenAI", env: []string{"OPENAI_API_KEY"}},
	{name: "google", label: "Google AI Studio", env: []string{"GOOGLE_API_KEY", "GEMINI_API_KEY"}, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", toolChoice: "auto", maxTokens: 4096},
	{name: "openrouter", label: "OpenRouter", env: []string{"OPENROUTER_API_KEY"}, baseURL: "https://openrouter.ai/api/v1"},
	{name: "groq", label: "Groq", env: []string{"GROQ_API_KEY"}, baseURL: "https://api.groq.com/openai/v1"},
	{name: "cerebras", label: "Cerebras", env: []string{"CEREBRAS_API_KEY"}, baseURL: "https://api.cerebras.ai/v1"},
	{name: "xai", label: "xAI", env: []string{"XAI_API_KEY"}, baseURL: "https://api.x.ai/v1"},
	{name: "ollama", label: "Ollama", baseURL: "http://localhost:11434/v1"},
}

func modelUsage() string {
	names := make([]string, len(providers))
	for i, p := range providers {
		names[i] = p.name
	}
	return "Pass 'provider/model', such as 'anthropic/claude-sonnet-5-5', with a provider of " + strings.Join(names, ", ") + ", or WithCustomModel(CustomModel{ID, BaseURL}) for your own OpenAI-compatible endpoint."
}

func modelAgent(option string) (*agent, error) {
	slash := strings.Index(option, "/")
	name := ""
	if slash > 0 {
		name = option[:slash]
	}
	id := strings.TrimSpace(option[slash+1:])
	var p *provider
	for i := range providers {
		if providers[i].name == name {
			p = &providers[i]
		}
	}
	if p == nil || id == "" {
		return nil, failure(ErrInvalidArgument, "Unknown model '"+clip(option, 100)+"'. "+modelUsage())
	}
	keyVariable, apiKey := "", ""
	for _, variable := range p.env {
		if value := strings.TrimSpace(os.Getenv(variable)); value != "" {
			keyVariable, apiKey = variable, value
			break
		}
	}
	if len(p.env) > 0 && keyVariable == "" {
		return nil, failure(ErrModelKeyMissing, "model '"+option+"' reads its key from "+strings.Join(p.env, " or ")+", which is not set. Set it to your "+p.label+" API key.")
	}
	var model ModelAdapter
	var err error
	if p.name == "anthropic" {
		model, err = Anthropic(AnthropicOptions{Model: id})
	} else {
		model, err = chatCompletions(OpenAICompatibleOptions{Model: id, BaseURL: p.baseURL, Provider: p.name, APIKey: apiKey, MaxTokens: p.maxTokens}, chatQuirks{toolChoice: p.toolChoice, keySource: keyVariable})
	}
	if err != nil {
		return nil, err
	}
	return LocalAgent{Model: model}.build()
}

func customAgent(option CustomModel) (*agent, error) {
	if strings.TrimSpace(option.ID) == "" || strings.TrimSpace(option.BaseURL) == "" {
		return nil, failure(ErrInvalidArgument, "CustomModel needs an ID and a BaseURL. "+modelUsage())
	}
	providerName := strings.TrimSpace(option.Provider)
	if option.Provider != "" && providerName == "" {
		return nil, failure(ErrInvalidArgument, "model provider must be a non-empty string.")
	}
	model, err := chatCompletions(OpenAICompatibleOptions{Model: option.ID, BaseURL: option.BaseURL, APIKey: option.APIKey, Headers: option.Headers, Provider: providerName}, chatQuirks{})
	if err != nil {
		return nil, err
	}
	return LocalAgent{Model: model, Grounding: option.Grounding}.build()
}

// splitOptions separates the settings struct of a call from the model option, which it resolves.
func splitOptions[T any, O any](options []O, where string) ([]T, *agent, error) {
	var settings []T
	var choice *Option
	for _, option := range options {
		switch value := any(option).(type) {
		case T:
			settings = append(settings, value)
		case Option:
			if choice != nil {
				return nil, nil, failure(ErrInvalidArgument, where+" takes a model or an agent, not both.")
			}
			choice = &value
		default:
			return nil, nil, failure(ErrInvalidArgument, where+" received a nil option.")
		}
	}
	if choice == nil {
		return settings, nil, nil
	}
	if choice.resolve == nil {
		return nil, nil, failure(ErrInvalidArgument, "Build an Option with WithModel, WithCustomModel or WithAgent.")
	}
	resolved, err := choice.resolve()
	return settings, resolved, err
}
