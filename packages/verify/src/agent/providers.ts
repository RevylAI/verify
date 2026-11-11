import { VerifyError } from '../errors.js';
import { localAgent, type Grounding, type LocalAgent } from './loop.js';
import { anthropic, chatCompletions, type ChatCompletionsQuirks } from './model.js';

/** Your own OpenAI-compatible endpoint, such as vLLM, LiteLLM or a gateway. */
export interface CustomModel {
  /** The model name the endpoint expects. */
  id: string;
  /** The API root that serves /chat/completions. */
  baseURL: string;
  /** Sent as a bearer token only to baseURL. Never read from the environment, logged or sent to Revyl. */
  apiKey?: string;
  /** Extra headers sent only to baseURL. */
  headers?: Record<string, string>;
  /** Prefixes the model in step results and reports, such as 'anthropic' for 'anthropic/claude-sonnet-5-5'. */
  provider?: string;
  /** 'revyl' (default) has the model name elements for Revyl to locate; 'model' has it give screen coordinates. */
  grounding?: Grounding;
}

/** A built-in 'provider/model' string, such as 'anthropic/claude-sonnet-5-5', or your own endpoint. */
export type ModelOption = string | CustomModel;

interface Provider {
  label: string;
  /** Environment variables holding the key, in the order the provider's own SDKs read them. Empty when no key is needed. */
  env: string[];
  baseURL?: string;
  quirks?: ChatCompletionsQuirks;
  /** Output cap per turn when the model may think before answering. */
  maxTokens?: number;
}

const PROVIDERS: Record<string, Provider> = {
  anthropic: { label: 'Anthropic', env: ['ANTHROPIC_API_KEY'] },
  openai: { label: 'OpenAI', env: ['OPENAI_API_KEY'] },
  google: { label: 'Google AI Studio', env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', quirks: { toolChoice: 'auto' }, maxTokens: 4096 },
  openrouter: { label: 'OpenRouter', env: ['OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1' },
  groq: { label: 'Groq', env: ['GROQ_API_KEY'], baseURL: 'https://api.groq.com/openai/v1' },
  cerebras: { label: 'Cerebras', env: ['CEREBRAS_API_KEY'], baseURL: 'https://api.cerebras.ai/v1' },
  xai: { label: 'xAI', env: ['XAI_API_KEY'], baseURL: 'https://api.x.ai/v1' },
  ollama: { label: 'Ollama', env: [], baseURL: 'http://localhost:11434/v1' },
};

/** Picks the local agent for a step or session: a model option, an agent, or neither for Revyl's agent. */
export function chooseAgent(options: { model?: ModelOption; agent?: LocalAgent }, where: string): LocalAgent | undefined {
  if (options.model !== undefined && options.agent !== undefined) {
    throw new VerifyError('INVALID_ARGUMENT', `${where} takes model or agent, not both.`);
  }
  if (options.model !== undefined) return agentForModel(options.model);
  if (options.agent !== undefined && typeof options.agent?.model?.complete !== 'function') {
    throw new VerifyError('INVALID_ARGUMENT', `${where} takes an agent made with localAgent().`);
  }
  return options.agent;
}

const USAGE = `Pass 'provider/model', such as 'anthropic/claude-sonnet-5-5', with a provider of ${Object.keys(PROVIDERS).join(', ')}, or { id, baseURL } for your own OpenAI-compatible endpoint.`;

function agentForModel(option: ModelOption): LocalAgent {
  if (typeof option === 'string') {
    const slash = option.indexOf('/');
    const name = slash > 0 ? option.slice(0, slash) : '';
    const id = option.slice(slash + 1).trim();
    const provider = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
    if (!provider || !id) {
      throw new VerifyError('INVALID_ARGUMENT', `Unknown model '${option.slice(0, 100)}'. ${USAGE}`);
    }
    const keyVariable = provider.env.find((variable) => process.env[variable]?.trim());
    if (provider.env.length > 0 && !keyVariable) {
      throw new VerifyError('MODEL_KEY_MISSING', `model '${option}' reads its key from ${provider.env.join(' or ')}, which is not set. Set it to your ${provider.label} API key.`);
    }
    const apiKey = keyVariable ? process.env[keyVariable]!.trim() : undefined;
    if (name === 'anthropic') return localAgent({ model: anthropic({ model: id }) });
    return localAgent({
      model: chatCompletions(
        { model: id, ...(provider.baseURL ? { baseURL: provider.baseURL } : {}), provider: name, ...(apiKey ? { apiKey } : {}), ...(provider.maxTokens ? { maxTokens: provider.maxTokens } : {}) },
        { ...provider.quirks, ...(keyVariable ? { keySource: keyVariable } : {}) },
      ),
    });
  }
  if (!option || typeof option !== 'object' || typeof option.id !== 'string' || typeof option.baseURL !== 'string') {
    throw new VerifyError('INVALID_ARGUMENT', `model must be a string or an object. ${USAGE}`);
  }
  if (option.apiKey !== undefined && typeof option.apiKey !== 'string') throw new VerifyError('INVALID_ARGUMENT', 'model apiKey must be a string.');
  if (option.provider !== undefined && (typeof option.provider !== 'string' || !option.provider.trim())) throw new VerifyError('INVALID_ARGUMENT', 'model provider must be a non-empty string.');
  return localAgent({
    model: chatCompletions({ model: option.id, baseURL: option.baseURL, ...(option.apiKey !== undefined ? { apiKey: option.apiKey } : {}), ...(option.headers ? { headers: option.headers } : {}), ...(option.provider ? { provider: option.provider.trim() } : {}) }, {}),
    ...(option.grounding ? { grounding: option.grounding } : {}),
  });
}
