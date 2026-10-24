# Linux computers: deferred implementation contract

Status: contract only. Verify accepts `platform: 'linux'` in types and target config, but rejects opening it with `NOT_AVAILABLE_ON_PLATFORM` before resolving credentials or making any network request. This applies to named and inline targets. `init` does not generate Linux projects. No Linux provider or live run is claimed.

This contract follows the staging source inspected at `c7d0b9044`, especially `cognisim_schemas/cognisim_schemas/schemas/computer_schema.py`, `computer_report_schema.py`, and `cognisim_backend/app/routes/computer_runs_routes/computer_runs_xpt.py`. The existing API accepts `os: 'linux'`; that is a schema value, not a working Linux provider. Mac uses `os: 'macos'`. No backend changes are included here.

The current hosted implementation explicitly rejects any OS other than `macos` in `HostedComputerRuntime._admit_and_start` with `runtime_unavailable`. Linux needs backend provider work before Verify can enable it; removing the client refusal alone is insufficient.

## Intended public surface

Once Linux is authorized and implemented, the target is `{ platform: 'linux', startTimeout?: number }`, with no `app`, image, provider, cwd, TTL, or device selector. It returns the same `Session` shell/file/process surface as Mac:

- `exec(argv: string[], { timeout?, stdin?: string | Uint8Array, check?: boolean }?)` returns `{ exitCode, stdout, stderr }`, with UTF-8 strings. Nonzero exit throws `COMMAND_FAILED` unless `check: false`.
- `readFile(path, options?)` returns `Buffer`; `writeFile(path, string | Uint8Array, options?)` returns `void`.
- `stat(path, options?)` returns `{ kind: 'file' | 'directory', size: number }` in bytes.
- `processes(options?)` returns `{ id, state: 'running' | 'exited', exitCode?: number }[]`; `terminate(id, options?)` uses the run-owned handle id, never a PID.
- `close()` stops the computer and preserves the distinction between terminal state and confirmed release.

Instruction and validation stay unavailable until a separate agent-step contract ships. Staging has an authenticated screenshot endpoint, `GET /api/v1/computer-runs/{id}/screen/screenshot`, returning `{ width, height, observed_at, png, cursor }`: standard base64 PNG, UTC observation timestamp, and nullable `{ x, y }` cursor. Verify consumes the dimensions and PNG. Mac supports it in Verify; Linux screen availability must be confirmed separately and must not be inferred from shell readiness.

## Requests, responses, and readiness

All routes below use the selected `REVYL_BACKEND_URL` plus `/api/v1`, the existing bearer credentials, `X-Revyl-Client: verify`, and the versioned Verify user agent. Organization ownership comes from authentication, not UUID possession. Reads require same-org access; create, operations, and stop require an operator role and computer admission. Preserve the existing `REVYL_APP_URL` override for session links. No provider-specific credentials belong in Verify.

| Request | Response and client behavior |
| --- | --- |
| `POST /computer-runs` with `{ computer_session_id: C1, os: 'linux' }` | `ComputerReport`. Mint canonical nonzero UUID C1 once on the client. Do not remint/replay after an uncertain create. |
| `GET /computer-runs/C1/report` | `ComputerReport` for readiness. Poll only while `starting`; resolve open on `active` (owner route ready). `closing`, `stopped`, `failed`, or `owner_lost` are not ready; fail and attempt cleanup within bounds. |
| `POST /computer-runs/C1/operations` with `{ computer_session_id: C1, request_id: R1, command }`, `Prefer: respond-async` | `ComputerCommandResponse`, or HTTP `202` with exact JSON `null` while still running after the async wait. Mint R1 once per operation; C1 in path and body must agree. |
| `GET /computer-runs/C1/operations/O1` | Original retained `ComputerCommandResponse`, or `202`/`null` while running. O1 is UUIDv5(namespace=C1, name=canonical R1 string). Poll reads, never resubmit to poll. |
| `POST /computer-runs/C1/stop` | `ComputerReport` with separate execution end, evidence status, and release certainty. A stopped/failed/lost-owner state does not imply confirmed release. |

A report contains `kind: 'computer'`, `version: 1`, UUIDs `report_id`, `computer_session_id`, `org_id`, `os`, timestamps `created_at`, `expires_at`, `as_of`, lifecycle `state`, optional `failure_reason`, execution timestamps, `release: 'pending' | 'confirmed' | 'unknown'`, `released_at`, `evidence_completeness: 'complete' | 'partial'`, `evidence_write_status: 'recorded' | 'pending' | 'failed'`, and operation evidence `steps`. Verify must validate identities and the fields it consumes, without treating recording success as execution success.

Identical requests using the same R1 return the retained result; changed input conflicts. The original owner retains raw results; there is no cross-restart command recovery guarantee. Reads must be bounded by an overall deadline. Cancellation/timeout does not authorize an automatic mutation retry.

## Command payloads and results

Every command has integer `timeout_ms` from 1 to 300,000 (default 30,000), bounded by remaining run lifetime. Current run lifetime is 3,600 seconds and operation count is at most 256.

| `command` fields beyond timeout | Successful `result` |
| --- | --- |
| `{ kind: 'exec', argv: string[], stdin?: base64 }` | `{ kind: 'exec', exit_code, stdout: base64, stderr: base64 }` |
| `{ kind: 'file_read', path, max_bytes?: 1..1048576 }` | `{ kind: 'file_read', data: base64 }` |
| `{ kind: 'file_write', path, data: base64 }` | `{ kind: 'file_write', byte_count }` |
| `{ kind: 'file_stat', path }` | `{ kind: 'file_stat', file_kind: 'file' | 'directory', size_bytes }` |
| `{ kind: 'process_list', max_items?: 1..64 }` | `{ kind: 'process_list', processes: [{ handle: { computer_session_id: C1, handle_id }, state, exit_code: number | null }] }` |
| `{ kind: 'process_terminate', handle: { computer_session_id: C1, handle_id } }` | `{ kind: 'process_terminate', termination: 'confirmed' }` |

