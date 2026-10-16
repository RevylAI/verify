import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, inspect } from 'node:util';
import { VerifyError } from './errors.js';
import { isLocator, matchText, type Locator, type LocatorProbe, type TextMatcher } from './locator.js';

const POLL_MS = { native: 500, grounded: 1_000 };

export interface LocatorAssertions {
  /** Inverts the next assertion. */
  readonly not: LocatorAssertions;
  toBeVisible(options?: { timeout?: number }): Promise<void>;
  toBeHidden(options?: { timeout?: number }): Promise<void>;
  /** Native iOS and Android locators only. A string matches a case-insensitive substring unless exact is set. */
  toHaveText(text: TextMatcher, options?: { timeout?: number; exact?: boolean }): Promise<void>;
  /** Native iOS and Android locators only. */
  toBeEnabled(options?: { timeout?: number }): Promise<void>;
  /** Native iOS and Android locators only. */
  toHaveCount(count: number, options?: { timeout?: number }): Promise<void>;
}

export interface ValueAssertions {
  readonly not: ValueAssertions;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toMatch(expected: RegExp | string): void;
  toBeTruthy(): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThan(expected: number): void;
}

export function expect(actual: Locator): LocatorAssertions;
export function expect(actual: unknown): ValueAssertions;
export function expect(actual: unknown): LocatorAssertions | ValueAssertions {
  return isLocator(actual) ? locatorAssertions(actual, false) : valueAssertions(actual, false);
}

interface Check {
  name: string;
  nativeOnly: boolean;
  passes(probe: LocatorProbe, locator: Locator): boolean;
  describe(probe: LocatorProbe | undefined, locator: Locator): string;
}

function locatorAssertions(locator: Locator, negated: boolean): LocatorAssertions {
  const assert = (check: Check, timeout: number | undefined): Promise<void> => pollLocator(locator, check, negated, timeout);
  const visible: Check = {
    name: 'toBeVisible',
    nativeOnly: false,
    passes: (probe) => (probe.mode === 'grounded' ? probe.found : locator.pick(probe.elements) !== undefined),
    describe: (probe) => (probe ? `it was ${visibleNow(probe, locator) ? 'visible' : 'not visible'}` : 'nothing was observed'),
  };
  return {
    get not() {
      return locatorAssertions(locator, !negated);
    },
    toBeVisible: (options = {}) => assert(visible, options.timeout),
    toBeHidden: (options = {}) =>
      pollLocator(locator, { ...visible, name: 'toBeHidden', passes: (probe, l) => !visible.passes(probe, l) }, negated, options.timeout),
    toHaveText: (text, options = {}) =>
      assert(
        {
          name: `toHaveText(${text instanceof RegExp ? String(text) : JSON.stringify(text)})`,
          nativeOnly: true,
          passes: (probe) => {
            const element = probe.mode === 'native' ? locator.pick(probe.elements) : undefined;
            return element !== undefined && (matchText(element.text, text, options.exact ?? false) || matchText(element.label, text, options.exact ?? false));
          },
          describe: (probe) => {
            const element = probe?.mode === 'native' ? locator.pick(probe.elements) : undefined;
            return element ? `its text was ${JSON.stringify(element.text || element.label)}` : 'no element matched';
          },
        },
        options.timeout,
      ),
    toBeEnabled: (options = {}) =>
      assert(
        {
          name: 'toBeEnabled',
          nativeOnly: true,
          passes: (probe) => (probe.mode === 'native' ? locator.pick(probe.elements)?.enabled === true : false),
          describe: (probe) => {
            const element = probe?.mode === 'native' ? locator.pick(probe.elements) : undefined;
            return element ? `it was ${element.enabled ? 'enabled' : 'disabled'}` : 'no element matched';
          },
        },
        options.timeout,
      ),
    toHaveCount: (count, options = {}) => {
      if (!Number.isInteger(count) || count < 0) throw new VerifyError('INVALID_ARGUMENT', 'toHaveCount() takes a non-negative integer.');
      return assert(
        {
          name: `toHaveCount(${count})`,
          nativeOnly: true,
          passes: (probe) => probe.mode === 'native' && probe.elements.length === count,
          describe: (probe) => (probe?.mode === 'native' ? `it matched ${probe.elements.length}` : 'nothing was observed'),
        },
        options.timeout,
      );
    },
  };
}

