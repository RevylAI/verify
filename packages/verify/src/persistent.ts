import { setTimeout as delay } from 'node:timers/promises';
import { RevylClient, edgeBlockedError, responseDetail, type RawResponse } from './api/client.js';
import type { ComputerReport } from './api/types.js';
import { ComputerSession, computerOperationId } from './computer-session.js';
import { trackSession } from './cleanup.js';
import { DEFAULT_STEP_TIMEOUT_MS } from './config.js';
import { VerifyError, type RefusalReason, type VerifyErrorCode } from './errors.js';
import { credentialsForUse, type OpenOptions } from './open.js';
import type { SessionOptions } from './session.js';

const BASE = '/api/v1/computer-runs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_RULE = "1-64 letters, digits, '.', '_' or '-', starting with a letter or digit, and not a UUID";
const NAMESPACE = 'c4c351c9-f19a-49b9-b0a9-632ef6c3f486';
const MAX_GENERATIONS = 100;
const STATES = new Set<string>(['starting', 'running', 'stopping', 'stopped']);
const SAVE_WAIT_MS = 600_000;
const REFUSED_START_CODES = new Set<VerifyErrorCode>(['AUTH_REJECTED', 'EDGE_BLOCKED', 'NOT_AVAILABLE_ON_PLATFORM', 'INVALID_ARGUMENT', 'COMPUTER_LIMIT', 'NOT_FOUND']);

/** Options shared by every persistent-computer call. */
export type PersistentOptions = Pick<OpenOptions, 'log' | 'backendUrl' | 'appUrl'>;

export interface PersistentOpenOptions extends PersistentOptions {
  /** Only when this call creates the computer: start its disk as this snapshot's (a name or ID from listSnapshots()). If the computer already exists it opens as it is; check `created`. */
  fromSnapshot?: string;
  /** How long this run may last before the computer stops itself (keeping its disk), in ms: whole seconds from 60000 to 86400000. Defaults to 2 hours. Not applied when the computer was already running. Same as timeoutMs on open('mac'). */
  timeoutMs?: number;
  /** How long openPersistent() waits for the computer to be ready, in ms from 10000 to 1800000. Defaults to 900000 (15 minutes). Covers waiting for an earlier stop to finish saving, and a start from a snapshot, which takes up to about 3 minutes. Same unit as startTimeout on open('mac'). */
  startTimeout?: number;
}

export interface SaveSnapshotOptions extends PersistentOptions {
  /** How long saveSnapshot() waits for the disk to be ready to snapshot, in ms from 1000 to 3600000. Defaults to 900000 (15 minutes). A disk is ready about 5-6 minutes after close() returns. */
  waitTimeout?: number;
}

export type PersistentComputerState = 'starting' | 'running' | 'stopping' | 'stopped';

export interface PersistentComputer {
  /** The computer's ID. It stays the same across every stop and start, and works wherever a name does. */
  id: string;
  state: PersistentComputerState;
  /** When its disk was last saved; undefined until its first stop finishes saving. */
  savedAt?: Date;
  /** Whether that save has been copied off the Mac that made it. saveSnapshot() needs this and waits for it. */
  savedOffHost: boolean;
  createdAt: Date;
}

export interface ComputerSnapshot {
  id: string;
  name: string;
  /** The persistent computer whose disk it saved. */
  computerId: string;
  savedAt: Date;
  /** When the save stops being usable, if it has an end. */
  expiresAt?: Date;
}

/**
 * A running persistent Mac. It has every method of the computer that open('mac') returns, such as exec(),
 * readFile(), writeFile(), screenshot() and extend(); relative file paths are inside the computer's workspace folder,
 * as on open('mac'). close(), and `await using`, stop it and keep its disk. id is the persistent computer's ID: it
 * stays the same across stops and starts and matches the id listPersistent() reports.
 */
export class PersistentComputerSession extends ComputerSession {
  /** The name (or ID) you passed to openPersistent(). */
  readonly name: string;
  /** True when this openPersistent() call created the computer; false when it already existed. */
  readonly created: boolean;
  private stopPromise: Promise<void> | undefined;

  private constructor(client: RevylClient, id: string, name: string, created: boolean, options: SessionOptions) {
    super(client, { name, platform: 'mac', startTimeout: SAVE_WAIT_MS }, options, id);
    this.name = name;
    this.created = created;
  }

