# A cloud Mac your agent can drive

`open({ platform: 'mac' })` gives a script or a coding agent a whole cloud Mac: run commands, read and write files, click and type in macOS apps by describing what to click, take screenshots, and get the screen recording afterwards. This guide builds a Swift file on the Mac, then edits a document in TextEdit through its screen.

Mac computers come with Revyl Pro: they need an organization on a current paid plan.

## What you'll build

A script that:

1. Opens a Mac computer.
2. Writes `hello.swift`, compiles it with `swiftc` and runs it, all through `exec()`.
3. Opens a file in TextEdit, types into the window by description, saves with Command+S and reads the file back.
4. Clicks a menu by description, takes a screenshot and closes the Mac.
5. Prints how long the screen recording is.

## Before you start

- A Revyl account on a paid plan, signed in with `npx @revyl/verify login` or with `REVYL_API_KEY` set.
- Node.js 22.18 or later and `npm install @revyl/verify` in an ESM project.

## The script

Save this as `mac-computer.mts`:

```ts
import { open } from '@revyl/verify';
import { setTimeout as sleep } from 'node:timers/promises';

const mac = await open({ platform: 'mac', timeoutMs: 15 * 60_000 });
console.log(`Live view: ${mac.viewerUrl}`);
try {
  await mac.writeFile('hello.swift', 'print("Hello from a cloud Mac")\n');
  await mac.exec(['swiftc', 'hello.swift', '-o', 'hello'], { timeout: 180_000 });
  const run = await mac.exec(['./hello']);
  console.log(`Built and ran hello.swift: ${run.stdout.trim()}`);

  await mac.writeFile('notes.txt', '');
  await mac.exec(['open', '-a', 'TextEdit', 'notes.txt']);
  await sleep(3_000);
  await mac.type({ target: 'the white text area of the TextEdit window' }, 'Written by an agent on a cloud Mac.');
  await mac.pressKey('s', { modifiers: ['meta'] });
  await sleep(1_000);
  console.log(`notes.txt now says: ${(await mac.readFile('notes.txt')).toString().trim()}`);

  await mac.tap({ target: 'the Format menu in the menu bar' });
  await mac.screenshot({ path: 'mac.png' });
  await mac.pressKey('escape');
} finally {
  await mac.close();
}

const recording = await mac.recording();
console.log(recording ? `Recording saved: ${recording.durationSeconds ?? '?'} s` : 'No recording was saved.');
```

Run it with `node mac-computer.mts` (the `.mts` extension makes Node run it as an ES module in any project):

```text
[verify] mac: starting computer https://app.revyl.ai/sessions/<id>?kind=computer
[verify] mac: ready
Live view: https://app.revyl.ai/sessions/<id>?kind=computer
Built and ran hello.swift: Hello from a cloud Mac
notes.txt now says: Written by an agent on a cloud Mac.
[verify] mac: closed
[verify] mac: waiting for Revyl to save the recording
Recording saved: 31.14 s
```

A run takes 2 to 4 minutes, most of it starting the Mac and saving the recording.

## How it works

