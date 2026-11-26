# Keep a Mac between runs: persistent computers and snapshots

A Mac from `open({ platform: 'mac' })` is deleted when it closes. A **persistent computer** keeps its whole disk instead: `openPersistent(name)` opens it, `close()` stops it and saves the disk, and the next `openPersistent(name)` boots from that disk, from any machine and from TypeScript, Python or Go. A **snapshot** names a stopped computer's saved disk, so new persistent computers can start from it.

The calls are in TypeScript since 0.7.0, Python (`open_persistent` and the rest) since 0.5.0 and Go (`OpenPersistent` and the rest) since v0.6.0. Persistent computers and snapshots are enabled per organization. Without them, `openPersistent()` and `saveSnapshot()` throw `NOT_AVAILABLE_ON_PLATFORM` with reason `persistent_computers_not_enabled`; ask [support@revyl.ai](mailto:support@revyl.ai) to turn them on.

## What is kept, and what isn't

| Kept on the same computer | Not kept |
| --- | --- |
| Everything on the disk: files, repositories, installed tools such as Homebrew packages, build products, simulators, app data, system settings, browser profiles and the login keychain | Memory and running processes. Every open is a cold boot, so start your servers again |

A computer started from a snapshot gets the same disk, except what is tied to the original Mac's hardware: Apple Account, iCloud and Safari's saved passwords don't carry over, and websites may open signed out. Anyone in your organization who can open computers can use what a snapshot holds, so don't snapshot a disk with secrets you wouldn't share with them.

## Lifetime, cost and limits

- **Stop and reopen.** `close()` returns once the disk is saved on its Mac, so you can reopen or delete the computer right away. If you reopen while a stop is still finishing, `openPersistent()` waits for it, within `startTimeout`.
- **Runs.** Each open is a new run with the usual computer lifetime: 2 hours by default, up to 24 hours with `timeoutMs` (Python `timeout` in seconds, Go `Timeout`), and `extend()` works as on any computer. A run starts saving its disk 3 minutes before it ends, and reaching the end keeps the disk, as `close()` does.
- **Cost.** A running persistent computer bills its minutes like any Mac. It costs nothing while stopped; Revyl doesn't charge for stored disks and snapshots while persistent computers are in limited preview.
- **How long a save lasts.** A computer's disk is kept until you delete the computer, and a snapshot until you delete it. A few saves have an end: `savedDiskExpiresAt` on `listPersistent()` and `listSnapshots()` entries (Python `saved_disk_expires_at`, Go `SavedDiskExpiresAt`) says when, if Revyl reports one. From then on that save can't start a computer, and opening it throws `SESSION_START_FAILED` (`saved_disk_expired` or `snapshot_expired`).
- **Limits.** An organization keeps at most 10 persistent computers and 100 snapshots unless Revyl raised its limits (`COMPUTER_LIMIT`, reason `persistent_computer_limit` or `snapshot_limit`). Persistent computers are Macs only.
- **Names.** 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. The same name opens the same computer from every language and machine. Revyl stores IDs, not names, so `listPersistent()` shows each computer's `id`; compare it with the `id` of the session `openPersistent()` returned. You can pass that ID instead of the name.

## Use case: a dev environment you set up once

Install the tools once, then reuse them in every run. Mark the setup as done on the disk itself, so a setup that failed halfway runs again:

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

## Use case: parallel runs from one prepared Mac

Set a Mac up once, save it as a snapshot, then start a copy per shard. Each copy is its own persistent computer, so the runs don't touch each other:

```ts
import { openPersistent, saveSnapshot, deletePersistent } from '@revyl/verify';

// Once: after the setup run above has closed 'ios-dev'.
await saveSnapshot('ios-dev', 'ios-dev-base');        // waits until the save is copied off its Mac, about 5 minutes after close()

// Every run: one copy per shard.
const shards = ['shard-1', 'shard-2'];
const macs = await Promise.all(shards.map((name) => openPersistent(name, { fromSnapshot: 'ios-dev-base' })));
try {
  await Promise.all(macs.map((mac, i) => mac.exec(['/bin/zsh', '-lc', `cd app && ./run-tests.sh --shard ${i + 1}`], { timeout: 300_000 })));
} finally {
  for (const mac of macs) await mac.close();
  for (const name of shards) await deletePersistent(name);   // copies count toward your 10 until deleted
}
```