  /**
   * Stops the computer and keeps its disk: files, installed tools and settings are there the next time you
   * openPersistent() it. Memory and running processes are not kept. Resolves once the disk is saved on its Mac,
   * which can take a few minutes. Verify also stops it this way if your script exits without calling close().
   * A snapshot of this disk can be saved about 5-6 minutes after close() returns; saveSnapshot() waits for that.
   */
  override close(): Promise<void> {
    this.stopPromise ??= super.close().then(() => this.awaitSaved());
    return this.stopPromise;
  }

  private async awaitSaved(): Promise<void> {
    const signal = AbortSignal.timeout(SAVE_WAIT_MS);
    try {
      for (;;) {
        const status = await readStatus(this.client, this.id, signal);
        if (status?.state === 'stopped') {
          this.log('stopped; disk saved');
          return;
        }
        if (status && status.state !== 'stopping') {
          this.log(`stopped; it was started again elsewhere (${status.state})`);
          return;
        }
        await delay(3_000, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      throw new VerifyError('TIMEOUT', `${this.name} is stopped, but saving its disk was not confirmed within ${SAVE_WAIT_MS} ms. The save continues on its own; listPersistent() shows it as stopped once done. See ${this.viewerUrl}`);
    }
  }

  static async open(client: RevylClient, name: string, options: PersistentOpenOptions, startTimeout: number, log: ((line: string) => void) | undefined): Promise<PersistentComputerSession> {
    const sessionOptions: SessionOptions = { stepTimeout: DEFAULT_STEP_TIMEOUT_MS, log, appUrl: options.appUrl };
    const deadline = AbortSignal.timeout(startTimeout);
    const found = await findComputer(client, name, deadline);
    const session = new PersistentComputerSession(client, found.id, name, found.status === undefined, sessionOptions);
    const signal = AbortSignal.any([deadline, session.lifetime.signal]);
    const lifetime = options.timeoutMs === undefined ? undefined : { timeout_seconds: options.timeoutMs / 1_000 };
    let started = false;
    let attempted = false;
    try {
      let first: ComputerReport;
      if (!found.status) {
        session.log(`creating persistent computer${options.fromSnapshot ? ` from snapshot ${options.fromSnapshot}` : ''} ${session.viewerUrl}`);
        attempted = true;
        const response = await call(client, 'POST', BASE, {
          body: { computer_session_id: found.id, os: 'macos', persistent: true, ...lifetime, ...(options.fromSnapshot ? { from_snapshot: options.fromSnapshot } : {}) },
          signal,
          retry: true,
          notFound: `There is no snapshot named or with the ID ${options.fromSnapshot}. listSnapshots() shows your organization's snapshots.`,
        });
        started = true;
        trackSession(session);
        first = session.parseReport(response);
      } else {
        if (options.fromSnapshot) session.log(`already exists, so fromSnapshot ${options.fromSnapshot} was not used`);
        let status = found.status;
        let waiting = false;
        while (status.state === 'stopping' || status.state === 'stopped') {
          if (status.state === 'stopped') {
            attempted = true;
            const response = await call(client, 'POST', `${BASE}/${found.id}/start`, { body: lifetime, signal, retry: true, accept: ['run_conflict'] });
            if (response.status < 300) {
              session.log(`starting from its saved disk ${session.viewerUrl}`);
              break;
            }
          }
          if (!waiting) session.log('waiting for its last stop to finish saving its disk');
          waiting = true;
          await delay(5_000, undefined, { signal });
          status = (await readStatus(client, found.id, signal)) ?? status;
        }
        if (status.state === 'running' || status.state === 'starting') session.log(`already ${status.state}; connecting ${session.viewerUrl}`);
        started = true;
        trackSession(session);
        first = session.parseReport(await session.request('GET', '/report', undefined, signal));
      }
      await session.awaitActive(first, signal);
      return session;
    } catch (error) {
      const refused = error instanceof VerifyError && REFUSED_START_CODES.has(error.code);
      const stopped = started || (attempted && !refused);
      if (stopped) await ComputerSession.prototype.close.call(session).catch(() => undefined);
      if (deadline.aborted) throw new VerifyError('TIMEOUT', `${name} was not ready within ${startTimeout} ms.${stopped ? ' It was stopped again and keeps its disk.' : ''} Call openPersistent('${name}') again, or pass a larger startTimeout. See ${session.viewerUrl}`, { cause: error });
      throw error;
    }
  }
}

/**
 * Opens the persistent Mac with this name, creating it if it doesn't exist, starting it if it is stopped, and
 * waiting until it is ready. Its disk outlives every stop: close() keeps it, and the next openPersistent() with
 * the same name boots from it. Names are 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit;
 * the same name opens the same computer from TypeScript, Python and Go. Pass an ID from listPersistent() to open
 * an existing computer without creating one. If it is already running, openPersistent() connects to it.
 *
 * Persistent computers are turned on per organization. Without them, openPersistent() and saveSnapshot() throw
 * NOT_AVAILABLE_ON_PLATFORM with reason 'persistent_computers_not_enabled'. Credentials work as for open().
 *
 * Every persistent-computer call throws a VerifyError whose code says what happened and whose message says what to
 * do: NOT_FOUND (no computer or snapshot by that name or ID), SESSION_BUSY (the computer is running, or its last stop
 * hasn't finished), TIMEOUT (a wait ran out; the call can be repeated), COMPUTER_LIMIT (the organization keeps its
 * maximum number of computers or snapshots, or can't start another computer now), NOT_AVAILABLE_ON_PLATFORM,
 * INVALID_ARGUMENT, AUTH_REJECTED, SESSION_START_FAILED and API_ERROR.
 *
 * @example
 * const mac = await openPersistent('build-cache');
 * if (mac.created) await mac.exec(['brew', 'install', 'jq']);
 * await mac.close(); // stops it and keeps the disk
 */
export async function openPersistent(name: string, options: PersistentOpenOptions = {}): Promise<PersistentComputerSession> {
  checkComputerReference(name, 'openPersistent()');
  if (options.fromSnapshot !== undefined) checkSnapshotReference(options.fromSnapshot, 'fromSnapshot');
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs % 1_000 !== 0 || options.timeoutMs < 60_000 || options.timeoutMs > 86_400_000)) throw new VerifyError('INVALID_ARGUMENT', 'timeoutMs must be whole seconds from 60000 to 86400000.');
  const startTimeout = options.startTimeout ?? 900_000;
  if (!Number.isInteger(startTimeout) || startTimeout < 10_000 || startTimeout > 1_800_000) throw new VerifyError('INVALID_ARGUMENT', 'startTimeout must be an integer from 10000 to 1800000 ms.');
  const { client, log } = await connect(options);
  return PersistentComputerSession.open(client, name, options, startTimeout, log);
}

