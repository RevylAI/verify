import { inspect } from 'node:util';
import { isVerifyError } from './errors.js';

interface OpenSession {
  readonly target: string;
  close(): Promise<void>;
}

type Listener = (...args: any[]) => void;

const CLOSE_ALL_TIMEOUT_MS = 15_000;
const open = new Set<OpenSession>();
const installed: Array<[string, Listener]> = [];
let exiting = false;

/**
 * Keeps Revyl sessions from outliving the script that opened them. While a session is open, Verify
 * closes it before the process ends: on Ctrl+C or SIGTERM, on an uncaught error, and when the script
 * finishes without calling close(). It only handles a signal or error event nobody else is listening
 * to, so test runners and apps that manage their own shutdown keep control of it.
 */
export function trackSession(session: OpenSession): void {
  open.add(session);
  if (installed.length === 0) install();
}

export function untrackSession(session: OpenSession): void {
  open.delete(session);
  if (open.size === 0 && !exiting) uninstall();
}

function install(): void {
  const listen = (event: string, listener: Listener, onlyIfUnhandled: boolean): void => {
    if (onlyIfUnhandled && process.listenerCount(event) > 0) return;
    process.on(event, listener);
    installed.push([event, listener]);
  };
  listen('SIGINT', () => onSignal(130), true);
  listen('SIGTERM', () => onSignal(143), true);
  listen('uncaughtException', (error: unknown) => onFatal(error), true);
  listen('unhandledRejection', (reason: unknown) => onFatal(reason), true);
  listen('beforeExit', onBeforeExit, false);
}

function uninstall(): void {
  for (const [event, listener] of installed.splice(0)) process.off(event, listener);
}

function onSignal(code: number): void {
  if (exiting) process.exit(code);
  process.stderr.write(`\n[verify] Closing ${describeOpen()} before exiting. Press Ctrl+C again to exit now.\n`);
  void exitAfterClosing(code);
}

function onFatal(error: unknown): void {
  if (exiting) return;
  process.stderr.write(`${isVerifyError(error) ? `${error.code}: ${error.message}` : inspect(error)}\n`);
  if (open.size > 0) process.stderr.write(`[verify] Closing ${describeOpen()} before exiting.\n`);
  void exitAfterClosing(1);
}

function onBeforeExit(): void {
  if (open.size === 0 || exiting) return;
  process.stderr.write(`[verify] Closing ${describeOpen()} the script left open. Call session.close() when you are done with a session.\n`);
  void closeAll();
}

async function exitAfterClosing(code: number): Promise<void> {
  exiting = true;
  await closeAll();
  process.exit(code);
}

async function closeAll(): Promise<void> {
  const closing = Promise.allSettled([...open].map((session) => session.close()));
  await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, CLOSE_ALL_TIMEOUT_MS).unref())]);
}

function describeOpen(): string {
  const names = [...open].map((session) => session.target);
  return names.length === 1 ? `the ${names[0]} session` : `${names.length} sessions (${names.join(', ')})`;
}
