# Errors

Every error Verify raises is a `VerifyError` with a stable `code`. Results and terminal output show the code first.

```ts
import { isVerifyError } from '@revyl/verify';
```

| Code | What happened | What to do |
| --- | --- | --- |
| `CONFIG_NOT_FOUND` | No `verify.config.ts` in the current folder | Run `npx @revyl/verify init`, or pass `--config` |
| `CONFIG_INVALID` | The config failed validation | The message names the exact option and the rule |
| `COLLECTION_ERROR` | A test file failed to load, or declared tests incorrectly | Fix the file named in the message |
| `NO_TESTS` | No files matched `tests` and the filters | Check the glob and the file filters |
| `ONLY_IN_CI` | A `test.only` is present while `CI` is set | Remove the `.only` |
| `AUTH_MISSING` | No `REVYL_API_KEY` and no Revyl CLI login | Set `REVYL_API_KEY` or run `revyl auth login` |
| `AUTH_REJECTED` | Revyl rejected the credentials | Create a new API key, or log in again |
| `API_ERROR` | Revyl returned an unexpected response | Retry; if it persists, report it with the session link |
| `SESSION_START_FAILED` | The browser or device did not start | The message has Revyl's reason, for example no build for the app |
| `SESSION_ENDED` | The session stopped during the test | Usually the idle timeout or a crash; the next test starts a new session |
| `NOT_AVAILABLE_ON_PLATFORM` | The call does not exist on this target's platform | The message names the alternative |
| `LOCATOR_NOT_FOUND` | No element matched within the timeout | The message lists text on screen; fix the locator or wait for the right screen |
| `LOCATOR_AMBIGUOUS` | Several native elements matched an action | Narrow the locator, or use `first()`, `last()`, or `nth()` |
| `ACTION_FAILED` | Revyl ran the action and reported failure | Read the reason; check the session recording |
| `ACTION_UNCERTAIN` | The connection failed mid-action, so it may or may not have happened | Verify does not repeat it and starts a fresh session for the next test |
| `AGENT_STEP_FAILED` | `agent.act` or `agent.extract` could not finish | Make the instruction more specific, or split it into smaller steps |
| `ASSERTION_FAILED` | An `expect` or `agent.assert` did not hold | The message has the observed state or the agent's reasoning |
| `TIMEOUT` | A test, agent step, or session start ran out of time | Raise the matching timeout, or find what the test waits for |
| `CANCELLED` | The run was interrupted | |
| `INVALID_ARGUMENT` | A call or a CLI flag got a bad value | The message names the argument |
