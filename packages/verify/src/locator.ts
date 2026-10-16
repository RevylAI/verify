import { setTimeout as delay } from 'node:timers/promises';
import type { Platform } from './api/types.js';
import { VerifyError } from './errors.js';
import { center, isOnScreen, parseHierarchy, type UiElement } from './hierarchy.js';
import type { RevylSession } from './session.js';
import type { StepRecorder } from './steps.js';

export type Role = 'button' | 'textbox' | 'checkbox' | 'switch' | 'radio' | 'image' | 'link' | 'heading' | 'text';
export type TextMatcher = string | RegExp;

export type LocatorQuery =
  | { kind: 'text'; value: TextMatcher; exact: boolean }
  | { kind: 'label'; value: TextMatcher; exact: boolean }
  | { kind: 'testId'; value: string }
  | { kind: 'role'; role: Role; name?: TextMatcher; exact: boolean }
  | { kind: 'description'; value: string };

export interface LocatorContext {
  platform: Platform;
  actionTimeout: number;
  assertionTimeout: number;
  session(): Promise<RevylSession>;
  signal(): AbortSignal | undefined;
  steps: StepRecorder;
}

const LOCATOR_BRAND = Symbol.for('revyl.verify.locator');

export function isLocator(value: unknown): value is Locator {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[LOCATOR_BRAND] === true;
}

/** What a locator currently matches: native elements on iOS and Android, or a grounding verdict. */
export type LocatorProbe =
  | { mode: 'native'; elements: UiElement[]; onScreenTexts: string[] }
  | { mode: 'grounded'; found: boolean };

const NATIVE_POLL_MS = 500;
const GROUNDED_POLL_MS = 1_000;
const GROUNDING_MISS_CODES = ['target_not_found', 'grounding_failed', 'stale_target'];

export interface Screen {
  /** Text shown on screen. A string matches a case-insensitive substring unless exact is set. */
  getByText(text: TextMatcher, options?: { exact?: boolean }): Locator;
  /** The accessibility label: content-desc on Android, accessibilityLabel on iOS. */
  getByLabel(label: TextMatcher, options?: { exact?: boolean }): Locator;
  /** testID: the resource-id on Android (with or without its package prefix), accessibilityIdentifier on iOS. */
  getByTestId(testId: string): Locator;
  getByRole(role: Role, options?: { name?: TextMatcher; exact?: boolean }): Locator;
  /** An element described in plain words, located by Revyl's AI grounding model on any platform. */
  locate(description: string): Locator;
}

export function createScreen(context: LocatorContext): Screen {
  return {
    getByText: (value, options) => new Locator(context, { kind: 'text', value, exact: options?.exact ?? false }),
    getByLabel: (value, options) => new Locator(context, { kind: 'label', value, exact: options?.exact ?? false }),
    getByTestId: (value) => new Locator(context, { kind: 'testId', value }),
    getByRole: (role, options) =>
      new Locator(context, { kind: 'role', role, exact: options?.exact ?? false, ...(options?.name !== undefined ? { name: options.name } : {}) }),
    locate: (value) => {
      if (typeof value !== 'string' || value.trim() === '' || value.length > 1000) {
        throw new VerifyError('INVALID_ARGUMENT', 'screen.locate() takes a description of 1 to 1000 characters.');
      }
      return new Locator(context, { kind: 'description', value: value.trim() });
    },
  };
}

export class Locator {
  readonly [LOCATOR_BRAND] = true;

  constructor(
    private readonly context: LocatorContext,
    readonly query: LocatorQuery,
    private readonly index?: number,
  ) {}

  /** Selects one match by position; -1 is the last. Native iOS and Android locators only. */
  nth(index: number): Locator {
    if (!Number.isInteger(index)) throw new VerifyError('INVALID_ARGUMENT', 'nth() takes an integer.');
    return new Locator(this.context, this.query, index);
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return this.nth(-1);
  }

  get assertionTimeout(): number {
    return this.context.assertionTimeout;
  }

  get signal(): AbortSignal | undefined {
    return this.context.signal();
  }

  get grounded(): boolean {
    return this.query.kind === 'description' || this.context.platform === 'web';
  }

