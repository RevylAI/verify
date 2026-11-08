import { setTimeout as delay } from 'node:timers/promises';
import { VerifyError, errorMessage } from '../errors.js';

/** A JSON Schema object describing one tool's arguments. */
export type JsonSchema = Record<string, unknown>;

export interface ModelTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** One stateless request: the system prompt, the task and history as text, and the current screenshot. */
export interface ModelRequest {
  system: string;
  text: string;
  image: { png: Uint8Array; width: number; height: number };
  tools: ModelTool[];
}

export interface ModelToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelReply {
  /** The tool the model chose, if it chose one. */
  toolCall?: ModelToolCall;
  text?: string;
  usage: ModelUsage;
  /** True when the reply stopped at the output token cap. */
  truncated?: boolean;
}

/**
 * The only contract a model has to meet to drive a Verify session. Implement it to plug in any provider,
 * a local model, or an agent runtime. Each call is independent: Verify sends the full context every turn.
 */
export interface ModelAdapter {
  /** Shown in logs, step results and the Revyl session report, so never put a secret in it. */
  readonly name: string;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}

export interface AnthropicOptions {
  /** For example 'claude-sonnet-4-5'. */
  model: string;
  /** Defaults to the ANTHROPIC_API_KEY environment variable. Sent only to baseURL. */
  apiKey?: string;
  /** Defaults to the ANTHROPIC_BASE_URL environment variable, then https://api.anthropic.com. */
  baseURL?: string;
  /** Output token cap per turn, thinking included. Defaults to 4096. */
  maxTokens?: number;
  /** Attempts after a rate limit, a 5xx or a network error. Defaults to 2. */
  maxRetries?: number;
}

/** Claude through Anthropic's Messages API. */
export function anthropic(options: AnthropicOptions): ModelAdapter {
  const model = requireText(options.model, 'anthropic() model');
  const apiKey = (options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) throw new VerifyError('MODEL_KEY_MISSING', 'anthropic() needs apiKey or ANTHROPIC_API_KEY in the environment. Create a key in the Anthropic Console.');
  const urlSource = options.baseURL === undefined && process.env.ANTHROPIC_BASE_URL?.trim() ? 'ANTHROPIC_BASE_URL' : undefined;
  const { endpoint, appended } = endpointUrl(options.baseURL ?? (urlSource ? process.env.ANTHROPIC_BASE_URL! : 'https://api.anthropic.com'), 'messages', 'unless-versioned', urlSource);
  const maxTokens = options.maxTokens ?? 4096;
  const name = `anthropic/${model}`;
  const call = { endpoint, appended, name, model, secrets: [apiKey], keySource: options.apiKey === undefined ? 'ANTHROPIC_API_KEY' : 'the apiKey you passed', urlSource, maxRetries: options.maxRetries };
  return {
    name,
    async complete(turn, signal) {
      const body = await postJson(call, {
        model,
        max_tokens: maxTokens,
        system: turn.system,
        tools: turn.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
        tool_choice: { type: 'any' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(turn.image.png).toString('base64') } },
            { type: 'text', text: turn.text },
          ],
        }],
      }, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal);
      const content = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];
      const toolUse = content.find((block) => block.type === 'tool_use');
      const text = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('\n').trim();
      const usage = (body.usage ?? {}) as Record<string, unknown>;
      return {
        ...(toolUse && typeof toolUse.name === 'string' ? { toolCall: { name: toolUse.name, arguments: asRecord(toolUse.input) } } : {}),
        ...(text ? { text } : {}),
        usage: { inputTokens: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens), outputTokens: count(usage.output_tokens) },
        ...(body.stop_reason === 'max_tokens' ? { truncated: true } : {}),
      };
    },
  };
}

export interface OpenAICompatibleOptions {
  /** For example 'gpt-5.5', 'qwen-3.8-27b' or 'qwen2.5vl:7b'. */
  model: string;
  /**
   * The API root that serves /chat/completions. Defaults to the OPENAI_BASE_URL environment variable, then https://api.openai.com/v1;
   * Ollama is http://localhost:11434/v1.
   */
  baseURL?: string;
  /**
   * Sent as a bearer token only to baseURL. Defaults to OPENAI_API_KEY when baseURL is left out,
   * and to no key otherwise, so a key for one provider never reaches another.
   */
  apiKey?: string;
  /** Extra headers sent only to baseURL, such as a gateway's api-key header. Never logged. */
  headers?: Record<string, string>;
  /** Prefixes the model in logs and reports, such as 'cerebras'. The baseURL itself is never reported. */
  provider?: string;
  /** Output token cap per turn, reasoning included. Defaults to 4096 for OpenAI and 2048 elsewhere. */
  maxTokens?: number;
  /** Attempts after a rate limit, a 5xx or a network error. Defaults to 2. */
  maxRetries?: number;
}

