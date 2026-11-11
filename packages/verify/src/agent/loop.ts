import { setTimeout as delay } from 'node:timers/promises';
import { VerifyError, errorMessage, isVerifyError } from '../errors.js';
import { fitPng } from './image.js';
import type { ModelAdapter, ModelTool, ModelToolCall } from './model.js';

/** A point in device units: iOS points, Android and Web pixels, from the top-left corner. */
export interface Point {
  x: number;
  y: number;
}

/** An element described in words, which Revyl's grounding model locates on the current screen. */
export interface Target {
  target: string;
}

export type Location = Point | Target;

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

export type DeviceAction =
  | { kind: 'tap'; at: Location }
  | { kind: 'type'; at: Location; text: string; clear: boolean }
  | { kind: 'swipe'; direction: SwipeDirection; from?: Location }
  | { kind: 'key'; key: 'enter' | 'backspace' }
  | { kind: 'back' }
  | { kind: 'open_url'; url: string };

/** What the agent loop needs from a session. DeviceSession provides it. */
export interface AgentControls {
  readonly platform: 'ios' | 'android' | 'web';
  capture(signal: AbortSignal): Promise<{ png: Uint8Array; screenToken?: string }>;
  screenSize(signal: AbortSignal): Promise<{ width: number; height: number }>;
  perform(action: DeviceAction, screenToken: string | undefined, signal: AbortSignal): Promise<Point | undefined>;
}

/**
 * model: the model gives screenshot coordinates, and only device actions reach Revyl.
 * revyl: the model names the element and Revyl's grounding model finds it, so element descriptions reach Revyl too.
 */
export type Grounding = 'model' | 'revyl';

export interface LocalAgentOptions {
  model: ModelAdapter;
  /** Defaults to 'revyl'. */
  grounding?: Grounding;
  /** Model turns an instruction may take, each ending in one action. Defaults to 20, at most 100. */
  maxTurns?: number;
  /** Milliseconds one model call may take, retries included. Defaults to 60000. */
  modelTimeout?: number;
  /** The longest screenshot side sent to the model, in pixels. Defaults to 1280. */
  maxImageSide?: number;
}

export interface LocalAgent {
  readonly model: ModelAdapter;
  readonly grounding: Grounding;
  readonly maxTurns: number;
  readonly modelTimeout: number;
  readonly maxImageSide: number;
}