  toString(): string {
    const position = this.index === undefined ? '' : `.nth(${this.index})`;
    const q = this.query;
    switch (q.kind) {
      case 'text':
        return `getByText(${formatMatcher(q.value)})${position}`;
      case 'label':
        return `getByLabel(${formatMatcher(q.value)})${position}`;
      case 'testId':
        return `getByTestId(${JSON.stringify(q.value)})${position}`;
      case 'role':
        return `getByRole('${q.role}'${q.name !== undefined ? `, { name: ${formatMatcher(q.name)} }` : ''})${position}`;
      case 'description':
        return `locate(${JSON.stringify(q.value)})`;
    }
  }

  async tap(options: { timeout?: number } = {}): Promise<void> {
    await this.context.steps.run(`${this}.tap()`, async () => {
      const session = await this.context.session();
      const timeout = options.timeout ?? this.context.actionTimeout;
      if (this.grounded) {
        await this.groundedTap(session, timeout);
        return;
      }
      const element = await this.waitForElement(session, timeout);
      await session.perform('tap', center(element), this.context.signal());
    });
  }

  async doubleTap(options: { timeout?: number } = {}): Promise<void> {
    await this.context.steps.run(`${this}.doubleTap()`, async () => {
      const session = await this.context.session();
      const point = await this.point(session, options.timeout ?? this.context.actionTimeout);
      await session.perform('double_tap', point, this.context.signal());
    });
  }