async function pollLocator(locator: Locator, check: Check, negated: boolean, timeout: number | undefined): Promise<void> {
  const budget = timeout ?? locator.assertionTimeout;
  if (!Number.isInteger(budget) || budget < 0) throw new VerifyError('INVALID_ARGUMENT', 'An assertion timeout must be a non-negative integer.');
  const deadline = Date.now() + budget;
  const label = `expect(${locator})${negated ? '.not' : ''}.${check.name}`;
  let last: LocatorProbe | undefined;
  for (;;) {
    last = await locator.probe();
    if (check.nativeOnly && last.mode === 'grounded') {
      throw new VerifyError(
        'NOT_AVAILABLE_ON_PLATFORM',
        `${label} reads native element state, which ${locator} cannot provide because it is located by AI grounding. Use agent.assert() for this check.`,
      );
    }
    if (check.passes(last, locator) !== negated) return;
    if (Date.now() >= deadline) break;
    await delay(last.mode === 'grounded' ? POLL_MS.grounded : POLL_MS.native, undefined, { signal: locator.signal });
  }
  const hint =
    last.mode === 'native' && last.onScreenTexts.length > 0
      ? ` Text on screen: ${last.onScreenTexts.slice(0, 12).map((text) => JSON.stringify(text)).join(', ')}.`
      : '';
  throw new VerifyError('ASSERTION_FAILED', `${label} failed after ${budget} ms: ${check.describe(last, locator)}.${hint}`);
}

function visibleNow(probe: LocatorProbe, locator: Locator): boolean {
  return probe.mode === 'grounded' ? probe.found : locator.pick(probe.elements) !== undefined;
}

function valueAssertions(actual: unknown, negated: boolean): ValueAssertions {
  const check = (passed: boolean, name: string, ...expected: unknown[]): void => {
    if (passed !== negated) return;
    const argument = expected.length > 0 ? format(expected[0]) : '';
    throw new VerifyError('ASSERTION_FAILED', `expect(${format(actual)})${negated ? '.not' : ''}.${name}(${argument}) failed`);
  };
  return {
    get not() {
      return valueAssertions(actual, !negated);
    },
    toBe: (expected) => check(Object.is(actual, expected), 'toBe', expected),
    toEqual: (expected) => check(isDeepStrictEqual(actual, expected), 'toEqual', expected),
    toContain: (expected) => {
      if (typeof actual === 'string') return check(typeof expected === 'string' && actual.includes(expected), 'toContain', expected);
      if (Array.isArray(actual)) return check(actual.some((item) => isDeepStrictEqual(item, expected)), 'toContain', expected);
      throw new VerifyError('INVALID_ARGUMENT', 'toContain() needs a string or an array.');
    },
    toMatch: (expected) => {
      if (typeof actual !== 'string') throw new VerifyError('INVALID_ARGUMENT', 'toMatch() needs a string.');
      check(expected instanceof RegExp ? expected.test(actual) : actual.includes(expected), 'toMatch', expected);
    },
    toBeTruthy: () => check(Boolean(actual), 'toBeTruthy'),
    toBeGreaterThan: (expected) => check(typeof actual === 'number' && actual > expected, 'toBeGreaterThan', expected),
    toBeLessThan: (expected) => check(typeof actual === 'number' && actual < expected, 'toBeLessThan', expected),
  };
}

function format(value: unknown): string {
  return inspect(value, { depth: 3, breakLength: Infinity, maxStringLength: 200 });
}
