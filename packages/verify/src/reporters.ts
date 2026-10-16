import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { VERSION } from './version.js';
import type { Reporter, RunSummary, TestResult } from './runner.js';
import type { StepRecord } from './steps.js';

export interface Output {
  write(text: string): unknown;
  isTTY?: boolean;
}

const SYMBOLS: Record<TestResult['status'], string> = {
  passed: '✓',
  flaky: '✓',
  failed: '✗',
  skipped: '-',
  interrupted: '!',
};

/** Prints one line per test as it finishes, then each failure with its session link and screenshot. */
export class ListReporter implements Reporter {
  private readonly color: boolean;

  constructor(
    private readonly out: Output = process.stdout,
    private readonly cwd: string = process.cwd(),
  ) {
    this.color = Boolean(out.isTTY) && !process.env.NO_COLOR;
  }

  onBegin(info: { total: number; targets: string[]; workers: number }): void {
    const tests = info.total === 1 ? '1 test' : `${info.total} tests`;
    const workers = info.workers === 1 ? '1 worker' : `${info.workers} workers`;
    this.out.write(`\nRunning ${tests} on ${info.targets.join(', ')} with ${workers}\n\n`);
  }

  onProgress(message: string): void {
    this.out.write(this.paint('dim', `  ${message}\n`));
  }

  onTestEnd(result: TestResult): void {
    const color = result.status === 'failed' ? 'red' : result.status === 'passed' || result.status === 'flaky' ? 'green' : 'yellow';
    const suffix = result.status === 'flaky' ? this.paint('yellow', ` (flaky, passed on attempt ${result.attempts.length})`) : '';
    const duration = result.durationMs > 0 ? this.paint('dim', ` (${formatDuration(result.durationMs)})`) : '';
    this.out.write(`  ${this.paint(color, SYMBOLS[result.status])} [${result.target}] ${title(result)}${duration}${suffix}\n`);
  }

  onEnd(summary: RunSummary): void {
    for (const error of summary.errors) {
      this.out.write(`\n${this.paint('red', error.code ?? 'Error')}: ${error.message}\n`);
    }
    const failed = summary.tests.filter((result) => result.status === 'failed');
    failed.forEach((result, index) => {
      const attempt = result.attempts[result.attempts.length - 1];
      this.out.write(`\n  ${index + 1}) [${result.target}] ${title(result)}\n\n`);
      if (attempt?.error) {
        this.out.write(this.indent(`${this.paint('red', attempt.error.code ?? 'Error')}: ${attempt.error.message}`, 5));
        if (attempt.error.stack) this.out.write(this.indent(this.paint('dim', attempt.error.stack.split('\n').slice(1).join('\n')), 5));
      }
      const failedStep = attempt ? lastFailedStep(attempt.steps) : undefined;
      if (failedStep) this.out.write(this.indent(`Failed step: ${failedStep}`, 5));
      if (attempt?.viewerUrl) this.out.write(this.indent(`Session: ${attempt.viewerUrl}`, 5));
      for (const attachment of attempt?.attachments ?? []) {
        this.out.write(this.indent(`Screenshot: ${relative(this.cwd, attachment.path)}`, 5));
      }
    });
    const { stats } = summary;
    const parts = [
      stats.passed ? this.paint('green', `${stats.passed} passed`) : '',
      stats.flaky ? this.paint('yellow', `${stats.flaky} flaky`) : '',
      stats.failed ? this.paint('red', `${stats.failed} failed`) : '',
      stats.skipped ? this.paint('yellow', `${stats.skipped} skipped`) : '',
      stats.interrupted ? this.paint('yellow', `${stats.interrupted} interrupted`) : '',
    ].filter(Boolean);
    this.out.write(`\n  ${parts.length ? parts.join(', ') : 'No tests ran'} (${formatDuration(summary.durationMs)})\n\n`);
  }

  private indent(text: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return `${text
      .split('\n')
      .map((line) => pad + line)
      .join('\n')}\n`;
  }

  private paint(color: 'red' | 'green' | 'yellow' | 'dim', text: string): string {
    if (!this.color) return text;
    const codes = { red: 31, green: 32, yellow: 33, dim: 2 } as const;
    return `\u001b[${codes[color]}m${text}\u001b[0m`;
  }
}

/** Writes the whole run to <outputDir>/results.json for CI, dashboards, and coding agents. */
export class JsonReporter implements Reporter {
  constructor(private readonly path: string) {}

  static inDir(outputDir: string): JsonReporter {
    return new JsonReporter(join(outputDir, 'results.json'));
  }

  async onEnd(summary: RunSummary): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify({ schemaVersion: 1, verifyVersion: VERSION, ...summary }, null, 2)}\n`);
  }
}

function title(result: TestResult): string {
  return [result.file, ...result.titlePath].join(' › ');
}

function lastFailedStep(steps: StepRecord[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.status !== 'failed') continue;
    return lastFailedStep(step.steps) ?? step.title;
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`;
}