/** One model turn of a local step. */
export interface ModelTurn {
  /** The action the model chose, as text, such as 'tap "General"' or 'verdict true'. */
  action: string;
  /** Whether the action ran; a failed action is reported back to the model on its next turn. */
  ok: boolean;
  modelMs: number;
  actionMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** How a step ran on your model instead of Revyl's agent. */
export interface ModelRun {
  /** The model's name, such as 'anthropic/claude-sonnet-5-5'. */
  id: string;
  grounding: Grounding;
  turns: ModelTurn[];
  inputTokens: number;
  outputTokens: number;
}

/** Runs instructions and validations on a model you choose, on your machine. Revyl only receives device actions. */
export function localAgent(options: LocalAgentOptions): LocalAgent {
  if (!options || typeof options.model?.complete !== 'function' || typeof options.model.name !== 'string') {
    throw new VerifyError('INVALID_ARGUMENT', 'localAgent() needs a model adapter, such as anthropic() or openaiCompatible().');
  }
  const grounding = options.grounding ?? 'revyl';
  if (grounding !== 'model' && grounding !== 'revyl') throw new VerifyError('INVALID_ARGUMENT', "localAgent() grounding must be 'model' or 'revyl'.");
  const maxTurns = bounded(options.maxTurns ?? 20, 1, 100, 'maxTurns');
  const modelTimeout = bounded(options.modelTimeout ?? 60_000, 1_000, 600_000, 'modelTimeout');
  const maxImageSide = bounded(options.maxImageSide ?? 1280, 256, 4096, 'maxImageSide');
  return Object.freeze({ model: options.model, grounding, maxTurns, modelTimeout, maxImageSide });
}

const VALIDATION_ATTEMPTS = 3;
const NO_TOOL_LIMIT = 3;
const ABORTING_CODES = new Set(['SESSION_ENDED', 'SESSION_BUSY', 'AUTH_REJECTED', 'EDGE_BLOCKED', 'MODEL_ERROR', 'TIMEOUT', 'API_ERROR', 'ACTION_UNCERTAIN']);

/** Runs one instruction or validation through the agent's model. The caller enforces the step deadline through signal. */
export async function runLocalStep(
  type: 'instruction' | 'validation',
  task: string,
  agent: LocalAgent,
  controls: AgentControls,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<{ passed: boolean; reason?: string; run: ModelRun }> {
  const run: ModelRun = { id: agent.model.name, grounding: agent.grounding, turns: [], inputTokens: 0, outputTokens: 0 };
  const history: string[] = [];
  const size = await controls.screenSize(signal);
  const tools = type === 'validation' ? [VERDICT_TOOL] : instructionTools(controls.platform, agent.grounding);
  const turns = type === 'validation' ? VALIDATION_ATTEMPTS : agent.maxTurns;
  let turnsWithoutTool = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    signal.throwIfAborted();
    const shot = await controls.capture(signal);
    const image = fitPng(shot.png, agent.maxImageSide);
    const modelStarted = Date.now();
    const reply = await agent.model.complete(
      {
        system: type === 'validation' ? validationPrompt(controls.platform) : instructionPrompt(controls.platform, agent.grounding),
        text: turnText(type, task, image, history),
        image,
        tools,
      },
      AbortSignal.any([signal, AbortSignal.timeout(agent.modelTimeout)]),
    );
    const record: ModelTurn = { action: 'no tool call', ok: false, modelMs: Date.now() - modelStarted, actionMs: 0, inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens };
    run.turns.push(record);
    run.inputTokens += record.inputTokens;
    run.outputTokens += record.outputTokens;
    const call = reply.toolCall;
    if (reply.truncated) {
      throw new VerifyError('MODEL_ERROR', `${agent.model.name}'s reply was cut off at its output token cap ${call ? 'in the middle of a tool call, so Verify did not use it' : 'before it called a tool'}. Pass the model to localAgent() through an adapter with a higher maxTokens, such as anthropic({ model, maxTokens: 8192 }) or openaiCompatible({ model, baseURL, maxTokens: 8192 }).`);
    }
    if (!call) {
      turnsWithoutTool += 1;
      if (turnsWithoutTool === NO_TOOL_LIMIT) {
        throw new VerifyError('MODEL_ERROR', `${agent.model.name} answered ${NO_TOOL_LIMIT} times in a row without calling a tool. Pick a model that supports tool calls.`);
      }
      history.push(`${turn}. You answered without calling a tool. Call exactly one tool.`);
      log(`  · turn ${turn}: no tool call (${record.modelMs} ms)`);
      continue;
    }
    turnsWithoutTool = 0;
    if (!tools.some((tool) => tool.name === call.name)) {
      record.action = call.name.slice(0, 40);
      history.push(`${turn}. ${record.action}: failed: not one of the offered tools (${tools.map((tool) => tool.name).join(', ')}).`);
      log(`  · turn ${turn}: ${record.action} is not an offered tool (${record.modelMs} ms)`);
      continue;
    }
    if (call.name === 'done' || call.name === 'verdict') {
      const passed = (call.name === 'done' ? call.arguments.success : call.arguments.passed) === true;
      const reason = typeof call.arguments.reason === 'string' ? call.arguments.reason.slice(0, 1_000) : undefined;
      record.action = `${call.name} ${passed}`;
      record.ok = true;
      log(`  · turn ${turn}: ${record.action} (${record.modelMs} ms)`);
      return { passed, ...(reason ? { reason } : {}), run };
    }
    const actionStarted = Date.now();
    try {
      const action = toAction(call, controls.platform, agent.grounding, image, size);
      record.action = describe(action);
      const at = await controls.perform(action, shot.screenToken, signal);
      record.ok = true;
      history.push(`${turn}. ${record.action}${at ? ` at (${at.x}, ${at.y})` : ''}: done.`);
    } catch (error) {
      if (isVerifyError(error) && ABORTING_CODES.has(error.code)) throw error;
      if (record.action === 'no tool call') record.action = call.name;
      history.push(`${turn}. ${record.action}: failed: ${errorMessage(error).slice(0, 300)}`);
    }
    record.actionMs = Date.now() - actionStarted;
    log(`  · turn ${turn}: ${record.action}${record.ok ? '' : ' (failed)'} (model ${record.modelMs} ms, action ${record.actionMs} ms)`);
    await delay(controls.platform === 'web' ? 500 : 1_000, undefined, { signal });
  }
  if (type === 'validation') throw new VerifyError('STEP_FAILED', `${agent.model.name} gave no verdict in ${turns} attempts.`);
  return { passed: false, reason: `${agent.model.name} did not finish within ${turns} turns.`, run };
}

function toAction(call: ModelToolCall, platform: AgentControls['platform'], grounding: Grounding, image: { width: number; height: number }, size: { width: number; height: number }): DeviceAction {
  const args = call.arguments;
  const location = (required: boolean): Location | undefined => {
    if (grounding === 'revyl') {
      if (typeof args.target === 'string' && args.target.trim()) return { target: args.target.trim().slice(0, 500) };
      if (required) throw new VerifyError('INVALID_ARGUMENT', 'target is required: describe the element by its visible text or appearance.');
      return undefined;
    }
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      if (required) throw new VerifyError('INVALID_ARGUMENT', 'x and y are required.');
      return undefined;
    }
    if (args.x < 0 || args.y < 0 || args.x >= image.width || args.y >= image.height) {
      throw new VerifyError('INVALID_ARGUMENT', `(${args.x}, ${args.y}) is outside the ${image.width}x${image.height} screenshot.`);
    }
    return { x: Math.round((args.x * size.width) / image.width), y: Math.round((args.y * size.height) / image.height) };
  };
  switch (call.name) {
    case 'tap':
      return { kind: 'tap', at: location(true)! };
    case 'type':
      if (typeof args.text !== 'string') throw new VerifyError('INVALID_ARGUMENT', 'text is required.');
      return { kind: 'type', at: location(true)!, text: args.text, clear: args.clear !== false };
    case 'swipe': {
      if (!['up', 'down', 'left', 'right'].includes(String(args.direction))) throw new VerifyError('INVALID_ARGUMENT', 'direction must be up, down, left or right.');
      const from = location(false);
      return { kind: 'swipe', direction: args.direction as SwipeDirection, ...(from ? { from } : {}) };
    }
    case 'press_key':
      if (args.key !== 'enter' && args.key !== 'backspace') throw new VerifyError('INVALID_ARGUMENT', 'key must be enter or backspace.');
      return { kind: 'key', key: args.key };
    case 'back':
      if (platform === 'ios') throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', 'iOS has no back button; tap the on-screen back control.');
      return { kind: 'back' };
    case 'open_url':
      if (typeof args.url !== 'string' || !args.url) throw new VerifyError('INVALID_ARGUMENT', 'url is required.');
      return { kind: 'open_url', url: args.url };
    default:
      throw new VerifyError('INVALID_ARGUMENT', `${call.name} is not a tool.`);
  }
}