/**
 * Saves a stopped persistent computer's disk (by name or ID) as a named snapshot, which
 * openPersistent(otherName, { fromSnapshot }) can start a new computer from. The computer must be stopped: close()
 * its session first, or saveSnapshot() throws SESSION_BUSY. A disk is ready to snapshot about 5-6 minutes after
 * close() returns, once it is copied off its Mac; saveSnapshot() waits for that (and for a stop still in progress)
 * up to waitTimeout, then throws TIMEOUT. Snapshot names follow the computer-name rule and are unique in your
 * organization: a name already used for a different save throws INVALID_ARGUMENT, while calling it again for the
 * same computer and save returns the snapshot it already saved. A snapshot lasts until you delete it.
 *
 * @example
 * await mac.close();
 * const snapshot = await saveSnapshot('build-cache', 'build-cache-base');
 */
export async function saveSnapshot(computer: string, snapshot: string, options: SaveSnapshotOptions = {}): Promise<ComputerSnapshot> {
  checkComputerReference(computer, 'saveSnapshot()');
  if (typeof snapshot !== 'string' || !NAME.test(snapshot) || UUID.test(snapshot)) throw new VerifyError('INVALID_ARGUMENT', `saveSnapshot() takes a snapshot name of ${NAME_RULE}.`);
  const timeout = options.waitTimeout ?? 900_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 3_600_000) throw new VerifyError('INVALID_ARGUMENT', 'waitTimeout must be an integer from 1000 to 3600000 ms.');
  const { client, log } = await connect(options);
  const say = (line: string) => log?.(`${computer}: ${line}`);
  const signal = AbortSignal.timeout(timeout);
  try {
    const found = await findComputer(client, computer, signal);
    if (!found.status) throw computerNotFound(computer);
    let waiting = false;
    for (;;) {
      const response = await call(client, 'POST', `${BASE}/${found.id}/snapshots`, { body: { name: snapshot }, signal, retry: true, notFound: computerNotFound(computer).message, accept: ['computer_not_stopped', 'saved_disk_not_durable', 'snapshot_name_taken'] });
      if (response.status < 300) {
        say(`saved snapshot ${snapshot}`);
        return toSnapshot(json(response));
      }
      const detail = responseDetail(response);
      const status = await readStatus(client, found.id, signal);
      if (detail === 'snapshot_name_taken') {
        const existing = await call(client, 'GET', `${BASE}/snapshots/${encodeURIComponent(snapshot)}`, { signal, accept: ['inaccessible'] });
        const saved = existing.status === 200 ? toSnapshot(json(existing)) : undefined;
        if (saved && saved.computerId === found.id && saved.savedAt.getTime() === status?.savedAt?.getTime()) return saved;
        throw new VerifyError('INVALID_ARGUMENT', `Your organization already has a snapshot named ${snapshot} (snapshot_name_taken). Pick another name, or delete the old one with deleteSnapshot('${snapshot}') first.`, { httpStatus: response.status });
      }
      if (detail === 'computer_not_stopped' && (status?.state === 'running' || status?.state === 'starting')) {
        throw new VerifyError('SESSION_BUSY', `${computer} is running. A snapshot saves a stopped computer's disk: close() its session first (that keeps the disk), then call saveSnapshot() again.`, { httpStatus: response.status });
      }
      if (!waiting) say(detail === 'saved_disk_not_durable' ? 'waiting for its saved disk to be copied off its Mac (usually about 5 minutes)' : 'waiting for it to finish stopping');
      waiting = true;
      await delay(15_000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    throw new VerifyError('TIMEOUT', `${computer}'s disk was not ready to snapshot within ${timeout} ms, so nothing was saved. Call saveSnapshot() again to keep waiting, or pass a larger waitTimeout.`, { cause: error });
  }
}

/**
 * Lists your organization's persistent computers, stopped ones included, other people's too. Revyl stores no names,
 * so each one is shown by its ID; compare with the id of a session openPersistent() returned. A name always maps to
 * the same ID, so a name keeps working after stops and from any machine or language.
 */
export async function listPersistent(options: PersistentOptions = {}): Promise<PersistentComputer[]> {
  const { client } = await connect(options);
  return listComputers(client, AbortSignal.timeout(60_000));
}

/** Lists your organization's snapshots. */
export async function listSnapshots(options: PersistentOptions = {}): Promise<ComputerSnapshot[]> {
  const { client } = await connect(options);
  return (await listPages(client, 'snapshots', AbortSignal.timeout(60_000))).map(toSnapshot);
}

/**
 * Deletes a persistent computer (by name or ID) and its saved disk for good. A running computer stops first,
 * without saving. Snapshots of it are kept until you deleteSnapshot() them. Throws NOT_FOUND when there is no such
 * computer, including one already deleted.
 */
export async function deletePersistent(computer: string, options: PersistentOptions = {}): Promise<void> {
  checkComputerReference(computer, 'deletePersistent()');
  const { client, log } = await connect(options);
  const signal = AbortSignal.timeout(60_000);
  const found = await findComputer(client, computer, signal);
  if (!found.status) throw computerNotFound(computer);
  await call(client, 'DELETE', `${BASE}/${found.id}`, { signal, retry: true, notFound: computerNotFound(computer).message });
  log?.(`${computer}: deleted`);
}

/** Deletes a snapshot by name or ID. Computers already started from it keep their disks. Throws NOT_FOUND when there is no such snapshot. */
export async function deleteSnapshot(snapshot: string, options: PersistentOptions = {}): Promise<void> {
  checkSnapshotReference(snapshot, 'deleteSnapshot()');
  const { client, log } = await connect(options);
  await call(client, 'DELETE', `${BASE}/snapshots/${encodeURIComponent(snapshot)}`, { signal: AbortSignal.timeout(60_000), retry: true, notFound: `There is no snapshot named or with the ID ${snapshot}. listSnapshots() shows your organization's snapshots.` });
  log?.(`snapshot ${snapshot}: deleted`);
}

async function connect(options: PersistentOptions): Promise<{ client: RevylClient; log: ((line: string) => void) | undefined }> {
  const credentials = await credentialsForUse(options);
  const log = options.log === false ? undefined : (options.log ?? ((line: string) => void process.stderr.write(`[verify] ${line}\n`)));
  return { client: new RevylClient({ token: credentials.token, backendUrl: options.backendUrl }), log };
}

async function findComputer(client: RevylClient, reference: string, signal: AbortSignal): Promise<{ id: string; status?: PersistentComputer }> {
  const live = await listComputers(client, signal);
  if (UUID.test(reference)) {
    const status = live.find((computer) => computer.id === reference.toLowerCase());
    if (!status) throw computerNotFound(reference);
    return { id: status.id, status };
  }
  const who = await client.whoAmI(signal);
  if (typeof who.org_id !== 'string' || !UUID.test(who.org_id)) throw new VerifyError('API_ERROR', 'Revyl did not say which organization this API key belongs to.');
  for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
    const id = computerOperationId(NAMESPACE, `${who.org_id.toLowerCase()}/${reference}/${generation}`);
    const status = live.find((computer) => computer.id === id);
    if (status) return { id, status };
    const response = await call(client, 'GET', `${BASE}/${id}`, { signal, accept: ['inaccessible'] });
    if (response.status === 404) return { id };
    const persistent = json<{ persistent?: unknown }>(response).persistent;
    if (persistent) return { id, status: toComputer(persistent) };
  }
  throw new VerifyError('API_ERROR', `${reference} has been deleted and re-created ${MAX_GENERATIONS} times; use a new name.`);
}

