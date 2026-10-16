import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';
import { glob } from 'tinyglobby';
import { Agent } from './agent.js';
import type { RevylClient } from './api/client.js';
import type { Platform } from './api/types.js';
import { App, type Attachment } from './app.js';
import type { ResolvedConfig, ResolvedTarget } from './config.js';
import { VerifyError, errorMessage, isVerifyError } from './errors.js';
import { createScreen } from './locator.js';
import { Collector, hooksFor, setCollector, type TestCase, type TestFixtures } from './registry.js';
import { RevylSession } from './session.js';
import { StepRecorder, type StepRecord } from './steps.js';

export type TestStatus = 'passed' | 'failed' | 'flaky' | 'skipped' | 'interrupted';

export interface ErrorInfo {
  code?: string;
  message: string;
  stack?: string;
}

export interface AttemptResult {
  status: 'passed' | 'failed' | 'interrupted';
  durationMs: number;
  error?: ErrorInfo;
  sessionId?: string;
  viewerUrl?: string;
  steps: StepRecord[];
  attachments: Attachment[];
}

export interface TestResult {
  id: string;
  title: string;
  titlePath: string[];
  file: string;
  target: string;
  platform: Platform;
  status: TestStatus;
  durationMs: number;
  attempts: AttemptResult[];
}

export interface RunSummary {
  status: 'passed' | 'failed' | 'interrupted';
  startedAt: string;
  durationMs: number;
  stats: { total: number; passed: number; failed: number; flaky: number; skipped: number; interrupted: number };
  tests: TestResult[];
  errors: ErrorInfo[];
}

export interface Reporter {
  onBegin?(info: { total: number; targets: string[]; workers: number }): void;
  onProgress?(message: string): void;
  onTestEnd?(result: TestResult): void;
  onEnd?(summary: RunSummary): Promise<void> | void;
}

export interface Job {
  id: string;
  test: TestCase;
  target: ResolvedTarget;
  file: string;
}

export interface Selection {
  /** Substrings of test file paths, relative to the config. */
  files?: string[];
  grep?: RegExp;
  targets?: string[];
  forbidOnly?: boolean;
}

export interface RunOptions extends Selection {
  config: ResolvedConfig;
  client: RevylClient;
  reporters: Reporter[];
  workers?: number;
  retries?: number;
  signal?: AbortSignal;
}

const SETTLE_AFTER_ABORT_MS = 10_000;
const FAILURE_SCREENSHOT_TIMEOUT_MS = 15_000;
const NO_SCREENSHOT_CODES = new Set(['SESSION_ENDED', 'SESSION_START_FAILED', 'CANCELLED', 'AUTH_REJECTED']);

