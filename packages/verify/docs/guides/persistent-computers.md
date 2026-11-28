# Keep a Mac between runs: persistent computers and snapshots

A Mac from `open({ platform: 'mac' })` is deleted when it closes. A **persistent computer** keeps its whole disk instead: `openPersistent(name)` opens it, `close()` stops it and saves the disk, and the next `openPersistent(name)` boots from that disk, from any machine and from TypeScript, Python or Go. A **snapshot** names a stopped computer's saved disk, so new persistent computers can start from it.

Use cases below: a [dev environment](#dev-environment) you set up once, [parallel copies](#parallel-copies) from one snapshot, a [signed-in browser](#signed-in-browser), and a long-running [agent workspace](#agent-workspace).

The calls are in TypeScript since 0.7.0, Python (`open_persistent` and the rest) since 0.5.0 and Go (`OpenPersistent` and the rest) since v0.6.0. Persistent computers and snapshots come with paid Revyl plans. Without one, `openPersistent()` and `saveSnapshot()` throw `NOT_AVAILABLE_ON_PLATFORM` with reason `persistent_computers_not_enabled`; upgrade the organization's plan to use them.

## What is kept, and what isn't

| Kept on the same computer | Not kept |
| --- | --- |
| Everything on the disk: files, repositories, installed tools such as Homebrew packages, build products, simulators, app data, system settings, browser profiles and the login keychain | Memory and running processes. Every open is a cold boot, so start your servers again |

A computer started from a snapshot gets the same disk, except what is tied to the original Mac's hardware: Apple Account, iCloud and Safari's saved passwords don't carry over, and websites may open signed out. Anyone in your organization who can open computers can use what a snapshot holds, so don't snapshot a disk with secrets you wouldn't share with them.

## Lifetime, cost and limits

- **Stop and reopen.** `close()` returns once the disk is saved on its Mac, so you can reopen or delete the computer right away. If you reopen while a stop is still finishing, `openPersistent()` waits for it, within `startTimeout`.
- **Runs.** Each open is a new run with the usual computer lifetime: 2 hours by default, up to 24 hours with `timeoutMs` (Python `timeout` in seconds, Go `Timeout`), and `extend()` works as on any computer. A run starts saving its disk 3 minutes before it ends, and reaching the end keeps the disk, as `close()` does.
- **Cost.** A running persistent computer bills its minutes like any Mac. Saved disks and snapshots bill at $0.04 per GB-month while Revyl stores them, so a stopped computer still bills for its disk until you delete it.
- **How long a save lasts.** A computer's disk is kept until you delete the computer, and a snapshot until you delete it. A few saves have an end: `savedDiskExpiresAt` on `listPersistent()` and `listSnapshots()` entries (Python `saved_disk_expires_at`, Go `SavedDiskExpiresAt`) says when, if Revyl reports one. From then on that save can't start a computer, and opening it throws `SESSION_START_FAILED` (`saved_disk_expired` or `snapshot_expired`).
- **Limits.** An organization keeps at most 100 snapshots by default (`COMPUTER_LIMIT`, `snapshot_limit`). Persistent computers are Macs only.
- **Names.** 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. The same name opens the same computer from every language and machine. Revyl stores IDs, not names, so `listPersistent()` shows each computer's `id`; compare it with the `id` of the session `openPersistent()` returned. You can pass that ID instead of the name.

## Dev environment

A dev environment you set up once: install the tools once, then reuse them in every run. Mark the setup as done on the disk itself, so a setup that failed halfway runs again:

```ts
import { openPersistent } from '@revyl/verify';

const mac = await openPersistent('ios-dev');          // creates it the first time
try {
  const ready = await mac.exec(['test', '-f', '.setup-done'], { check: false });
  if (ready.exitCode !== 0) {
    await mac.exec(['/bin/zsh', '-lc', 'brew install swiftlint xcbeautify'], { timeout: 300_000 });
    await mac.exec(['git', 'clone', '--depth', '1', 'https://github.com/your-org/app', 'app'], { timeout: 300_000 });
    await mac.writeFile('.setup-done', 'v1\n');
  }
  await mac.exec(['git', '-C', 'app', 'pull'], { timeout: 120_000 });
  const lint = await mac.exec(['/bin/zsh', '-lc', 'cd app && swiftlint'], { timeout: 300_000, check: false });
  console.log(lint.stdout);
} finally {
  await mac.close();                                  // stops it and keeps the disk
}
```

`mac.created` is `true` when this call created the computer, but a marker file is the safer test. One command runs for at most 5 minutes (`timeout` up to 300000 ms), so split long setup into several commands.

The marker, the clone and everything else above land in the computer's workspace, `/Users/computer/workspace`, which is also `$HOME` for commands: `~/app` in a shell command is the `app` folder `git clone` made. File calls take paths relative to the workspace (`.setup-done`, not `~/.setup-done`) and refuse absolute ones, so reach other folders, such as `/Users/computer/Desktop`, through `exec()`.

Python:

```python
from revyl_verify import open_persistent

with open_persistent("ios-dev") as mac:  # leaving the block stops it and keeps the disk
    if mac.exec(["test", "-f", ".setup-done"], check=False).exit_code != 0:
        mac.exec(["/bin/zsh", "-lc", "brew install swiftlint xcbeautify"], timeout=300)
        mac.write_file(".setup-done", "v1\n")
    print(mac.exec(["/bin/zsh", "-lc", "swiftlint version"]).stdout)
```

Go:

```go
mac, err := verify.OpenPersistent(ctx, "ios-dev")
if err != nil {
	return err
}
defer mac.Close(context.Background()) // stops it and keeps the disk
ready, err := mac.Exec(ctx, []string{"test", "-f", ".setup-done"}, verify.ExecOptions{Check: new(false)})
if err != nil {
	return err
}
if ready.ExitCode != 0 {
	if _, err := mac.Exec(ctx, []string{"/bin/zsh", "-lc", "brew install swiftlint xcbeautify"}, verify.ExecOptions{Timeout: 5 * time.Minute}); err != nil {
		return err
	}
	if err := mac.WriteFile(ctx, ".setup-done", []byte("v1\n")); err != nil {
		return err
	}
}
```

## Parallel copies

Parallel runs from one prepared Mac: set a Mac up once, save it as a snapshot, then start a copy per shard. Each copy is its own persistent computer, so the runs don't touch each other:

```ts
import { openPersistent, saveSnapshot, deletePersistent, isVerifyError } from '@revyl/verify';

// Once: after the setup run above has closed 'ios-dev'.
await saveSnapshot('ios-dev', 'ios-dev-base');        // waits until the save is copied off its Mac, about 5 minutes after close()

// Every run: one copy per shard.
const shards = ['shard-1', 'shard-2'];
const opened = await Promise.allSettled(shards.map((name) => openPersistent(name, { fromSnapshot: 'ios-dev-base' })));
try {
  const macs = opened.map((result) => { if (result.status === 'rejected') throw result.reason; return result.value; });
  await Promise.all(macs.map((mac, i) => mac.exec(['/bin/zsh', '-lc', `cd app && ./run-tests.sh --shard ${i + 1}`], { timeout: 300_000 })));
} finally {
  for (const result of opened) if (result.status === 'fulfilled') await result.value.close();
  for (const name of shards) {
    await deletePersistent(name).catch((error) => { if (!isVerifyError(error) || error.code !== 'NOT_FOUND') throw error; });   // each copy's disk bills as storage until deleted
  }
}
```

- `Promise.allSettled` waits for every open, so when one copy fails, for example with `COMPUTER_LIMIT`, the copies that did open are still closed and deleted.
- `saveSnapshot()` needs a stopped computer: close it first, or it throws `SESSION_BUSY`. It waits until the save is copied off its Mac, up to `waitTimeout` (15 minutes by default), then throws `TIMEOUT`; calling it again keeps waiting. Snapshot names are unique in your organization.
- `fromSnapshot` is used only when the call creates the computer. If a computer with that name already exists, it opens as it is; check `created`.
- A copy usually starts on a different Mac than the one that saved the disk, so it restores the disk first and can take several minutes. `openPersistent()` waits up to `startTimeout`, 15 minutes by default.
- Each copy takes one of your organization's computer slots while it runs, so more shards than slots throw `COMPUTER_LIMIT`.

Python: `save_snapshot("ios-dev", "ios-dev-base")`, then `open_persistent("shard-1", from_snapshot="ios-dev-base")` and `delete_persistent("shard-1")`. Go: `verify.SaveSnapshot(ctx, "ios-dev", "ios-dev-base")`, then `verify.OpenPersistent(ctx, "shard-1", verify.OpenPersistentOptions{FromSnapshot: "ios-dev-base"})` and `verify.DeletePersistent(ctx, "shard-1")`.

## Signed-in browser

A browser that stays signed in: sign in to a site once, by hand, and the same computer opens signed in next time:

1. `const mac = await openPersistent('signed-in-safari')`, then `await mac.exec(['open', '-a', 'Safari', 'https://app.example.com/login'])`.
2. Open `mac.viewerUrl` in your browser, take control of the screen, and sign in. Signing in by hand keeps the password out of your script and its logs. With a test account, the script can sign in instead: `await mac.type({ target: 'the email field' }, email)`, the same for the password, then `await mac.tap({ target: 'the Sign in button' })`.
3. `await mac.close()`. The next `openPersistent('signed-in-safari')` boots with Safari's cookies where you left them.

This holds for that computer only. Copies started from a snapshot of it may open websites signed out, and Safari's saved passwords don't carry over. Sites still end sessions on their own schedule.

## Agent workspace

A long-running workspace for an agent: give a coding agent one Mac that keeps its checkout, build products and simulators between sessions:

```ts
const mac = await openPersistent('agent-workspace', { timeoutMs: 8 * 60 * 60 * 1000 });   // 8 hours for this run
try {
  // ... the agent works through exec(), the screen calls and, on an inference Mac, validation() ...
  await mac.extend(4 * 60 * 60 * 1000);                                                      // needs longer: keep it 4 more hours from now
} finally {
  await mac.close();
}
```

Every open is a cold boot, so the agent's first step each session is to start what it needs again. A run lasts at most 24 hours from when it opened. Lifetimes over 2 hours can be refused with `COMPUTER_LIMIT` (`computer_long_limit`) when your organization already has 2 such computers running.

## With local inference

`inference: true` on `openPersistent()` (Python `inference=True`, Go `Inference: true`) is used only when the call creates the computer, and the computer keeps it on every later start (passing it again on a reopen changes nothing, and `inference` on the session reads the model's readiness either way), so `validation()` and `extract()` work on it as described in [checks on the Mac's own screen](mac-model-checks.md):

```ts
const mac = await openPersistent('checked-dev', { inference: true });
await mac.validation('The Dock is visible at the bottom of the screen');
```

- A copy from a snapshot doesn't take the source computer's setting: pass `inference: true` with `fromSnapshot` when you want the model on it.
- When no Mac with a model is up, starting the computer throws `NOT_AVAILABLE_ON_PLATFORM` (`inference_unavailable`) and nothing starts. To start that one run without the model, pass `withoutInference: true` (Python `without_inference=True`, Go `WithoutInference: true`); later starts ask for the model again. A Revyl backend that doesn't offer it yet throws `INVALID_ARGUMENT` saying so.

## In CI: a timeout budget

Every wait has a default sized for a slow start, and they add up: `openPersistent()` waits up to 15 minutes (`startTimeout`), `close()` up to 10 minutes for the disk to save, `saveSnapshot()` up to 15 minutes (`waitTimeout`), and opening a copy from a snapshot another 15. That is close to an hour before your own commands, longer than many CI jobs. When the job's timeout kills the process first, `finally` never runs, so the computer isn't closed and keeps running and billing until its lifetime ends.

So give the job a timeout, and set each wait so that their sum plus your commands fits inside it, with room to spare. Set the run's `timeoutMs` too: it is enforced on Revyl's side, so even a killed job leaves a computer that stops itself, and keeps its disk, when that time is up.

```yaml
jobs:
  mac:
    runs-on: ubuntu-latest
    timeout-minutes: 45          # the budget: 10 open + 10 work + 10 close + 10 snapshot, with 5 to spare
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: npm ci
      - run: node verify/mac-ci.mts
        env:
          REVYL_API_KEY: ${{ secrets.REVYL_API_KEY }}
```

```ts
import { openPersistent, saveSnapshot } from '@revyl/verify';

const mac = await openPersistent('ci-cache', {
  startTimeout: 10 * 60_000,     // fail after 10 minutes instead of 15
  timeoutMs: 30 * 60_000,        // Revyl stops this run after 30 minutes, keeping the disk, even if the job is killed
});
try {
  await mac.exec(['/bin/zsh', '-lc', 'cd app && ./build.sh'], { timeout: 300_000 });
} finally {
  await mac.close();             // waits up to 10 minutes for the disk to save
}
await saveSnapshot('ci-cache', 'ci-cache-base', { waitTimeout: 10 * 60_000 });
```

A wait that runs out throws `TIMEOUT`, and the two differ. `openPersistent()` stops a computer it started but couldn't get ready in time, keeping its disk, so calling it again starts the computer again: raise `startTimeout` for a slow start rather than retrying with the same value. `saveSnapshot()` saves nothing until the stopped computer's disk is copied off its Mac, and that copy goes on in Revyl, so calling it again keeps waiting; `close()` likewise leaves a disk save it couldn't confirm running. Python takes seconds (`open_persistent(name, start_timeout=600, timeout=1800)`, `save_snapshot(computer, name, wait_timeout=600)`); Go takes durations (`OpenPersistentOptions{StartTimeout: 10 * time.Minute, Timeout: 30 * time.Minute}`, `SaveSnapshotOptions{WaitTimeout: 10 * time.Minute}`).

## Clean up

```ts
import { deletePersistent, deleteSnapshot, listPersistent, listSnapshots } from '@revyl/verify';

console.log(await listPersistent());              // [{ id, state, savedAt?, savedOffHost, createdAt, savedDiskExpiresAt? }]
console.log(await listSnapshots());               // [{ id, name, computerId, savedAt, expiresAt?, savedDiskExpiresAt? }]
await deletePersistent('ios-dev');                // a running one stops first, saving its disk; then the computer and its disk go for good
await deleteSnapshot('ios-dev-base');             // computers already started from it keep their disks
```

Deleting a computer keeps its snapshots, and deleting a snapshot keeps the computers made from it. Both throw `NOT_FOUND` when there is nothing by that name or ID, including a computer or snapshot already deleted, so cleanup that runs twice should catch it. Python: `list_persistent()`, `list_snapshots()`, `delete_persistent()`, `delete_snapshot()`. Go: `ListPersistent`, `ListSnapshots`, `DeletePersistent`, `DeleteSnapshot`.

## Errors

`error.reason` is set for `persistent_computers_not_enabled`; for the other refusals the message names the code in parentheses.

| What happened | Error and code | What to do |
| --- | --- | --- |
| Your organization isn't on a paid Revyl plan | `NOT_AVAILABLE_ON_PLATFORM`, reason `persistent_computers_not_enabled` | Upgrade the organization's plan |
| The computer's last run hasn't finished saving | `SESSION_BUSY` (`run_conflict`) | Try again in a few minutes; the disk is kept |
| `saveSnapshot()` on a running computer | `SESSION_BUSY` | `close()` it first |
| The save isn't copied off its Mac within `waitTimeout` | `TIMEOUT` | Call `saveSnapshot()` again |
| The snapshot name is taken | `INVALID_ARGUMENT` | Pick another name or delete the old snapshot |
| The Mac holding a save is offline and the save isn't copied yet | `SESSION_START_FAILED` (`saved_disk_unavailable`) | Try again later; the disk is kept |
| A save has reached its end | `SESSION_START_FAILED` (`saved_disk_expired`, `snapshot_expired`) | Delete the computer and create a new one, or save a new snapshot |
| 100 snapshots already, by default | `COMPUTER_LIMIT` (`snapshot_limit`) | Delete ones you no longer need |
| No computer or snapshot by that name or ID | `NOT_FOUND` | Check `listPersistent()` or `listSnapshots()` |

See [computers.md](../computers.md) for everything a computer does while it runs, and [a cloud Mac your agent can drive](mac-computer.md) for a first script.
