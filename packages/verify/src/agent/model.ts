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
export interface ModelTurn {
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
}

/**
 * The only contract a model has to meet to drive a Verify session. Implement it to plug in any provider,
 * a local model, or an agent runtime. Each call is independent: Verify sends the full context every turn.
 */
export interface ModelAdapter {
  /** Shown in logs, step results and the Revyl session report, so never put a secret in it. */
  readonly name: string;
  complete(turn: ModelTurn, signal: AbortSignal): Promise<ModelReply>;
}

export interface AnthropicOptions {
  /** For example 'claude-sonnet-4-5'. */
  model: string;
  /** Defaults to the ANTHROPIC_API_KEY environment variable. Sent only to baseURL. */
  apiKey?: string;
  /** Defaults to https://api.anthropic.com. */
  baseURL?: string;
  /** Output token cap per turn. Defaults to 1024. */
  maxTokens?: number;
  /** Attempts after a rate limit, a 5xx or a network error. Defaults to 2. */
  maxRetries?: number;
}

/** Claude through Anthropic's Messages API. */
export function anthropic(options: AnthropicOptions): ModelAdapter {
  const model = requireText(options.model, 'anthropic() model');
  const apiKey = (options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) throw new VerifyError('INVALID_ARGUMENT', 'anthropic() needs apiKey or the ANTHROPIC_API_KEY environment variable.');
  const endpoint = endpointUrl(options.baseURL ?? 'https://api.anthropic.com', 'v1/messages');
  const maxTokens = options.maxTokens ?? 1024;
  return {
    name: `anthropic/${model}`,
    async complete(turn, signal) {
      const body = await postJson(endpoint, {
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
      }, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, apiKey, options.maxRetries, signal);
      const content = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];
      const toolUse = content.find((block) => block.type === 'tool_use');
      const text = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('\n').trim();
      const usage = (body.usage ?? {}) as Record<string, unknown>;
      return {
        ...(toolUse && typeof toolUse.name === 'string' ? { toolCall: { name: toolUse.name, arguments: asRecord(toolUse.input) } } : {}),
        ...(text ? { text } : {}),
        usage: { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) },
      };
    },
  };
}

export interface OpenAICompatibleOptions {
  /** For example 'gpt-5', 'qwen-3.8-27b' or 'qwen2.5vl:7b'. */
  model: string;
  /** The API root that serves /chat/completions. Defaults to https://api.openai.com/v1; Ollama is http://localhost:11434/v1. */
  baseURL?: string;
  /**
   * Sent as a bearer token only to baseURL. Defaults to OPENAI_API_KEY when baseURL is left at OpenAI's,
   * and to no key otherwise, so a key for one provider never reaches another.
   */
  apiKey?: string;
  /** Prefixes the model in logs and reports, such as 'cerebras'. Defaults to the baseURL host. */
  provider?: string;
  /** Output token cap per turn, reasoning included. Defaults to 2048. */
  maxTokens?: number;
  /** Attempts after a rate limit, a 5xx or a network error. Defaults to 2. */
  maxRetries?: number;
}

/** Any server that speaks OpenAI's chat completions with tools and image input: OpenAI, Ollama, vLLM, OpenRouter, Cerebras and others. */
export function openaiCompatible(options: OpenAICompatibleOptions): ModelAdapter {
  const model = requireText(options.model, 'openaiCompatible() model');
  const root = options.baseURL ?? 'https://api.openai.com/v1';
  const apiKey = (options.apiKey ?? (options.baseURL === undefined ? process.env.OPENAI_API_KEY : undefined) ?? '').trim();
  const endpoint = endpointUrl(root, 'chat/completions');
  const provider = options.provider ?? endpoint.hostname;
  const maxTokens = options.maxTokens ?? 2048;
  return {
    name: `${provider}/${model}`,
    async complete(turn, signal) {
      const body = await postJson(endpoint, {
        model,
        max_tokens: maxTokens,
        tool_choice: 'required',
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
      }, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, apiKey, options.maxRetries, signal);
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
      };
    },
  };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_RETRY_DELAY_MS = 10_000;

async function postJson(
  url: URL,
  payload: unknown,
  headers: Record<string, string>,
  secret: string,
  maxRetries: number | undefined,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const retries = maxRetries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new VerifyError('INVALID_ARGUMENT', 'maxRetries must be an integer from 0 to 5.');
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), redirect: 'error', signal });
    } catch (error) {
      if (signal.aborted) throw new VerifyError('TIMEOUT', `The model at ${url.host} did not answer in time.`, { cause: error });
      if (attempt < retries) {
        await delay(1_000 * 3 ** attempt, undefined, { signal });
        continue;
      }
      throw new VerifyError('MODEL_ERROR', `Could not reach the model at ${url.host}: ${scrub(errorMessage(error), secret)}`);
    }
    const text = await response.text();
    if (response.ok) {
      try {
        return asRecord(JSON.parse(text));
      } catch {
        throw new VerifyError('MODEL_ERROR', `The model at ${url.host} returned a response that is not JSON.`);
      }
    }
    if (RETRYABLE.has(response.status) && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, MAX_RETRY_DELAY_MS) : 1_000 * 3 ** attempt, undefined, { signal });
      continue;
    }
    throw new VerifyError('MODEL_ERROR', `The model at ${url.host} refused the request (HTTP ${response.status}): ${scrub(providerMessage(text), secret)}`, { httpStatus: response.status });
  }
}

function providerMessage(text: string): string {
  try {
    const body = asRecord(JSON.parse(text));
    const error = body.error;
    const message = typeof error === 'string' ? error : asRecord(error).message ?? body.message;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {}
  return 'no error message';
}

function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
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

function endpointUrl(root: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(root.endsWith('/') ? root : `${root}/`);
  } catch {
    throw new VerifyError('INVALID_ARGUMENT', 'The model baseURL is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new VerifyError('INVALID_ARGUMENT', 'The model baseURL must be an http(s) URL without credentials.');
  return new URL(path, url);
}