/** Finds test files, loads them, and expands each test across its targets. */
export async function collectJobs(config: ResolvedConfig, selection: Selection = {}): Promise<{ jobs: Job[]; skipped: Job[] }> {
  const targetNames = config.targets.map((target) => target.name);
  for (const name of selection.targets ?? []) {
    if (!targetNames.includes(name)) {
      throw new VerifyError('CONFIG_INVALID', `--target ${name} is not in ${config.configFile}. Targets: ${targetNames.join(', ')}.`);
    }
  }
  const outputRelative = relative(config.rootDir, config.outputDir);
  const files = (
    await glob(config.tests, {
      cwd: config.rootDir,
      absolute: true,
      ignore: ['**/node_modules/**', ...(outputRelative && !outputRelative.startsWith('..') ? [`${outputRelative}/**`] : [])],
    })
  )
    .filter((file) => !selection.files?.length || selection.files.some((filter) => relative(config.rootDir, file).includes(filter)))
    .sort();
  if (files.length === 0) {
    throw new VerifyError('NO_TESTS', `No test files matched ${config.tests.join(', ')}${selection.files?.length ? ` and ${selection.files.join(', ')}` : ''} in ${config.rootDir}.`);
  }

  const jiti = createJiti(config.configFile, { moduleCache: false, interopDefault: true });
  const tests: TestCase[] = [];
  for (const file of files) {
    const collector = new Collector(file);
    setCollector(collector);
    try {
      await jiti.import(file);
    } catch (error) {
      if (isVerifyError(error)) throw new VerifyError(error.code, `${relative(config.rootDir, file)}: ${error.message}`, { cause: error });
      throw new VerifyError('COLLECTION_ERROR', `Could not load ${relative(config.rootDir, file)}: ${errorMessage(error)}`, { cause: error });
    } finally {
      setCollector(undefined);
    }
    tests.push(...collector.tests);
  }

  for (const testCase of tests) {
    for (const name of testCase.options.targets ?? []) {
      if (!targetNames.includes(name)) {
        throw new VerifyError(
          'COLLECTION_ERROR',
          `${relative(config.rootDir, testCase.file)} › ${testCase.titlePath.join(' › ')} names target "${name}", which is not configured. Targets: ${targetNames.join(', ')}.`,
        );
      }
    }
  }
  const focused = tests.filter((testCase) => testCase.mode === 'only');
  if (focused.length > 0 && selection.forbidOnly) {
    const where = focused.map((testCase) => `${relative(config.rootDir, testCase.file)} › ${testCase.titlePath.join(' › ')}`).join('; ');
    throw new VerifyError('ONLY_IN_CI', `test.only is not allowed in CI: ${where}`);
  }

  const jobs: Job[] = [];
  const skipped: Job[] = [];
  for (const target of config.targets) {
    if (selection.targets?.length && !selection.targets.includes(target.name)) continue;
    for (const testCase of tests) {
      if (testCase.options.targets && !testCase.options.targets.includes(target.name)) continue;
      const file = relative(config.rootDir, testCase.file);
      if (selection.grep && !selection.grep.test([file, ...testCase.titlePath, target.name].join(' '))) continue;
      const job: Job = { id: jobId(file, testCase.titlePath, target.name), test: testCase, target, file };
      const runnable = testCase.mode !== 'skip' && (focused.length === 0 || testCase.mode === 'only');
      (runnable ? jobs : skipped).push(job);
    }
  }
  return { jobs, skipped };
}