  async longPress(options: { timeout?: number; durationMs?: number } = {}): Promise<void> {
    const durationMs = options.durationMs ?? 1_500;
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 5_000) {
      throw new VerifyError('INVALID_ARGUMENT', 'longPress() takes a durationMs from 0 to 5000.');
    }
    await this.context.steps.run(`${this}.longPress()`, async () => {
      const session = await this.context.session();
      const point = await this.point(session, options.timeout ?? this.context.actionTimeout);
      await session.perform('longpress', { ...point, duration_ms: durationMs }, this.context.signal());
    });
  }

  /** Types into the field, replacing its text unless clear is false. */
  async fill(text: string, options: { timeout?: number; clear?: boolean } = {}): Promise<void> {
    if (typeof text !== 'string' || text.length > 16_384) throw new VerifyError('INVALID_ARGUMENT', 'fill() takes a string of at most 16384 characters.');
    await this.context.steps.run(`${this}.fill()`, async () => {
      const session = await this.context.session();
      const point = await this.point(session, options.timeout ?? this.context.actionTimeout);
      await session.perform('input', { ...point, text, clear_first: options.clear ?? true }, this.context.signal());
    });
  }

  async textContent(options: { timeout?: number } = {}): Promise<string> {
    const session = await this.context.session();
    this.requireNative(session, 'textContent()');
    return (await this.waitForElement(session, options.timeout ?? this.context.actionTimeout)).text;
  }

  async isVisible(): Promise<boolean> {
    const probe = await this.probe();
    return probe.mode === 'grounded' ? probe.found : this.pick(probe.elements) !== undefined;
  }

  async isEnabled(options: { timeout?: number } = {}): Promise<boolean> {
    const session = await this.context.session();
    this.requireNative(session, 'isEnabled()');
    return (await this.waitForElement(session, options.timeout ?? this.context.actionTimeout)).enabled;
  }

  async count(): Promise<number> {
    const probe = await this.probe();
    if (probe.mode === 'grounded') {
      throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `count() needs a native iOS or Android locator; ${this} is located by AI grounding.`);
    }
    return probe.elements.length;
  }

  async waitFor(options: { state?: 'visible' | 'hidden'; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? 'visible';
    const timeout = options.timeout ?? this.context.actionTimeout;
    const deadline = Date.now() + timeout;
    for (;;) {
      if ((await this.isVisible()) === (state === 'visible')) return;
      if (Date.now() >= deadline) {
        throw new VerifyError(state === 'visible' ? 'LOCATOR_NOT_FOUND' : 'TIMEOUT', `${this} did not become ${state} within ${timeout} ms.`);
      }
      await this.pause();
    }
  }

  /** One observation of what the locator matches, for expect() and visibility checks. */
  async probe(): Promise<LocatorProbe> {
    const session = await this.context.session();
    if (this.grounded) {
      this.requireGroundable();
      const result = await session.resolveTarget(this.groundingDescription(), this.context.signal());
      return { mode: 'grounded', found: result.found };
    }
    const elements = parseHierarchy(await session.hierarchy(this.context.signal()), session.platform as 'ios' | 'android');
    const onScreen = elements.filter((element) => isOnScreen(element, session.screenSize));
    return {
      mode: 'native',
      elements: onScreen.filter((element) => this.matches(element)),
      onScreenTexts: [...new Set(onScreen.map((element) => element.text || element.label).filter(Boolean))],
    };
  }

  /** Index-aware selection from the probe's matches; undefined when nothing matches. */
  pick(elements: UiElement[]): UiElement | undefined {
    if (this.index === undefined) return elements[0];
    return this.index < 0 ? elements[elements.length + this.index] : elements[this.index];
  }

  groundingDescription(): string {
    const q = this.query;
    switch (q.kind) {
      case 'description':
        return q.value;
      case 'text':
        return q.exact ? `the text that reads exactly "${plain(q.value)}"` : `the text "${plain(q.value)}"`;
      case 'label':
        return `the element labeled "${plain(q.value)}"`;
      case 'role': {
        const noun = q.role === 'textbox' ? 'text field' : q.role;
        return q.name === undefined ? `the ${noun}` : `the "${plain(q.name)}" ${noun}`;
      }
      case 'testId':
        throw new VerifyError(
          'NOT_AVAILABLE_ON_PLATFORM',
          `getByTestId() reads native iOS and Android accessibility identifiers; Revyl web sessions expose no DOM. Use getByText(), getByRole(), or locate() on web.`,
        );
    }
  }

  private async groundedTap(session: RevylSession, timeout: number): Promise<void> {
    this.requireGroundable();
    const description = this.groundingDescription();
    const deadline = Date.now() + timeout;
    for (;;) {
      const result = await session.act(
        'tap_target',
        { target: description, ...(session.id ? { session_id: session.id } : {}) },
        { signal: this.context.signal(), acceptErrorCodes: GROUNDING_MISS_CODES },
      );
      if (result.success === true) return;
      if (result.execution_uncertain) {
        throw new VerifyError('ACTION_UNCERTAIN', `Tapping ${this} may or may not have happened; Verify does not repeat it. See ${session.viewerUrl}`);
      }
      const missed = result.found === false || (typeof result.error === 'string' && GROUNDING_MISS_CODES.includes(result.error));
      if (!missed) throw new VerifyError('ACTION_FAILED', `Tapping ${this} failed: ${result.error ?? 'no reason given'}`);
      if (Date.now() >= deadline) throw new VerifyError('LOCATOR_NOT_FOUND', `${this} was not found on screen within ${timeout} ms.`);
      await this.pause();
    }
  }

  private async point(session: RevylSession, timeout: number): Promise<Record<string, unknown>> {
    if (!this.grounded) return center(await this.waitForElement(session, timeout));
    this.requireGroundable();
    const description = this.groundingDescription();
    const deadline = Date.now() + timeout;
    for (;;) {
      const result = await session.resolveTarget(description, this.context.signal());
      if (result.found) {
        return { x: result.x, y: result.y, ...(session.platform === 'web' && result.screen_token ? { screen_token: result.screen_token } : {}) };
      }
      if (Date.now() >= deadline) throw new VerifyError('LOCATOR_NOT_FOUND', `${this} was not found on screen within ${timeout} ms.`);
      await this.pause();
    }
  }

  private async waitForElement(session: RevylSession, timeout: number): Promise<UiElement> {
    const deadline = Date.now() + timeout;
    let lastTexts: string[] = [];
    for (;;) {
      const probe = await this.probe();
      if (probe.mode === 'native') {
        lastTexts = probe.onScreenTexts;
        if (this.index === undefined && probe.elements.length > 1) {
          const candidates = probe.elements.slice(0, 5).map(describeElement).join('; ');
          throw new VerifyError(
            'LOCATOR_AMBIGUOUS',
            `${this} matches ${probe.elements.length} elements on the ${session.platform} screen (${candidates}). Narrow it, or pick one with first() or nth().`,
          );
        }
        const element = this.pick(probe.elements);
        if (element) return element;
      }
      if (Date.now() >= deadline) {
        const hint = lastTexts.length > 0 ? ` Text on screen: ${lastTexts.slice(0, 12).map((text) => JSON.stringify(text)).join(', ')}.` : '';
        throw new VerifyError('LOCATOR_NOT_FOUND', `${this} was not found on the ${session.platform} screen within ${timeout} ms.${hint}`);
      }
      await this.pause();
    }
  }

  private matches(element: UiElement): boolean {
    const q = this.query;
    switch (q.kind) {
      case 'text':
        return matchText(element.text, q.value, q.exact) || matchText(element.label, q.value, q.exact);
      case 'label':
        return matchText(element.label, q.value, q.exact);
      case 'testId':
        return element.testId === q.value || element.testId.endsWith(`:id/${q.value}`);
      case 'role':
        return (
          roleOf(element) === q.role &&
          (q.name === undefined || matchText(element.text, q.name, q.exact) || matchText(element.label, q.name, q.exact))
        );
      case 'description':
        return false;
    }
  }

  private requireNative(session: RevylSession, feature: string): void {
    if (this.grounded) {
      throw new VerifyError(
        'NOT_AVAILABLE_ON_PLATFORM',
        `${feature} reads native elements; ${this} on ${session.platform} is located by AI grounding, which finds a position but no text.`,
      );
    }
  }

  private requireGroundable(): void {
    if (this.index !== undefined) {
      throw new VerifyError('INVALID_ARGUMENT', `nth(), first() and last() need a native iOS or Android locator; describe the element instead.`);
    }
    const q = this.query;
    if ((q.kind === 'text' || q.kind === 'label') && q.value instanceof RegExp) {
      throw new VerifyError('INVALID_ARGUMENT', `${this}: regular expressions need a native iOS or Android locator; pass a string on web.`);
    }
    if (q.kind === 'role' && q.name instanceof RegExp) {
      throw new VerifyError('INVALID_ARGUMENT', `${this}: regular expressions need a native iOS or Android locator; pass a string on web.`);
    }
  }

  private async pause(): Promise<void> {
    await delay(this.grounded ? GROUNDED_POLL_MS : NATIVE_POLL_MS, undefined, { signal: this.context.signal() });
  }
}