function describe(action: DeviceAction): string {
  const where = (at: Location | undefined) => (at === undefined ? '' : 'target' in at ? ` "${at.target}"` : ` (${at.x}, ${at.y})`);
  switch (action.kind) {
    case 'tap':
      return `tap${where(action.at)}`;
    case 'type':
      return `type ${JSON.stringify(action.text.length > 40 ? `${action.text.slice(0, 40)}…` : action.text)} into${where(action.at)}`;
    case 'swipe':
      return `swipe ${action.direction}${action.from ? ` from${where(action.from)}` : ''}`;
    case 'key':
      return `press ${action.key}`;
    case 'back':
      return 'back';
    case 'open_url':
      return `open ${action.url}`;
  }
}

const PLATFORM_LABEL = { ios: 'iPhone simulator', android: 'Android emulator', web: 'web browser' } as const;

function instructionPrompt(platform: AgentControls['platform'], grounding: Grounding): string {
  return [
    `You operate a ${PLATFORM_LABEL[platform]} to carry out a task. Every turn you see the current screenshot and the actions taken so far, and you call exactly one tool.`,
    grounding === 'revyl'
      ? 'To point at an element, describe it in target by its visible text or look, for example "General row" or "Search field". Do not give coordinates.'
      : 'To point at an element, give the pixel coordinates of its center in the screenshot, x to the right and y down from the top-left corner.',
    'Check the screenshot before each action: the previous action may not have done what you expected. To see content further down, swipe up.',
    'Call done with success true as soon as the screenshot shows the task is complete. Call done with success false and a reason if it cannot be done.',
  ].join('\n');
}

