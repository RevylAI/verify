import type { Agent } from './agent.js';
import type { App } from './app.js';
import type { Platform } from './api/types.js';
import { VerifyError } from './errors.js';
import type { Screen } from './locator.js';

export interface TestFixtures {
  /** Finds elements on screen: native iOS and Android elements, or AI grounding on web. */
  screen: Screen;
  /** Natural-language steps run by Revyl's agent: act, assert, extract. */
  agent: Agent;
  /** App and device controls: launch, openUrl, back, swipe, screenshot. */
  app: App;
  /** The configured target this run of the test uses. */
  target: { name: string; platform: Platform };
  /** Groups the actions inside it under one titled step in the report. */
  step<T>(title: string, body: () => Promise<T>): Promise<T>;
}

export type TestBody = (fixtures: TestFixtures) => Promise<void> | void;

export interface TestOptions {
  /** Run only on these target names. Defaults to every configured target. */
  targets?: string[];
  /** Milliseconds for this test, overriding the config timeout. */
  timeout?: number;
  /** Retries for this test, overriding the config. */
  retries?: number;
}

export interface Suite {
  title: string;
  parent: Suite | undefined;
  beforeEach: TestBody[];
  afterEach: TestBody[];
}

export interface TestCase {
  title: string;
  titlePath: string[];
  file: string;
  body: TestBody;
  options: TestOptions;
  mode: 'run' | 'only' | 'skip';
  suite: Suite;
}

export class Collector {
  readonly tests: TestCase[] = [];
  readonly root: Suite = { title: '', parent: undefined, beforeEach: [], afterEach: [] };
  current: Suite = this.root;

  constructor(readonly file: string) {}
}

const COLLECTOR = Symbol.for('revyl.verify.collector');

type GlobalWithCollector = typeof globalThis & { [COLLECTOR]?: Collector };

export function setCollector(collector: Collector | undefined): void {
  (globalThis as GlobalWithCollector)[COLLECTOR] = collector;
}

function activeCollector(api: string): Collector {
  const collector = (globalThis as GlobalWithCollector)[COLLECTOR];
  if (!collector) {
    throw new VerifyError(
      'COLLECTION_ERROR',
      `${api} must be called at the top level of a test file run by 'verify run', not inside a test or from another program.`,
    );
  }
  return collector;
}

function titlePath(suite: Suite): string[] {
  const path: string[] = [];
  for (let current: Suite | undefined = suite; current?.parent; current = current.parent) path.unshift(current.title);
  return path;
}

function validTitle(title: unknown, api: string): string {
  if (typeof title !== 'string' || title.trim() === '' || title.length > 300) {
    throw new VerifyError('COLLECTION_ERROR', `${api} needs a title of 1 to 300 characters.`);
  }
  return title.trim();
}

function declare(mode: TestCase['mode']) {
  const api = mode === 'run' ? 'test()' : `test.${mode}()`;
  function declareTest(title: string, body: TestBody): void;
  function declareTest(title: string, options: TestOptions, body: TestBody): void;
  function declareTest(title: string, optionsOrBody: TestOptions | TestBody, maybeBody?: TestBody): void {
    const collector = activeCollector(api);
    const body = typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody;
    const options = typeof optionsOrBody === 'function' ? {} : (optionsOrBody ?? {});
    if (typeof body !== 'function') throw new VerifyError('COLLECTION_ERROR', `${api} needs a test function.`);
    validateOptions(options, api);
    const name = validTitle(title, api);
    const path = [...titlePath(collector.current), name];
    if (collector.tests.some((existing) => existing.titlePath.join('\u0000') === path.join('\u0000'))) {
      throw new VerifyError('COLLECTION_ERROR', `Two tests in ${collector.file} are named "${path.join(' › ')}". Give each a unique title.`);
    }
    collector.tests.push({ title: name, titlePath: path, file: collector.file, body, options, mode, suite: collector.current });
  }
  return declareTest;
}

function validateOptions(options: TestOptions, api: string): void {
  if (typeof options !== 'object' || options === null) throw new VerifyError('COLLECTION_ERROR', `${api} options must be an object.`);
  for (const key of Object.keys(options)) {
    if (!['targets', 'timeout', 'retries'].includes(key)) throw new VerifyError('COLLECTION_ERROR', `${api} has an unknown option "${key}".`);
  }
  if (options.targets !== undefined && (!Array.isArray(options.targets) || options.targets.some((name) => typeof name !== 'string'))) {
    throw new VerifyError('COLLECTION_ERROR', `${api} option targets must be a list of target names.`);
  }
  if (options.timeout !== undefined && (!Number.isInteger(options.timeout) || options.timeout < 1_000)) {
    throw new VerifyError('COLLECTION_ERROR', `${api} option timeout must be an integer of at least 1000 ms.`);
  }
  if (options.retries !== undefined && (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 10)) {
    throw new VerifyError('COLLECTION_ERROR', `${api} option retries must be an integer from 0 to 10.`);
  }
}

function describe(title: string, body: () => void): void {
  const collector = activeCollector('test.describe()');
  if (typeof body !== 'function') throw new VerifyError('COLLECTION_ERROR', 'test.describe() needs a function.');
  const parent = collector.current;
  collector.current = { title: validTitle(title, 'test.describe()'), parent, beforeEach: [], afterEach: [] };
  try {
    const result: unknown = body();
    if (result instanceof Promise) {
      throw new VerifyError('COLLECTION_ERROR', 'test.describe() callbacks must be synchronous; declare tests directly inside them.');
    }
  } finally {
    collector.current = parent;
  }
}

function hook(kind: 'beforeEach' | 'afterEach') {
  return (body: TestBody): void => {
    const collector = activeCollector(`test.${kind}()`);
    if (typeof body !== 'function') throw new VerifyError('COLLECTION_ERROR', `test.${kind}() needs a function.`);
    collector.current[kind].push(body);
  };
}

export const test = Object.assign(declare('run'), {
  /** Runs only the tests marked with test.only in this run. Rejected in CI. */
  only: declare('only'),
  /** Declares a test without running it. */
  skip: declare('skip'),
  /** Groups tests under a shared title and hooks. */
  describe,
  /** Runs before every test in the current describe block and its children. */
  beforeEach: hook('beforeEach'),
  /** Runs after every test in the current describe block and its children, even when the test fails. */
  afterEach: hook('afterEach'),
});

/** Hooks from the outermost describe block inward, for one test. */
export function hooksFor(testCase: TestCase): { beforeEach: TestBody[]; afterEach: TestBody[] } {
  const chain: Suite[] = [];
  for (let suite: Suite | undefined = testCase.suite; suite; suite = suite.parent) chain.unshift(suite);
  return {
    beforeEach: chain.flatMap((suite) => suite.beforeEach),
    afterEach: chain.reverse().flatMap((suite) => suite.afterEach),
  };
}