The backend also has `process_inspect`; Verify does not expose it in this release. Process handles belong to C1. Running processes have no exit code. Exit codes are integers from -255 to 255. Stdout/stderr/data/stdin are padded URL-safe base64 wire bytes (standard base64 input accepted); decode file reads losslessly and encode string inputs as UTF-8.

Exec has 1..64 argv entries; argv[0] must be nonempty, no entry may contain NUL, and total UTF-8 argv plus stdin is at most 16,384 bytes. Exec output retains the first 1 MiB combined, without stopping the process merely for output truncation. File reads return at most 1 MiB; writes accept at most 65,536 bytes. Paths are workspace-relative, at most 1,024 UTF-8 bytes, with no empty/dot/traversal components, controls, backslashes, or colons. Do not silently translate absolute paths or shell strings.

`ComputerCommandResponse` is `{ computer_session_id: C1, operation_id: O1, execution, evidence: 'recorded' | 'pending' | 'failed' }`. Its `execution` discriminant is:

- `succeeded`: typed `result`; exec exit code must be zero.
- `failed`: `error_code: 'not_found' | 'access_denied' | 'exec_nonzero'`; only `exec_nonzero` carries an exec result with an observed nonzero code.
- `timed_out`: `error_code: 'timed_out'`, `termination: 'confirmed' | 'unknown'`, optional `observed_exit_code`.
- `unknown`: error code `lost_ack`, `executor_error`, `invalid_executor_result`, `owner_lost`, `stopped`, or `start_evidence_failed`, plus termination certainty.

## Errors and uncertainty

HTTP errors use `{ detail: code }`, not an invented Linux-specific envelope. Current route/admission codes include:

| HTTP | Codes |
| --- | --- |
| 401 | `unauthenticated` |
| 402 | Compute-credit/billing admission refusal (`API_ERROR`; report only the sanitized reason, never raw response contents) |
| 403 | `forbidden`, `computer_not_enabled` |
| 404 | `inaccessible`, `invalid_handle`, `operation_not_found` |
| 409 | `request_conflict`, `run_conflict`, `owner_unavailable`, `run_closed`, `evidence_conflict` |
| 422 | `invalid_request` |
| 429 | `computer_limit`, `operation_limit` |
| 503 | `runtime_unavailable`, `start_failed`, `evidence_unavailable`, `authentication_unavailable` |

Do not collapse these into a missing-provider fallback or retry create/commands with a fresh id. Public Verify classifications follow Mac:

| Condition | Verify code |
| --- | --- |
| Invalid local input or `invalid_request` | `INVALID_ARGUMENT` |
| `computer_not_enabled` | `NOT_AVAILABLE_ON_PLATFORM` |
| HTTP 401/403 otherwise | `AUTH_REJECTED` |
| `runtime_unavailable`, `start_failed`, `computer_limit` | `SESSION_START_FAILED` |
| `run_closed` | `SESSION_ENDED` |
| `inaccessible`, `invalid_handle`, operation `not_found` | `NOT_FOUND` |
| Operation `access_denied` | `ACCESS_DENIED` |
| Operation `exec_nonzero` | `COMMAND_FAILED` (unless `check: false`) |
| Remaining 409 refusals or `operation_limit` | `SESSION_BUSY` |
| `operation_not_found`, `owner_unavailable`, unknown execution/release, or uncertain mutation transport | `ACTION_UNCERTAIN` |
| Operation timed out with confirmed termination | `TIMEOUT` |
| POST 5xx or redirect not covered above | `ACTION_UNCERTAIN` |
| Operation polling transport failure or an unclassified polling 5xx | `ACTION_UNCERTAIN` |
| Unclassified response, including HTTP 402 | `API_ERROR` |

A timed-out operation with unknown termination is `ACTION_UNCERTAIN`, not `TIMEOUT`. An observed successful operation can return its result while logging pending/failed evidence. Failed evidence is not proof that execution failed or never ran. Keep raw command/file contents and credentials out of diagnostics.

## Linux assumptions requiring confirmation

Before enabling Linux, the Computer runtime owner must confirm:

1. A real Linux provider is deployed and admitted for the selected environment/organization. Schema acceptance is insufficient; confirm provider identity, billing/concurrency lane, lifetime, start/stop behavior, and cleanup/release guarantees.
2. `active` means the Linux owner route accepts commands and files, with the same report identities, async operation polling, deduplication, and retained-result semantics. Verify this against a provider, not only a fake.
3. The workspace root, initial working directory, user privileges, permissions, filesystem/symlink policy, persistence/isolation, and installed executable/PATH baseline. Do not assume macOS tools, Darwin output, package managers, writable absolute paths, or host access.
4. Structured argv launches without an implicit shell; explicit `/bin/sh` availability, process-tree termination, negative exit/signal behavior, output truncation, and binary IO match the shared contract.
5. Linux process handles remain run-owned, not PIDs; listing limits and termination certainty have the same meaning. Confirm behavior on owner loss and run expiry.
6. Whether a graphical Linux desktop and screenshots exist. Until confirmed, do not promise screenshots, screen control, instruction, or validation.
7. Approved live acceptance coverage: create/readiness, argv/stdin and nonzero exit, binary file round trip/stat, missing/denied file, process list/terminate, 202 polling, timeout/unknown outcome, and confirmed close. This work performs no live runs.
