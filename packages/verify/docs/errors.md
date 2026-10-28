# Errors

## Structured refusal reasons

`VerifyError.reason` is an optional typed `RefusalReason` and `httpStatus` is the HTTP status when available. They supplement, rather than replace, the existing `code`. Only recognized server codes are retained; raw error messages and unknown payloads are not exposed as reasons. Starts and navigation are never replayed automatically.

| Start refusal | Existing `code` | `reason` |
| --- | --- | --- |
| Web HTTP 409 capacity/availability | `API_ERROR` | `web_runtime_unavailable` |
| Computer HTTP 429 admission | `COMPUTER_LIMIT` | `computer_limit` |
| Computer HTTP 503 runtime availability | `NOT_AVAILABLE_ON_PLATFORM` | `runtime_unavailable` |
| Hosted child capacity | `COMPUTER_LIMIT` | `computer_at_capacity` |
| Hosted runtime/capability | `NOT_AVAILABLE_ON_PLATFORM` | `computer_runtime_unavailable` / `computer_cannot_host_platform` / `web_runtime_not_configured` |
| Hosted parent no longer running | `SESSION_ENDED` | `computer_not_running` |
| Hosted parent inaccessible | `NOT_FOUND` | `computer_not_found` |
| Hosted build input | `INVALID_ARGUMENT` | `web_build_required`, `web_build_not_supported`, or corresponding `ios_` / `android_` codes |
| Hosted identity conflict | `SESSION_BUSY` | `web_session_conflict`, `ios_session_conflict`, `android_session_conflict` |

`web_runtime_unavailable` does not distinguish full capacity from an unavailable runtime. `computer_limit` does not distinguish queued work from concurrency exhaustion. Inspect these fields to classify refusal without parsing prose; do not infer a specific cause or automatically start a replacement session.

Ordinary start errors retain recognized safe server diagnostic codes such as `web_app_required` in the message even when they are not typed refusal reasons. Arbitrary server messages and payloads are not copied into startup diagnostics.

Web navigation timeouts expose `reason: 'request_timeout'` with HTTP 504 and `code: 'ACTION_UNCERTAIN'`: the action budget expired before navigation was confirmed, but the request may still commit and the session remains open. A normalized `protocol_error` also preserves uncertainty and its HTTP status. Neither error causes Verify to replay navigation or close the session. Inspect the live page before deciding whether to navigate again.

Everything Verify throws on purpose is a `VerifyError` with a stable `code`. Messages name the problem and, for step failures, end with the session link.

```ts
import { isVerifyError } from '@revyl/verify';

try {
  await session.validation('The cart is empty');
} catch (error) {
  if (isVerifyError(error) && error.code === 'VALIDATION_FAILED') { /* … */ }
  throw error;
}
```

| Code | What happened | What to do |
| --- | --- | --- |
| `INVALID_ARGUMENT` | A call got a bad value: an unknown target name, an empty step, two steps at once on one session | The message names the argument |
| `CONFIG_NOT_FOUND` | `open('name')` found no `verify.config.ts` at or above the current folder | Run `npx @revyl/verify init`, pass `options.config`, or pass a target object |
| `CONFIG_INVALID` | The config failed validation or did not load | The message names the exact option and the rule |
| `AUTH_MISSING` | No `REVYL_API_KEY` and no Revyl CLI login | Set `REVYL_API_KEY` or run `revyl auth login` |
| `AUTH_REJECTED` | Revyl rejected the credentials | Create a new API key, or log in again |
| `EDGE_BLOCKED` | An HTTP 403 has a `text/html` content type and nonempty `cf-ray`, without a valid JSON body | Check network access or contact support; Verify does not retry the request |
| `API_ERROR` | Revyl returned an unexpected response | Try again; if it persists, report it with the session link |
| `SESSION_START_FAILED` | The browser, device, or computer did not start | Computer `no_host` reports the 120-second unclaimed-start context; `device_limit` reports queued-work/concurrency context. Inspect the session and cleanup before starting again. |
| `SESSION_ENDED` | The session was closed, stopped, or expired | Close explicitly; computer expiry does not prove release |
| `SESSION_BUSY` | A step conflict, computer operation limit, or recording requested before terminal state and confirmed release | Inspect the state before another call; a terminal computer alone does not prove release |
| `COMPUTER_LIMIT` | Computer admission was refused due to queued work (including iOS) or the concurrency limit | Wait for capacity; Verify does not retry or stop a definitely refused start |
| `NOT_AVAILABLE_ON_PLATFORM` | The call is unavailable: computer agent steps, device shell/file/recording methods, computer OS/organization not enabled or runtime unavailable, or a backend without web steps | See [web.md](web.md) and [computers.md](computers.md#availability-and-errors) |
| `COMMAND_FAILED` | A computer command exited nonzero | Read its reason; use `exec(argv, { check: false })` to inspect the exit code and output instead |
| `NOT_FOUND` | A computer file or resource was not found | Check the workspace-relative path |
| `ACCESS_DENIED` | The computer refused access | Check permissions; do not assume host/root access |
| `ACTION_FAILED` | Revyl refused or failed a request on the session | Read the reason in the message |
| `ACTION_UNCERTAIN` | The connection failed mid-request, so the step may or may not have run | Verify does not repeat it; check the session link before deciding what to do |
| `INSTRUCTION_FAILED` | Revyl's agent could not do what the instruction asked | Make the instruction more specific, or split it into smaller steps |
| `VALIDATION_FAILED` | The validation did not hold | The message has Revyl's reason; watch the recording at the session link |
| `STEP_FAILED` | Revyl could not run the step to an outcome: it errored, it was cancelled on Revyl, or a validation came back without a verdict. This says nothing about your app, and `soft` does not cover it. | Watch the session at the link, then run the step again |
| `TIMEOUT` | A step, a session start, or a request ran out of time | Inspect the session before retrying; computer starts require staging enablement. The default 10-minute start timeout is separate from the 120-second unclaimed-start failure. See [computer availability](computers.md#availability-and-errors). |

`EDGE_BLOCKED` does not require Cloudflare branding in the HTML body. A `cf-ray` header alone is not proof of a block: any syntactically valid JSON body retains its existing error mapping, even if the content type is incorrectly `text/html`. HTTP 401 is unchanged. Edge-block errors include `httpStatus` but never copy the response body or ray ID into the error.

Computer operations use `TIMEOUT` for bounded runtime with confirmed termination, and `ACTION_UNCERTAIN` when termination, execution, or cleanup is unconfirmed. An observed successful operation can return its result while logging pending/failed evidence. Timeout never proves rollback, and failed evidence does not prove the command never ran. Never automatically retry a mutation with a fresh request id; inspect the computer first. See [computers.md](computers.md).
