# For coding agents

This page is for AI coding agents (Claude Code, Cursor, Codex, and others) that use Verify to check an app on a cloud browser/device or run commands and files on a Mac computer. The rest of this folder describes the API in full; this page is the workflow.

## Workflow

1. Read `verify.config.ts` to learn the target names and their platforms. If there is none, run `npx @revyl/verify init --platform ios` or `--platform android` (without `--app-id` they open the built-in Settings app), `npx @revyl/verify init --platform web --app-id <id> --url <https-url>`, or `npx @revyl/verify init --platform mac`. You can also pass a target object to `open()`.
2. Check the credentials once with `npx @revyl/verify whoami`. It starts no session.
3. Write a short script, or extend an existing one, that opens one target, runs the steps you need, and closes:
   ```ts
   import { open } from '@revyl/verify';

   const session = await open('ios');
   try {
     await session.instruction('Sign in as the demo user');
     await session.validation('The dashboard shows at least one project card');
     await session.screenshot({ path: '.verify/dashboard.png' });
   } finally {
     await session.close();
   }
   ```
4. Run it with `node path/to/script.ts`. Share the session link from the first `[verify]` line with the user, so they can watch.
5. Read the outcome from the exit code and stderr. Each step prints `✓` or `✗` with its text; a failure prints `CODE: message`, ending with the session link. Look at any screenshot you saved before changing the script or the app.

## Exact actions and coordinates

Use `instruction()` when the step needs judgement, and exact actions (`tap`, `doubleTap`, `longPress`, `type`, `swipe`, `drag`, `pressKey`, `locate`, `screenSize`) when you know exactly what to press. They work on Web, iOS and Android, not on computers. On Web, `typeFocused(text)` types into the field that has focus, and `pressKey` also takes keys such as `'escape'`, `'tab'` and arrows, with `modifiers`. On iOS and Android, `goHome()` goes to the home screen, `pressKey` takes only `'enter'` and `'backspace'`, and you type with `type(location, text)`. A call the platform lacks throws `NOT_AVAILABLE_ON_PLATFORM` before anything is sent, and the message names what to use instead.

Prefer a description, such as `tap({ target: 'Sign in button' })`: Revyl finds the element on the current screen, and you never handle coordinates. Otherwise a point is `{ x, y }` in screenshot pixels on every platform: whole numbers from the top-left corner of the image `screenshot()` returns. So a position you read off a screenshot goes to `tap()`, `type()`, `swipe()` and every other exact action unchanged. `screenSize()` returns the screenshot's width and height, and `locate()` and the points `tap()`, `doubleTap()`, `longPress()` and `type()` return use the same pixels. A point outside the screenshot is refused with `INVALID_ARGUMENT` before any action is sent, and the message names the valid range. On iOS, Verify converts the pixels to the screen's points for you. On Web they equal CSS pixels at the default device scale factor of 1, and you still pass screenshot pixels at any other. This holds from TypeScript 0.4.1, Python 0.2.1 and Go v0.3.1; earlier versions took iOS points.

`swipe('up')` moves the finger up, so content scrolls down, on every platform. Actions return once Revyl accepts them, so after a swipe, drag, `goHome`, `openUrl` or `launchApp`, wait for the screen to settle before you `locate` or tap by coordinates.

```ts
import { open } from '@revyl/verify';

const session = await open('ios');
try {
  await session.tap({ target: 'General' });                 // first choice: describe the element
  const about = await session.locate('About');              // a point in screenshot pixels
  await session.tap(about);                                 // so it goes straight to tap()

  await session.screenshot({ path: '.verify/screen.png' }); // open it and find what to press
  await session.tap({ x: 660, y: 1500 });                   // a position read off the screenshot, unchanged
  await session.swipe('up', { from: { x: 660, y: 2000 } }); // swipe from a screenshot position too
  const { width, height } = await session.screenSize();     // the screenshot's size
  console.log(`x is 0 to ${width - 1}, y is 0 to ${height - 1}`);

  await session.longPress({ target: 'Wi-Fi row' });          // press and hold, 1.5 s by default
  await session.drag({ x: 660, y: 2000 }, { x: 660, y: 800 }); // press, move, release: the list follows the finger
  await session.goHome();                                   // the home screen, on iOS and Android
} finally {
  await session.close();
}
```

The [Python](https://github.com/RevylAI/verify/blob/v0.5.0/python/README.md#exact-actions) and [Go](https://github.com/RevylAI/verify/blob/v0.5.0/go/README.md#exact-actions) READMEs state the same rule with each language's names. [api.md](api.md#exact-actions) lists every call and its errors.

## Rules

Mac computers are early access. Ask support@revyl.ai about access before starting a computer; do not repeat an uncertain start/stop to probe availability.

For computer work, use structured `exec(['program', 'arg'])`, `readFile`, `writeFile`, `stat`, and run-owned handles from `processes()`/`terminate(id)`. Check command output with ordinary assertions and close in `finally`; screenshots are supported, but instruction/validation are not. Do not fall back to agent steps on computers or shell/file methods on mobile/web. See [computers.md](computers.md) for limits. Starting a computer is a paid external action and needs the same approval as starting a device.

Computers have a hard lifetime from create (two hours today), not from readiness or activity; `expiresAt` is the authoritative deadline. `expiresAt` is optional on older APIs; expiry does not prevent close. After terminal state and confirmed release, `recording()` can return private signed metadata or null, including after close. Never log or share its signed URL/query. Do not automatically wait for recordings or retry `COMPUTER_LIMIT` starts: queued work (including iOS) or the concurrency limit may be responsible.

- Write steps the way you would brief a person: what to do, or what should be true, in one sentence. Name visible things ("the blue Save button in the footer"), not implementation details.
- Use `instruction` for doing and `validation` for checking. Do not ask an instruction to check something, or a validation to change anything.
- Prefer several small steps to one long one. Small steps fail with clearer reasons and time out less.
- Each step stands alone: Revyl does not carry values from one step to the next. Put everything a step needs into its text.
- Every step runs Revyl's agent again; nothing is cached or replayed. Do not rerun a whole script to probe one step.
- Await each step. Two steps at once on one session throw `INVALID_ARGUMENT`.
- Do not catch `VerifyError` to make a check pass. A `NOT_AVAILABLE_ON_PLATFORM` error means the call is not offered on that platform; see [web.md](web.md) and [computers.md](computers.md). A `STEP_FAILED` error means the step did not run to an outcome, not that the app is wrong.
- Never automatically repeat a computer mutation after `ACTION_UNCERTAIN` or a timeout: the command may have run, and timeout does not prove termination or rollback. Do not log argv, stdin, file contents, or credentials.
- Always close what you open in `try/finally`. Each open session is paid. Automatic cleanup is best effort with a 15-second bound and skips signal/error events that already have listeners. Device close acknowledges stop, while computer close requires confirmed terminal release.
- Never put secrets in scripts or config. Credentials come from `REVYL_API_KEY` or a Revyl CLI login; web sign-in uses the **name** of a Revyl organization secret.
- Step descriptions are sent to Revyl and logged to stderr by default. Do not include private credentials or customer data in instruction or validation text; use test-only sign-in and synthetic data instead. `log: false` suppresses local progress, not remote processing or reports.