export function matchText(actual: string, expected: TextMatcher, exact: boolean): boolean {
  if (expected instanceof RegExp) return expected.test(actual);
  if (exact) return actual.trim() === expected.trim();
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = normalize(expected);
  return needle !== '' && normalize(actual).includes(needle);
}

const ANDROID_ROLES: Array<[RegExp, Role]> = [
  [/(^|\.)(EditText|AutoCompleteTextView|TextInputEditText)$/, 'textbox'],
  [/(^|\.)(CheckBox|CheckedTextView)$/, 'checkbox'],
  [/(^|\.)(Switch|SwitchCompat|SwitchMaterial|ToggleButton)$/, 'switch'],
  [/(^|\.)RadioButton$/, 'radio'],
  [/(^|\.)(Button|ImageButton|MaterialButton|AppCompatButton)$/, 'button'],
  [/(^|\.)(ImageView|AppCompatImageView)$/, 'image'],
  [/(^|\.)(TextView|AppCompatTextView|MaterialTextView)$/, 'text'],
];

const IOS_ROLES: Record<string, Role> = {
  Button: 'button',
  TextField: 'textbox',
  SecureTextField: 'textbox',
  TextView: 'textbox',
  SearchField: 'textbox',
  CheckBox: 'checkbox',
  Switch: 'switch',
  RadioButton: 'radio',
  Image: 'image',
  Link: 'link',
  Heading: 'heading',
  StaticText: 'text',
};

export function roleOf(element: UiElement): Role | undefined {
  if (element.type.includes('.')) return ANDROID_ROLES.find(([pattern]) => pattern.test(element.type))?.[1];
  return IOS_ROLES[element.type.replace(/^AX/, '')];
}

function describeElement(element: UiElement): string {
  const name = element.text || element.label || element.testId;
  return `${element.type || 'element'}${name ? ` "${name}"` : ''} at ${element.rect.x},${element.rect.y}`;
}

function formatMatcher(value: TextMatcher): string {
  return value instanceof RegExp ? String(value) : JSON.stringify(value);
}

function plain(value: TextMatcher): string {
  return typeof value === 'string' ? value.replace(/"/g, "'") : value.source;
}
