# Errors

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
| `API_ERROR` | Revyl returned an unexpected response | Try again; if it persists, report it with the session link |
| `SESSION_START_FAILED` | The browser or device did not start | The message has Revyl's reason, for example no build for the app |
| `SESSION_ENDED` | The session was closed, or Revyl stopped it, for example after the idle timeout | Open a new session |
| `SESSION_BUSY` | The session refused a step because another one was still running on it, for example a step that just timed out | Wait for it to finish, then send the step again |
| `NOT_AVAILABLE_ON_PLATFORM` | The Revyl backend does not offer this on the session's platform, such as steps on web before Revyl production has them | See [web.md](web.md) |
| `ACTION_FAILED` | Revyl refused or failed a request on the session | Read the reason in the message |
| `ACTION_UNCERTAIN` | The connection failed mid-request, so the step may or may not have run | Verify does not repeat it; check the session link before deciding what to do |
| `INSTRUCTION_FAILED` | Revyl's agent could not do what the instruction asked | Make the instruction more specific, or split it into smaller steps |
| `VALIDATION_FAILED` | The validation did not hold | The message has Revyl's reason; watch the recording at the session link |
| `STEP_FAILED` | Revyl could not run the step to an outcome: it errored, it was cancelled on Revyl, or a validation came back without a verdict. This says nothing about your app, and `soft` does not cover it. | Watch the session at the link, then run the step again |
| `TIMEOUT` | A step, a session start, or a request ran out of time | Raise `stepTimeout` or `startTimeout`, or split the step |