async function readStatus(client: RevylClient, id: string, signal: AbortSignal): Promise<PersistentComputer | undefined> {
  const persistent = json<{ persistent?: unknown }>(await call(client, 'GET', `${BASE}/${id}`, { signal })).persistent;
  return persistent ? toComputer(persistent) : undefined;
}

async function listComputers(client: RevylClient, signal: AbortSignal): Promise<PersistentComputer[]> {
  return (await listPages(client, 'persistent', signal)).map(toComputer);
}

async function listPages(client: RevylClient, kind: 'persistent' | 'snapshots', signal: AbortSignal): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 0; page < 10; page += 1) {
    const body = json<Record<string, unknown>>(await call(client, 'GET', `${BASE}/${kind}?limit=100&offset=${items.length}`, { signal }));
    const batch = body[kind === 'persistent' ? 'computers' : 'snapshots'];
    if (!Array.isArray(batch) || typeof body.total !== 'number') throw invalidResponse();
    items.push(...batch);
    if (batch.length === 0 || items.length >= body.total) break;
  }
  return items;
}

interface CallOptions {
  body?: unknown;
  signal: AbortSignal;
  retry?: boolean;
  notFound?: string;
  accept?: string[];
}

async function call(client: RevylClient, method: 'GET' | 'POST' | 'DELETE', path: string, options: CallOptions): Promise<RawResponse> {
  const response = await client.send(method, path, { body: options.body, signal: options.signal, retry: options.retry ?? method === 'GET', timeoutMs: 60_000 });
  if (response.status >= 200 && response.status < 300) return response;
  const blocked = edgeBlockedError(response);
  if (blocked) throw blocked;
  const detail = responseDetail(response);
  if (detail && options.accept?.includes(detail)) return response;
  const refusal = { httpStatus: response.status };
  const known = detail ? REFUSALS[detail] : undefined;
  if (known) throw new VerifyError(known[0], known[1], { ...refusal, reason: known[2] });
  if (response.status === 401 || response.status === 403) throw new VerifyError('AUTH_REJECTED', `Revyl rejected the request (HTTP ${response.status}${detail ? `, ${detail}` : ''}). Check that REVYL_API_KEY is a current key and that its owner has the Member role or above.`, refusal);
  if (response.status === 404) throw new VerifyError('NOT_FOUND', options.notFound ?? `Revyl could not find ${path} (inaccessible).`, refusal);
  if (response.status === 422 || detail === 'invalid_request') throw new VerifyError('INVALID_ARGUMENT', `Revyl refused the request as invalid (${detail ?? `HTTP ${response.status}`}). Check the call's arguments against its doc comment; if they match, update Verify.`, refusal);
  throw new VerifyError('API_ERROR', `Revyl request ${method} ${path} failed (HTTP ${response.status}${detail ? `, ${detail}` : ''}). It is safe to try again; if it keeps failing, send this message to support@revyl.ai.`, refusal);
}