- **Commands and files.** `exec(argv)` runs a program with its arguments, not a shell line, in the computer's workspace folder; it throws `COMMAND_FAILED` on a non-zero exit unless you pass `{ check: false }`. For a shell, run `['/bin/zsh', '-lc', '…']`. One command runs at most 5 minutes (`timeout` up to 300000 ms). `writeFile()` takes up to 64 KiB and `readFile()` returns up to the first 1 MiB, by paths relative to the workspace, `/Users/computer/workspace`, which is also `$HOME` for commands. File calls don't expand `~` and refuse absolute paths: write `notes.txt`, and move a file elsewhere with `exec(['mv', …])`.
- **The screen, by description.** `tap({ target })` and `type({ target }, text)` find the element on a fresh screenshot and click it; `type` then selects the field's text and types, so the text replaces what was there; pass `{ clear: false }` to type at the click without selecting, for example to add to a document that already has text. Each takes several seconds and returns the point it clicked. They can click a look-alike, so check the result, as the script does by reading the file back.
- **Keys.** `pressKey()` takes `'enter'`, `'escape'`, `'tab'`, arrows and more, and `modifiers`, where `'meta'` is Command and `'alt'` is Option.
- **No `instruction()`.** On a Mac computer you drive the screen with the calls above; `instruction()` and your own model throw `NOT_AVAILABLE_ON_PLATFORM`. `validation()` and `extract()` throw it too unless the Mac was opened with `inference: true`; see [Check a Mac's screen with its own model](mac-model-checks.md).
- **Open apps with `exec()`.** `['open', '-a', 'TextEdit', 'notes.txt']`. Open TextEdit with a file: without one it may show a file picker.
- **Recording.** Call `recording()` after `close()`, on the same object and before the script exits. It waits until Revyl has saved the video and returns `{ url, durationSeconds?, startedAt? }`, or `null`. The `url` is signed: treat it as a credential.

## Python

```python
import time

from revyl_verify import Target, open

with open(Target(platform="mac", timeout=900)) as mac:
    print("Live view:", mac.viewer_url)
    mac.write_file("hello.swift", 'print("Hello from a cloud Mac")\n')
    mac.exec(["swiftc", "hello.swift", "-o", "hello"], timeout=180)
    print(mac.exec(["./hello"]).stdout.strip())

    mac.write_file("notes.txt", "")
    mac.exec(["open", "-a", "TextEdit", "notes.txt"])
    time.sleep(3)
    mac.type("the white text area of the TextEdit window", "Written by an agent on a cloud Mac.")
    mac.press_key("s", modifiers=["meta"])
    time.sleep(1)
    print(mac.read_file("notes.txt").decode().strip())
    mac.tap("the Format menu in the menu bar")
    mac.screenshot(path="mac.png")
    mac.press_key("escape")

recording = mac.recording()  # after the with block has closed the Mac
print(recording.duration_seconds if recording else "No recording was saved.")
```

Python timeouts are in seconds.

## Go

```go
mac, err := verify.Open(ctx, verify.Target{Platform: verify.Mac})
if err != nil {
	return err
}
defer mac.Close(context.Background()) // stops the Mac when a step fails; a no-op after the Close below
fmt.Println("Live view:", mac.ViewerURL())
if err := mac.WriteFile(ctx, "hello.swift", []byte("print(\"Hello from a cloud Mac\")\n")); err != nil {
	return err
}
if _, err := mac.Exec(ctx, []string{"swiftc", "hello.swift", "-o", "hello"}, verify.ExecOptions{Timeout: 3 * time.Minute}); err != nil {
	return err
}
run, err := mac.Exec(ctx, []string{"./hello"})
if err != nil {
	return err
}
fmt.Println(strings.TrimSpace(run.Stdout))
if _, err := mac.Exec(ctx, []string{"open", "-a", "TextEdit", "hello.swift"}); err != nil {
	return err
}
time.Sleep(3 * time.Second)
if _, err := mac.Tap(ctx, verify.Element("the Format menu in the menu bar")); err != nil {
	return err
}
if err := mac.PressKey(ctx, verify.KeyEscape); err != nil {
	return err
}
if err := mac.Close(ctx); err != nil {
	return err
}
recording, err := mac.Recording(ctx) // after Close, on the same session
if err != nil {
	return err
}
if recording != nil && recording.Duration != nil {
	fmt.Println("Recording saved:", *recording.Duration)
}
```

`Type(ctx, verify.Element("…"), text)` types into a described field, and `PressKey(ctx, verify.Key("s"), verify.KeyOptions{Modifiers: []verify.KeyModifier{verify.ModifierMeta}})` presses Command+S.

## Limits and errors

| What happened | Error | What to do |
| --- | --- | --- |
| Your organization isn't on a paid plan | `NOT_AVAILABLE_ON_PLATFORM`, reason `upgrade_required` | Upgrade to Pro; the message has the link |
| No Mac was free, or your organization runs as many as it may | `COMPUTER_LIMIT` | Try again later; Verify doesn't retry creation |
| A command exited non-zero | `COMMAND_FAILED` | Read the reason, or pass `{ check: false }` and read `exitCode`, `stdout`, `stderr` |
| Someone controls the screen in the Revyl viewer | `SESSION_BUSY` | Try again after they release it |
| Revyl couldn't confirm a screen action, for example `screen_unavailable` | `ACTION_UNCERTAIN`; Verify doesn't repeat it | Take a `screenshot()` to see whether it happened, then repeat it only if it didn't |
| `recording()` before `close()` | `SESSION_BUSY` | Close the computer first |

A Mac runs at most its lifetime from create: 2 hours by default, up to 24 hours with `timeoutMs`, and `extend()` keeps a running one longer. [computers.md](../computers.md) covers everything else.

## Clean up

`close()` in `finally` stops the Mac and deletes it. Verify also tries to close it on Ctrl+C, SIGTERM or an uncaught error, but a process killed outright leaves it running, and billing, until its lifetime ends, so keep `timeoutMs` short for scripts like this one.

## Next

- [computers.md](../computers.md) for processes, `stat()`, `extend()` and the screen rules.
- [Check a Mac's screen with its own model](mac-model-checks.md): `validation()` and `extract()` on a Mac opened with `inference`, new in 0.8.0.
- [Keep a Mac between runs](persistent-computers.md): persistent computers and snapshots.
- [Check an iOS change from your coding agent](check-an-ios-change.md) for apps on a simulator.
