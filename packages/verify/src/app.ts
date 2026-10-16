import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Platform } from './api/types.js';
import { VerifyError } from './errors.js';
import type { RevylSession } from './session.js';
import type { StepRecorder } from './steps.js';

export type Direction = 'up' | 'down' | 'left' | 'right';

export type Key =
  | 'Enter'
  | 'Backspace'
  | 'Tab'
  | 'Escape'
  | 'Delete'
  | 'Space'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown';

const MOBILE_KEYS: ReadonlySet<Key> = new Set(['Enter', 'Backspace']);
const WEB_KEYS: ReadonlySet<Key> = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
const OPPOSITE: Record<Direction, Direction> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const DEFAULT_SCROLL_PX = 600;
const MAX_WAIT_MS = 600_000;

export interface Attachment {
  name: string;
  path: string;
  contentType: 'image/png';
}

export interface AppContext {
  session: RevylSession;
  signal(): AbortSignal | undefined;
  steps: StepRecorder;
  attachmentDir: string;
  attachments: Attachment[];
}

/** Device- and browser-level controls for the app under test. */
export class App {
  constructor(private readonly context: AppContext) {}

  get platform(): Platform {
    return this.context.session.platform;
  }

  /** The Revyl session id, for linking a run to its recording. */
  get sessionId(): string {
    return this.context.session.id;
  }

  /** Watch the session live, or its recording afterwards, in Revyl. */
  get viewerUrl(): string {
    return this.context.session.viewerUrl;
  }

  /** Launches the app under test. iOS and Android. */
  async launch(): Promise<void> {
    await this.step('app.launch', () => this.context.session.launchApp(this.context.signal()));
  }

  /** Force-closes the app under test. iOS and Android. */
  async close(): Promise<void> {
    await this.step('app.close', () => this.context.session.killApp(this.context.signal()));
  }

  /** Starts the app again from a clean launch on mobile, or reopens the start URL on web. */
  async restart(): Promise<void> {
    await this.step('app.restart', () => this.context.session.resetForNextTest(this.context.signal()));
  }

  /** Opens a deep link on mobile, or navigates the browser on web. */
  async openUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new VerifyError('INVALID_ARGUMENT', `openUrl() takes an absolute URL or deep link; got ${JSON.stringify(url)}.`);
    }
    if (this.platform === 'web' && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new VerifyError('INVALID_ARGUMENT', 'openUrl() on web takes an http or https URL.');
    }
    await this.step(`app.openUrl: ${parsed.origin === 'null' ? parsed.protocol : parsed.origin}`, () =>
      this.context.session.perform('open_url', { url }, this.context.signal()),
    );
  }

  /** The system back button on Android, or browser history back on web. iOS has no system back. */
  async back(): Promise<void> {
    if (this.platform === 'ios') {
      throw new VerifyError(
        'NOT_AVAILABLE_ON_PLATFORM',
        "app.back() is not available on iOS, which has no system back button. Tap the app's own back button, for example screen.getByLabel('Back').tap().",
      );
    }
    await this.step('app.back', () => this.context.session.perform('back', {}, this.context.signal()));
  }

  /** Reloads the page. Web only. */
  async reload(): Promise<void> {
    this.context.session.requireWeb('app.reload()');
    await this.step('app.reload', () => this.context.session.perform('reload', {}, this.context.signal()));
  }

  /** Presses one key. iOS and Android support Enter and Backspace; web supports every listed key. */
  async pressKey(key: Key): Promise<void> {
    const supported = this.platform === 'web' ? WEB_KEYS : MOBILE_KEYS;
    if (!supported.has(key)) {
      throw new VerifyError(
        WEB_KEYS.has(key) ? 'NOT_AVAILABLE_ON_PLATFORM' : 'INVALID_ARGUMENT',
        `pressKey('${key}') is not available on ${this.platform}. Supported keys: ${[...supported].join(', ')}.`,
      );
    }
    await this.step(`app.pressKey: ${key}`, () =>
      this.context.session.perform('key', { key: key.toUpperCase() }, this.context.signal()),
    );
  }

  /** A swipe gesture across the middle of the screen, or from a given point. */
  async swipe(direction: Direction, options: { from?: { x: number; y: number }; durationMs?: number } = {}): Promise<void> {
    if (!(direction in OPPOSITE)) throw new VerifyError('INVALID_ARGUMENT', "swipe() takes 'up', 'down', 'left', or 'right'.");
    const from = options.from ?? (await this.screenCenter());
    await this.step(`app.swipe: ${direction}`, () =>
      this.context.session.perform(
        'swipe',
        { direction, x: Math.round(from.x), y: Math.round(from.y), duration_ms: options.durationMs ?? 500 },
        this.context.signal(),
      ),
    );
  }

  /** Scrolls the content: a wheel scroll on web, an opposite swipe on mobile. */
  async scroll(direction: Direction, options: { amount?: number } = {}): Promise<void> {
    if (!(direction in OPPOSITE)) throw new VerifyError('INVALID_ARGUMENT', "scroll() takes 'up', 'down', 'left', or 'right'.");
    if (this.platform !== 'web') {
      await this.swipe(OPPOSITE[direction]);
      return;
    }
    const amount = options.amount ?? DEFAULT_SCROLL_PX;
    if (!Number.isInteger(amount) || amount < 1 || amount > 16_384) {
      throw new VerifyError('INVALID_ARGUMENT', 'scroll() takes an amount from 1 to 16384 pixels.');
    }
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    await this.step(`app.scroll: ${direction}`, () => this.context.session.perform('scroll', { dx, dy }, this.context.signal()));
  }

  /** Saves a PNG of the screen into the run's output folder and attaches it to the report. */
  async screenshot(name = 'screenshot'): Promise<string> {
    const fileName = `${name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'screenshot'}-${this.context.attachments.length + 1}.png`;
    const path = join(this.context.attachmentDir, fileName);
    await this.step(`app.screenshot: ${fileName}`, async () => {
      const png = await this.context.session.screenshot(this.context.signal());
      await mkdir(this.context.attachmentDir, { recursive: true });
      await writeFile(path, png);
    });
    this.context.attachments.push({ name: fileName, path, contentType: 'image/png' });
    return path;
  }

  /** Waits a fixed time. Prefer expect() or locator.waitFor(), which wait only as long as needed. */
  async wait(ms: number): Promise<void> {
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) {
      throw new VerifyError('INVALID_ARGUMENT', `wait() takes 0 to ${MAX_WAIT_MS} ms.`);
    }
    await delay(ms, undefined, { signal: this.context.signal() });
  }

  private async screenCenter(): Promise<{ x: number; y: number }> {
    const size = await this.context.session.readScreenSize(this.context.signal());
    return { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) };
  }

  private async step(title: string, body: () => Promise<unknown>): Promise<void> {
    await this.context.steps.run(title, async () => {
      await body();
    });
  }
}