const REFUSALS: Record<string, [VerifyErrorCode, string, RefusalReason?]> = {
  persistent_computers_not_enabled: ['NOT_AVAILABLE_ON_PLATFORM', "Persistent computers aren't enabled for this API key's organization yet (persistent_computers_not_enabled). Ask support@revyl.ai to turn them on.", 'persistent_computers_not_enabled'],
  computer_not_enabled: ['NOT_AVAILABLE_ON_PLATFORM', "Mac computers aren't enabled for this API key's organization (computer_not_enabled). Ask support@revyl.ai about access."],
  runtime_unavailable: ['NOT_AVAILABLE_ON_PLATFORM', 'Revyl has no Mac computers available in this environment (runtime_unavailable).'],
  persistent_computer_limit: ['COMPUTER_LIMIT', 'Your organization already keeps as many persistent computers as it may (persistent_computer_limit). listPersistent() shows them; delete one you no longer need with deletePersistent(), then try again.'],
  snapshot_limit: ['COMPUTER_LIMIT', 'Your organization already keeps as many snapshots as it may (snapshot_limit). listSnapshots() shows them; delete one you no longer need with deleteSnapshot(), then try again.'],
  computer_limit: ['COMPUTER_LIMIT', 'Revyl refused to start another computer right now (computer_limit): your organization is at its concurrency limit or has queued work. Stop a computer you no longer need, or try again later.'],
  computer_long_limit: ['COMPUTER_LIMIT', 'Revyl refused a lifetime over 2 hours: the organization already has 2 computers running longer than 2 hours (computer_long_limit). Pass timeoutMs of 7200000 or less, or stop one of them.'],
  saved_disk_unavailable: ['SESSION_START_FAILED', "The Mac holding this computer's saved disk is offline and the save isn't copied off it yet, or no Mac can start it right now (saved_disk_unavailable). The disk is kept; try again later."],
  saved_disk_expired: ['SESSION_START_FAILED', "This computer's saved disk has reached its end and can't start again (saved_disk_expired). Delete it with deletePersistent(); openPersistent() with its name then creates a new one."],
  snapshot_expired: ['SESSION_START_FAILED', "This snapshot's saved disk has reached its end and can't start a computer (snapshot_expired). Save a new snapshot of a recently stopped computer."],
  computer_not_persistent: ['INVALID_ARGUMENT', "This ID names a computer that isn't persistent (computer_not_persistent). Pass a name, or an ID from listPersistent()."],
  run_conflict: ['SESSION_BUSY', "The computer's last run hasn't finished stopping (run_conflict). Its disk is kept; try again in a few minutes."],
};