- `saveSnapshot()` needs a stopped computer: close it first, or it throws `SESSION_BUSY`. It waits until the save is copied off its Mac, up to `waitTimeout` (15 minutes by default), then throws `TIMEOUT`; calling it again keeps waiting. Snapshot names are unique in your organization.
- `fromSnapshot` is used only when the call creates the computer. If a computer with that name already exists, it opens as it is; check `created`.
- A copy usually starts on a different Mac than the one that saved the disk, so it restores the disk first and can take several minutes. `openPersistent()` waits up to `startTimeout`, 15 minutes by default.
- Each copy takes one of your organization's computer slots while it runs, so more shards than slots throw `COMPUTER_LIMIT`.

Python: `save_snapshot("ios-dev", "ios-dev-base")`, then `open_persistent("shard-1", from_snapshot="ios-dev-base")` and `delete_persistent("shard-1")`. Go: `verify.SaveSnapshot(ctx, "ios-dev", "ios-dev-base")`, then `verify.OpenPersistent(ctx, "shard-1", verify.OpenPersistentOptions{FromSnapshot: "ios-dev-base"})` and `verify.DeletePersistent(ctx, "shard-1")`.

## Use case: a browser that stays signed in

Sign in to a site once, by hand, and the same computer opens signed in next time:

1. `const mac = await openPersistent('signed-in-safari')`, then `await mac.exec(['open', '-a', 'Safari', 'https://app.example.com/login'])`.
2. Open `mac.viewerUrl` in your browser, take control of the screen, and sign in. Signing in by hand keeps the password out of your script and its logs.
3. `await mac.close()`. The next `openPersistent('signed-in-safari')` boots with Safari's cookies where you left them.

This holds for that computer only. Copies started from a snapshot of it may open websites signed out, and Safari's saved passwords don't carry over. Sites still end sessions on their own schedule.

## Use case: a long-running workspace for an agent

Give a coding agent one Mac that keeps its checkout, build products and simulators between sessions:

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

## Clean up

```ts
import { deletePersistent, deleteSnapshot, listPersistent, listSnapshots } from '@revyl/verify';

console.log(await listPersistent());              // [{ id, state, savedAt?, savedOffHost, createdAt, savedDiskExpiresAt? }]
console.log(await listSnapshots());               // [{ id, name, computerId, savedAt, expiresAt?, savedDiskExpiresAt? }]
await deletePersistent('ios-dev');                // the computer and its disk, for good; a running one stops first, without saving
await deleteSnapshot('ios-dev-base');             // computers already started from it keep their disks
```

Deleting a computer keeps its snapshots, and deleting a snapshot keeps the computers made from it. Both throw `NOT_FOUND` when there is nothing by that name or ID, so cleanup that runs twice should catch it. Python: `list_persistent()`, `list_snapshots()`, `delete_persistent()`, `delete_snapshot()`. Go: `ListPersistent`, `ListSnapshots`, `DeletePersistent`, `DeleteSnapshot`.

## Errors

`error.reason` is set for `persistent_computers_not_enabled`; for the other refusals the message names the code in parentheses.

| What happened | Error and code | What to do |
| --- | --- | --- |
| Persistent computers aren't enabled for your organization | `NOT_AVAILABLE_ON_PLATFORM`, reason `persistent_computers_not_enabled` | Ask support@revyl.ai |
| The computer's last run hasn't finished saving | `SESSION_BUSY` (`run_conflict`) | Try again in a few minutes; the disk is kept |
| `saveSnapshot()` on a running computer | `SESSION_BUSY` | `close()` it first |
| The save isn't copied off its Mac within `waitTimeout` | `TIMEOUT` | Call `saveSnapshot()` again |
| The snapshot name is taken | `INVALID_ARGUMENT` | Pick another name or delete the old snapshot |
| The Mac holding a save is offline and the save isn't copied yet | `SESSION_START_FAILED` (`saved_disk_unavailable`) | Try again later; the disk is kept |
| A save has reached its end | `SESSION_START_FAILED` (`saved_disk_expired`, `snapshot_expired`) | Delete the computer and create a new one, or save a new snapshot |
| 10 computers or 100 snapshots already | `COMPUTER_LIMIT` | Delete ones you no longer need |
| No computer or snapshot by that name or ID | `NOT_FOUND` | Check `listPersistent()` or `listSnapshots()` |

See [computers.md](../computers.md) for everything a computer does while it runs.