export async function runTests(options: RunOptions): Promise<RunSummary> {
  const { config, client, reporters } = options;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const emit = (event: (reporter: Reporter) => void): void => reporters.forEach(event);
  const results: TestResult[] = [];
  const errors: ErrorInfo[] = [];

  let selection: { jobs: Job[]; skipped: Job[] };
  try {
    selection = await collectJobs(config, options);
  } catch (error) {
    errors.push(toErrorInfo(error));
    const summary = summarize(results, errors, startedAt, startedAtMs, false);
    for (const reporter of reporters) await reporter.onEnd?.(summary);
    return summary;
  }

  const workers = Math.max(1, Math.min(options.workers ?? config.workers, selection.jobs.length || 1));
  emit((reporter) =>
    reporter.onBegin?.({
      total: selection.jobs.length + selection.skipped.length,
      targets: [...new Set([...selection.jobs, ...selection.skipped].map((job) => job.target.name))],
      workers,
    }),
  );
  for (const job of selection.skipped) {
    const result = emptyResult(job, 'skipped');
    results.push(result);
    emit((reporter) => reporter.onTestEnd?.(result));
  }

  await rm(join(config.outputDir, 'artifacts'), { recursive: true, force: true });
  const queue = [...selection.jobs];
  const retries = options.retries ?? config.retries;
  const runSignal = options.signal;
  const live = new Set<RevylSession>();

  const worker = async (): Promise<void> => {
    const sessions = new Map<string, RevylSession>();
    const release = async (targetName: string): Promise<void> => {
      const held = sessions.get(targetName);
      sessions.delete(targetName);
      if (!held) return;
      live.delete(held);
      await held.stop().catch((error: unknown) => emit((reporter) => reporter.onProgress?.(`Could not stop the ${targetName} session: ${errorMessage(error)}`)));
    };
    const acquire = async (target: ResolvedTarget, signal: AbortSignal | undefined): Promise<RevylSession> => {
      const held = sessions.get(target.name);
      if (held && config.reuseSessions) {
        try {
          await held.resetForNextTest(signal);
          return held;
        } catch (error) {
          emit((reporter) => reporter.onProgress?.(`${target.name}: could not reset the session (${errorMessage(error)}); starting a new one.`));
          await release(target.name);
        }
      } else if (held) {
        await release(target.name);
      }
      const session = await RevylSession.start(client, target, {
        ...(signal ? { signal } : {}),
        onProgress: (message) => emit((reporter) => reporter.onProgress?.(message)),
      });
      live.add(session);
      sessions.set(target.name, session);
      return session;
    };

    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (runSignal?.aborted) {
          queue.unshift(job);
          break;
        }
        const attempts: AttemptResult[] = [];
        const allowed = (job.test.options.retries ?? retries) + 1;
        while (attempts.length < allowed) {
          const attempt = await runAttempt(job, attempts.length + 1, { config, acquire, release, signal: runSignal });
          attempts.push(attempt);
          if (attempt.status !== 'failed') break;
        }
        const last = attempts[attempts.length - 1]!;
        const status: TestStatus =
          last.status === 'passed' ? (attempts.length > 1 ? 'flaky' : 'passed') : last.status === 'interrupted' ? 'interrupted' : 'failed';
        const result: TestResult = {
          ...emptyResult(job, status),
          durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
          attempts,
        };
        results.push(result);
        emit((reporter) => reporter.onTestEnd?.(result));
        if (!queue.some((queued) => queued.target.name === job!.target.name)) await release(job.target.name);
      }
    } finally {
      await Promise.all([...sessions.keys()].map((name) => release(name)));
    }
  };

  try {
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    await Promise.allSettled([...live].map((session) => session.stop()));
  }
  for (const job of queue) {
    const result = emptyResult(job, 'interrupted');
    results.push(result);
    emit((reporter) => reporter.onTestEnd?.(result));
  }

  const summary = summarize(results, errors, startedAt, startedAtMs, runSignal?.aborted ?? false);
  for (const reporter of reporters) await reporter.onEnd?.(summary);
  return summary;
}

interface AttemptContext {
  config: ResolvedConfig;
  acquire(target: ResolvedTarget, signal: AbortSignal | undefined): Promise<RevylSession>;
  release(targetName: string): Promise<void>;
  signal: AbortSignal | undefined;
}

