# Linux computers: implemented shared contract

Verify 0.2.0 enables Linux named and inline targets with the same computer API as Mac. Both operating systems are **early access on staging for organizations enabled for the requested OS, not yet available in production**. Server admission decides availability; SDK support is not a guarantee that capacity is available. No live Linux run was performed for this SDK change.

Use `open({ platform: 'linux', startTimeout: 600_000 })`, or add `linux: { platform: 'linux' }` under `targets` in `verify.config.ts`. There is no app, image, provider, cwd, TTL, or device selector. `init --platform linux` remains intentionally unavailable; it does not block inline or named Linux SDK targets. See [computers.md](computers.md) for staging setup and usage.

## Public surface

- `exec(argv, { timeout?, stdin?, check? }?)` returns `{ exitCode, stdout, stderr }`. There is no implicit shell. Nonzero exit throws `COMMAND_FAILED` unless `check: false`.
- `readFile`, `writeFile`, and `stat` use workspace-relative paths and preserve binary bytes.
- `processes` and `terminate` use run-owned handles, never OS PIDs.
- `screenshot({ path? }?)` returns PNG bytes with dimensions from the response; screenshot readiness is independent of command readiness. The SDK retries only structured startup screen-not-ready responses within its fixed 30-second window after active readiness; [computer docs](computers.md) describe the bounds and typed exhaustion error.
- `close()` succeeds only on terminal state and confirmed physical release.
- `recording()` returns private recording metadata or null after terminal state and confirmed release, and works after close. It does not wait or download.
- `expiresAt` exposes a validated API timestamp as a `Date`, or is undefined on older APIs. The hard lifetime is 60 minutes from create, not readiness or activity. Expired operations are rejected, pending observations are bounded by expiry, and close remains possible.

`instruction` and `validation` are rejected locally on both computer operating systems. There is no computer agent-step endpoint. The assigned-physical-computer `shell-sessions` API is not part of this contract. Installed tools, guest paths, resources, architecture, and screen dimensions are not SDK guarantees; use portable commands or inspect what the selected guest provides.

## Requests and readiness

All routes use `/api/v1/computer-runs`, the selected `REVYL_BACKEND_URL`, bearer authentication, `X-Revyl-Client: verify`, and Verify's versioned user agent. Ownership is enforced by the server; possession of a UUID grants no access. `REVYL_APP_URL` controls UI links.

| Request | Contract |
| --- | --- |
| `POST /computer-runs` | `{ computer_session_id: C1, os: 'linux' }`; Mac sends `os: 'macos'`. Mint C1 once, never replay an uncertain create. |
| `GET /computer-runs/C1/report` | Validate C1 and lifecycle state. Poll while starting, resolve on active, fail on other states. `failed/no_host` means an unclaimed start reached the 120-second window, not that all starts must finish within it. The default client start timeout stays 10 minutes. |
| `POST /computer-runs/C1/operations` | `{ computer_session_id: C1, request_id: R1, command }`, with `Prefer: respond-async`. Response is a command result or `202` with exact JSON null. |
| `GET /computer-runs/C1/operations/O1` | Read the retained result, or `202`/null while running. O1 is UUIDv5(namespace=C1, name=R1 string). Poll reads without replaying mutations. |
| `POST /computer-runs/C1/stop` | Report state and release separately. Close requires `stopped`, `failed`, or `owner_lost` plus `release: 'confirmed'`. |
| `GET /computer-runs/C1/recording` | After a separate report confirms terminal state and release: `{ url, duration_seconds?, started_at? }`, or `404 { error: 'recording_unavailable' }`. Optional fields may be null. No URL is carried by the normal report. |

Recording URLs must be HTTPS and are signed, short-lived, and private, including the query string. Duration must be finite and nonnegative, and timestamps must include a timezone. Malformed responses produce a generic error that does not echo the URL. The SDK never fetches that URL. A pre-release recording request throws `SESSION_BUSY`; missing recording returns null without automatic waiting.

## Commands and uncertainty

Commands retain the shared limits: 30-second default / 5-minute maximum timeout, 256 operations per run, 64 argv entries, 16,384 bytes of argv plus stdin, first 1 MiB combined stdout/stderr, 1 MiB reads, 64 KiB writes, and 64 listed handles. File paths must be workspace-relative without traversal. See [computers.md](computers.md) for complete validation rules.

Operation responses identify C1 and O1 and separate `execution` from `evidence: 'recorded' | 'pending' | 'failed'`. Successful execution can return a result even when report evidence is pending or failed. An observed nonzero exec result is distinct from transport failure. Unknown outcome, unconfirmed timeout termination, and lost mutation responses produce `ACTION_UNCERTAIN` and never authorize replay. Terminal lifecycle, physical release, and recording availability are independent.

| Condition | Verify code |
| --- | --- |
| `computer_not_enabled`, or `503 runtime_unavailable` | `NOT_AVAILABLE_ON_PLATFORM` |
| `429 computer_limit` | `COMPUTER_LIMIT`: queued work (including iOS) or concurrency limit; no automatic start retry or stop after definite admission refusal |
| `operation_limit`, other conflict refusals | `SESSION_BUSY` |
| `failed/no_host`, `failed/device_limit`, `start_failed` | `SESSION_START_FAILED`; safe no-host or queued-work/concurrency context when known |
| `run_closed`, or local expiry | `SESSION_ENDED` |
| `inaccessible`, `invalid_handle`, operation `not_found` | `NOT_FOUND` |
| Operation `access_denied` | `ACCESS_DENIED` |
| Operation `exec_nonzero` | `COMMAND_FAILED` unless `check: false` |
| Unknown execution, operation unavailable, uncertain mutation or release | `ACTION_UNCERTAIN` |
| Confirmed operation timeout | `TIMEOUT` |

Other HTTP errors retain the shared authentication, input, or API classifications described in [errors.md](errors.md). Do not infer a capacity cause from `computer_limit` alone or expose arbitrary failure text, command data, credentials, or recording URLs in diagnostics.