function validationPrompt(platform: AgentControls['platform']): string {
  return `You check whether a statement holds on the current screen of a ${PLATFORM_LABEL[platform]}. Judge only what the screenshot shows, then call verdict with passed and a one-sentence reason.`;
}

function turnText(type: 'instruction' | 'validation', task: string, image: { width: number; height: number }, history: string[]): string {
  const lines = [type === 'validation' ? `Statement: ${task}` : `Task: ${task}`, `The screenshot is ${image.width}x${image.height} pixels.`];
  if (type === 'instruction') lines.push(history.length ? `Actions so far:\n${history.slice(-30).join('\n')}` : 'No actions yet.');
  else if (history.length) lines.push(`Earlier attempts:\n${history.join('\n')}`);
  return lines.join('\n');
}

const VERDICT_TOOL: ModelTool = {
  name: 'verdict',
  description: 'Report whether the statement holds on the screen.',
  parameters: { type: 'object', properties: { passed: { type: 'boolean' }, reason: { type: 'string' } }, required: ['passed', 'reason'] },
};

function instructionTools(platform: AgentControls['platform'], grounding: Grounding): ModelTool[] {
  const at = grounding === 'revyl'
    ? { properties: { target: { type: 'string', description: 'The element, by its visible text or look.' } }, required: ['target'] }
    : { properties: { x: { type: 'integer', description: 'Screenshot pixel x.' }, y: { type: 'integer', description: 'Screenshot pixel y.' } }, required: ['x', 'y'] };
  const tools: ModelTool[] = [
    { name: 'tap', description: 'Tap an element.', parameters: { type: 'object', ...at } },
    {
      name: 'type',
      description: 'Tap a text field and type into it. Clears the field first unless clear is false.',
      parameters: { type: 'object', properties: { ...at.properties, text: { type: 'string' }, clear: { type: 'boolean' } }, required: [...at.required, 'text'] },
    },
    {
      name: 'swipe',
      description: "Swipe from a point, or from the screen's center. up moves the finger up, which scrolls content down.",
      parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, ...at.properties }, required: ['direction'] },
    },
    { name: 'press_key', description: 'Press a key on the focused field.', parameters: { type: 'object', properties: { key: { type: 'string', enum: ['enter', 'backspace'] } }, required: ['key'] } },
    { name: 'open_url', description: platform === 'web' ? 'Load a URL in the current tab.' : 'Open a URL or deep link on the device.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'done', description: 'Finish the task.', parameters: { type: 'object', properties: { success: { type: 'boolean' }, reason: { type: 'string' } }, required: ['success', 'reason'] } },
  ];
  if (platform !== 'ios') tools.splice(4, 0, { name: 'back', description: platform === 'web' ? 'Go back in browser history.' : 'Press the Android back button.', parameters: { type: 'object', properties: {} } });
  return tools;
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new VerifyError('INVALID_ARGUMENT', `localAgent() ${name} must be an integer from ${min} to ${max}.`);
  return value;
}