async function runAttempt(job: Job, attemptNumber: number, context: AttemptContext): Promise<AttemptResult> {
  const { config } = context;
  const startedAt = Date.now();
  const steps = new StepRecorder();
  const attachments: Attachment[] = [];
  const attachmentDir = join(config.outputDir, 'artifacts', artifactSlug(job), `attempt-${attemptNumber}`);
  const finish = (status: AttemptResult['status'], session: RevylSession | undefined, error?: unknown): AttemptResult => ({
    status,
    durationMs: Date.now() - startedAt,
    ...(error !== undefined ? { error: toErrorInfo(error) } : {}),
    ...(session ? { sessionId: session.id, viewerUrl: session.viewerUrl } : {}),
    steps: steps.root,
    attachments,
  });

  let session: RevylSession;
  try {
    session = await context.acquire(job.target, context.signal);
  } catch (error) {
    return finish(context.signal?.aborted ? 'interrupted' : 'failed', undefined, error);
  }

  const timeoutMs = job.test.options.timeout ?? config.timeout;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout.signal]) : timeout.signal;
  const sessionRef = async (): Promise<RevylSession> => session;
  const fixtures: TestFixtures = {
    screen: createScreen({
      platform: session.platform,
      actionTimeout: config.actionTimeout,
      assertionTimeout: config.assertionTimeout,
      session: sessionRef,
      signal: () => signal,
      steps,
    }),
    agent: new Agent({ agentTimeout: config.agentTimeout, session: sessionRef, signal: () => signal, steps }),
    app: new App({ session, signal: () => signal, steps, attachmentDir, attachments }),
    target: { name: job.target.name, platform: job.target.platform },
    step: (title, body) => steps.run(title, () => body()),
  };
  const hooks = hooksFor(job.test);
  const body = (async () => {
    let failure: unknown;
    try {
      for (const hook of hooks.beforeEach) await hook(fixtures);
      await job.test.body(fixtures);
    } catch (error) {
      failure = error;
    }
    for (const hook of hooks.afterEach) {
      try {
        await hook(fixtures);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  })();
  body.catch(() => undefined);
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error('aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => undefined);

  try {
    await Promise.race([body, aborted]);
    return finish('passed', session);
  } catch (raw) {
    let error = raw;
    if (signal.aborted) {
      await Promise.race([body.catch(() => undefined), delay(SETTLE_AFTER_ABORT_MS)]);
      error = context.signal?.aborted
        ? new VerifyError('CANCELLED', 'The run was interrupted.')
        : new VerifyError('TIMEOUT', `Test timed out after ${timeoutMs} ms.`);
    }
    if (context.signal?.aborted) {
      return finish('interrupted', session, error);
    }
    const code = isVerifyError(error) ? error.code : undefined;
    if (!code || !NO_SCREENSHOT_CODES.has(code)) {
      await captureFailure(session, attachmentDir, attachments);
    }
    if (code === 'SESSION_ENDED' || code === 'ACTION_UNCERTAIN') await context.release(job.target.name);
    return finish('failed', session, error);
  } finally {
    clearTimeout(timer);
    if (!config.reuseSessions) await context.release(job.target.name);
  }
}

async function captureFailure(session: RevylSession, attachmentDir: string, attachments: Attachment[]): Promise<void> {
  try {
    const png = await session.screenshot(AbortSignal.timeout(FAILURE_SCREENSHOT_TIMEOUT_MS));
    await mkdir(attachmentDir, { recursive: true });
    const path = join(attachmentDir, 'failure.png');
    await writeFile(path, png);
    attachments.push({ name: 'failure.png', path, contentType: 'image/png' });
  } catch {
    return;
  }
}

function emptyResult(job: Job, status: TestStatus): TestResult {
  return {
    id: job.id,
    title: job.test.title,
    titlePath: job.test.titlePath,
    file: job.file,
    target: job.target.name,
    platform: job.target.platform,
    status,
    durationMs: 0,
    attempts: [],
  };
}

function summarize(results: TestResult[], errors: ErrorInfo[], startedAt: string, startedAtMs: number, interrupted: boolean): RunSummary {
  const count = (status: TestStatus): number => results.filter((result) => result.status === status).length;
  const stats = {
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    flaky: count('flaky'),
    skipped: count('skipped'),
    interrupted: count('interrupted'),
  };
  const status = interrupted || stats.interrupted > 0 ? 'interrupted' : stats.failed > 0 || errors.length > 0 ? 'failed' : 'passed';
  return { status, startedAt, durationMs: Date.now() - startedAtMs, stats, tests: results, errors };
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (isVerifyError(error)) return { code: error.code, message: error.message };
  if (error instanceof Error) {
    return { message: error.message, ...(error.stack ? { stack: error.stack.split('\n').slice(0, 12).join('\n') } : {}) };
  }
  return { message: String(error) };
}

function jobId(file: string, titlePath: string[], target: string): string {
  return createHash('sha256').update([file, ...titlePath, target].join('\u0000')).digest('hex').slice(0, 12);
}

function artifactSlug(job: Job): string {
  const readable = [job.target.name, job.file.replace(/\.verify\.[mc]?[jt]s$/, ''), ...job.test.titlePath]
    .join('-')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 100);
  return `${readable}-${job.id.slice(0, 6)}`;
}
