/**
 * Experimental, internal surface of @revyl/verify: not covered by semver and not in the public docs yet.
 *
 * Persistent Mac computers keep their disk between runs. openPersistent('name') opens the computer with that name,
 * creating it if needed; close() stops it and keeps the disk; openPersistent('name') again boots from that disk.
 * saveSnapshot() pins a stopped computer's disk under a name, and openPersistent('other', { fromSnapshot }) starts
 * a new computer from it.
 *
 * Credentials and environment work as for open(): REVYL_API_KEY or a `verify login`, and backendUrl/appUrl (for
 * example https://backend-staging.revyl.ai and https://staging.revyl.ai) to use another Revyl environment.
 *
 * Every call throws a VerifyError (exported here) whose code says what happened and whose message says what to do:
 * NOT_FOUND (no computer or snapshot by that name or ID), SESSION_BUSY (the computer is running, or its last stop
 * hasn't finished), TIMEOUT (a wait ran out; the call can be repeated), COMPUTER_LIMIT (the organization keeps its
 * maximum number of computers or snapshots, or can't start another computer now), NOT_AVAILABLE_ON_PLATFORM
 * (persistent computers aren't enabled for this API key's organization), INVALID_ARGUMENT, AUTH_REJECTED,
 * SESSION_START_FAILED and API_ERROR.
 */
export { openPersistent, saveSnapshot, listPersistent, listSnapshots, deletePersistent, deleteSnapshot } from './persistent.js';
export type { ComputerSnapshot, PersistentComputer, PersistentComputerSession, PersistentComputerState, PersistentOpenOptions, PersistentOptions, SaveSnapshotOptions } from './persistent.js';
export { VerifyError, isVerifyError } from './errors.js';
export type { VerifyErrorCode } from './errors.js';