/** Any server that speaks OpenAI's chat completions with tools and image input: OpenAI, Ollama, vLLM, OpenRouter, Cerebras and others. */
export function openaiCompatible(options: OpenAICompatibleOptions): ModelAdapter {
  return chatCompletions(options, {});
}

/** Request differences between OpenAI-compatible servers. */
export interface ChatCompletionsQuirks {
  /** OpenAI's reasoning models reject max_tokens. */
  tokenField?: 'max_tokens' | 'max_completion_tokens';
  /** Gemini documents only 'auto'. */
  toolChoice?: 'required' | 'auto';
  /** Where the key came from, named in errors when the provider rejects it. */
  keySource?: string;
}

export function chatCompletions(options: OpenAICompatibleOptions, quirks: ChatCompletionsQuirks): ModelAdapter {
  const model = requireText(options.model, 'openaiCompatible() model');
  const openAI = options.baseURL === undefined;
  const urlSource = openAI && process.env.OPENAI_BASE_URL?.trim() ? 'OPENAI_BASE_URL' : undefined;
  const root = options.baseURL ?? (urlSource ? process.env.OPENAI_BASE_URL! : 'https://api.openai.com/v1');
  const apiKey = (options.apiKey ?? (openAI ? process.env.OPENAI_API_KEY : undefined) ?? '').trim();
  const { endpoint, appended } = endpointUrl(root, 'chat/completions', 'at-host-root', urlSource);
  const openAIModels = openAI || endpoint.hostname === 'api.openai.com';
  const extraHeaders = checkHeaders(options.headers);
  const maxTokens = options.maxTokens ?? (openAIModels ? 4096 : 2048);
  const tokenField = quirks.tokenField ?? (openAIModels ? 'max_completion_tokens' : 'max_tokens');
  const name = options.provider ? `${options.provider}/${model}` : model;
  const keySource = quirks.keySource ?? (options.apiKey !== undefined ? 'the apiKey you passed' : apiKey ? 'OPENAI_API_KEY' : undefined);
  const call = { endpoint, appended, name, model, secrets: [apiKey, ...Object.values(extraHeaders)].filter(Boolean), keySource, urlSource, maxRetries: options.maxRetries };
  return {
    name,
    async complete(turn, signal) {
      const body = await postJson(call, {
        model,
        [tokenField]: maxTokens,
        tool_choice: quirks.toolChoice ?? 'required',
        tools: turn.tools.map((tool) => ({ type: 'function', function: tool })),
        messages: [
          { role: 'system', content: turn.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: turn.text },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(turn.image.png).toString('base64')}` } },
            ],
          },
        ],
      }, { ...extraHeaders, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, signal);
      const choices = Array.isArray(body.choices) ? (body.choices as Array<Record<string, unknown>>) : [];
      const message = asRecord(choices[0]?.message);
      const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
      const fn = asRecord(calls[0]?.function);
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      const usage = asRecord(body.usage);
      const toolCall = typeof fn.name === 'string' ? { name: fn.name, arguments: parseArguments(fn.arguments) } : toolCallFromText(text);
      return {
        ...(toolCall ? { toolCall } : {}),
        ...(text ? { text } : {}),
        usage: { inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens) },
        ...(choices[0]?.finish_reason === 'length' ? { truncated: true } : {}),
      };
    },
  };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_RETRY_DELAY_MS = 10_000;

interface ModelCall {
  endpoint: URL;
  /** The path Verify added to the base address, such as '/v1/messages'. */
  appended: string;
  /** The model as Verify reports it, such as 'anthropic/claude-sonnet-5-5'. */
  name: string;
  /** The model name the provider expects. */
  model: string;
  secrets: string[];
  keySource: string | undefined;
  /** The environment variable the address came from, when it did. */
  urlSource: string | undefined;
  maxRetries: number | undefined;
}

async function postJson(call: ModelCall, payload: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const retries = call.maxRetries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new VerifyError('INVALID_ARGUMENT', 'maxRetries must be an integer from 0 to 5.');
  const where = `${call.name} at ${call.endpoint.host}`;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(call.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), redirect: 'error', signal });
    } catch (error) {
      if (signal.aborted) throw new VerifyError('TIMEOUT', `${where} did not answer in time. Raise localAgent() modelTimeout for slow or local models.`, { cause: error });
      if (attempt < retries) {
        await delay(1_000 * 3 ** attempt, undefined, { signal });
        continue;
      }
      throw new VerifyError('MODEL_ERROR', `Could not reach ${where}: ${scrub(errorMessage(error), call.secrets)}. Check the baseURL and that the server is running.`);
    }
    const text = await response.text();
    if (response.ok) {
      try {
        return asRecord(JSON.parse(text));
      } catch {
        throw new VerifyError('MODEL_ERROR', `${where} returned a response that is not JSON. Check that the baseURL serves OpenAI-style chat completions.`);
      }
    }
    if (RETRYABLE.has(response.status) && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, MAX_RETRY_DELAY_MS) : 1_000 * 3 ** attempt, undefined, { signal });
      continue;
    }
    const message = scrub(providerMessage(text), call.secrets).replace(/[.\s]*$/, '.');
    const step = nextStep(response.status, message, call, retries);
    throw new VerifyError('MODEL_ERROR', `${where} refused the request (HTTP ${response.status}): ${message}${step ? ` ${step}` : ''}`, { httpStatus: response.status });
  }
}

function nextStep(status: number, message: string, call: ModelCall, retries: number): string {
  if (status === 401 || status === 403) {
    const address = call.urlSource ? ` (from ${call.urlSource})` : '';
    return call.keySource
      ? `${call.endpoint.host}${address} rejected the key from ${call.keySource}. Check that the key is valid for that endpoint.`
      : `${call.endpoint.host}${address} needs a key: pass apiKey or headers.`;
  }
  if (status === 429) return `Still rate limited after ${retries} retries. Wait and rerun, run fewer sessions at once, or raise your limit with the provider.`;
  const unsupported = /not support|unsupported|only supported|not enabled|not allowed|cannot (accept|process|read)/i.test(message);
  if (unsupported && /image|vision|multimodal|modalit/i.test(message)) return `${call.model} does not accept images. Pick a model that takes image input.`;
  if (unsupported && /tool|function/i.test(message)) return `${call.model} does not support tool calls. Pick a model that does.`;
  if (/model.*(not.?found|not exist|invalid|unknown|not a valid|no such)|(invalid|unknown|no such|not a valid).*model/i.test(message)) return `Check that '${call.model}' is a model name this provider serves.`;
  if (status === 404) {
    const address = call.urlSource ?? 'the baseURL';
    return `Verify added ${call.appended} to ${address}. Check that '${call.model}' is a model this provider serves, and whether ${address} should include /v1.`;
  }
  if (status >= 500) return 'The provider failed; try again later.';
  return '';
}

function providerMessage(text: string): string {
  try {
    const body = asRecord(JSON.parse(text));
    const error = body.error;
    const message = typeof error === 'string' ? error : asRecord(error).message ?? body.message;
    if (typeof message === 'string') return message.slice(0, 300);
    return 'no error message';
  } catch {}
  const plain = text.replace(/\s+/g, ' ').trim();
  return plain && !plain.startsWith('<') ? plain.slice(0, 300) : 'no error message';
}

function scrub(text: string, secrets: string[]): string {
  return secrets.reduce((out, secret) => (secret.length >= 4 ? out.split(secret).join('[redacted]') : out), text);
}

function checkHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new VerifyError('INVALID_ARGUMENT', 'Model headers must be an object of header names to string values.');
  const entries = Object.entries(headers);
  if (entries.length > 20) throw new VerifyError('INVALID_ARGUMENT', 'Pass at most 20 model headers.');
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name) || typeof value !== 'string' || value.length > 8_192 || /[\r\n\0]/.test(value)) {
      throw new VerifyError('INVALID_ARGUMENT', 'Model headers need valid names and single-line string values.');
    }
  }
  return { ...headers };
}

function toolCallFromText(text: string): ModelToolCall | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = asRecord(JSON.parse(text.slice(start, end + 1)));
    const name = parsed.name ?? parsed.tool;
    if (typeof name !== 'string') return undefined;
    return { name, arguments: parseArguments(parsed.arguments ?? parsed.parameters ?? {}) };
  } catch {
    return undefined;
  }
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new VerifyError('INVALID_ARGUMENT', `${what} must be a non-empty string.`);
  return value.trim();
}

/**
 * Builds the request URL from a base address given with or without its /v1 suffix.
 * unless-versioned: Anthropic's habit; add v1/ unless the address already ends in a version such as /v1.
 * at-host-root: OpenAI-compatible; add v1/ only to a bare host, since other paths (/openai/v1, /v1beta/openai) are already complete.
 */
function endpointUrl(root: string, path: string, version: 'unless-versioned' | 'at-host-root', source = 'The model baseURL'): { endpoint: URL; appended: string } {
  let url: URL;
  try {
    url = new URL(root.trim().endsWith('/') ? root.trim() : `${root.trim()}/`);
  } catch {
    throw new VerifyError('INVALID_ARGUMENT', `${source} is not a valid URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new VerifyError('INVALID_ARGUMENT', `${source} must be an http(s) URL without credentials.`);
  const versioned = /\/v\d+[a-z0-9]*\/$/i.test(url.pathname);
  const addVersion = version === 'unless-versioned' ? !versioned : url.pathname === '/';
  const appended = addVersion ? `v1/${path}` : path;
  return { endpoint: new URL(appended, url), appended: `/${appended}` };
}