function computerNotFound(reference: string): VerifyError {
  return new VerifyError('NOT_FOUND', `There is no persistent computer ${UUID.test(reference) ? 'with the ID' : 'named'} ${reference}. listPersistent() shows your organization's persistent computers; openPersistent() with a name creates one.`);
}

function checkComputerReference(value: unknown, call: string): asserts value is string {
  if (typeof value !== 'string' || !(NAME.test(value) || UUID.test(value))) throw new VerifyError('INVALID_ARGUMENT', `${call} takes a computer name of ${NAME_RULE}, or an ID from listPersistent().`);
}

function checkSnapshotReference(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !NAME.test(value)) throw new VerifyError('INVALID_ARGUMENT', `${what} takes a snapshot name or ID from listSnapshots().`);
}

function toComputer(raw: unknown): PersistentComputer {
  const record = raw as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || typeof record.computer_id !== 'string' || !UUID.test(record.computer_id) || typeof record.state !== 'string' || !STATES.has(record.state) || typeof record.durable !== 'boolean') throw invalidResponse();
  const savedAt = record.saved_at == null ? undefined : date(record.saved_at);
  return { id: record.computer_id.toLowerCase(), state: record.state as PersistentComputerState, ...(savedAt ? { savedAt } : {}), savedOffHost: record.durable, createdAt: date(record.created_at) };
}

function toSnapshot(raw: unknown): ComputerSnapshot {
  const record = raw as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !UUID.test(record.id) || typeof record.name !== 'string' || typeof record.computer_id !== 'string' || !UUID.test(record.computer_id)) throw invalidResponse();
  const expiresAt = record.expires_at == null ? undefined : date(record.expires_at);
  return { id: record.id.toLowerCase(), name: record.name, computerId: record.computer_id.toLowerCase(), savedAt: date(record.saved_at), ...(expiresAt ? { expiresAt } : {}) };
}

function date(value: unknown): Date {
  const parsed = typeof value === 'string' ? new Date(value) : undefined;
  if (!parsed || !Number.isFinite(parsed.getTime())) throw invalidResponse();
  return parsed;
}

function json<T>(response: RawResponse): T {
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as T;
  } catch {
    throw invalidResponse();
  }
}

function invalidResponse(): VerifyError {
  return new VerifyError('API_ERROR', 'Revyl returned an invalid persistent computer response.');
}
