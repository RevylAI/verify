# Check a Mac's screen with its own model

**New in TypeScript 0.8.0, Python 0.6.0 and Go v0.7.0.** A Mac computer opened with `inference` runs on a Revyl Mac that has its own vision model. `validation()` checks a statement against the Mac's screen and `extract()` reads a value off it, and that model answers both, next to the computer, in about 2 to 3 seconds.

Local inference comes with paid Revyl plans. If your organization isn't on one, opening the Mac throws `NOT_AVAILABLE_ON_PLATFORM` with reason `inference_not_enabled`; upgrade the organization's plan to use it.

## What it costs

Steps on a computer have no per-step fee. `validation()` and `extract()` on a Mac run only on that Mac's own model, so they carry no inference charge: you pay the Mac's minutes, as for any computer.

## Open the Mac and check its screen

TypeScript:

```ts
import { open } from '@revyl/verify';

const mac = await open({ platform: 'mac', inference: true });
try {
  console.log('Model:', mac.inference);                                        // 'ready', 'unavailable' or 'unknown'
  await mac.validation('The Dock is visible at the bottom of the screen');      // throws VALIDATION_FAILED if not
  const date = await mac.extract('the date at the right end of the menu bar');
  console.log(date.value, date.engine);                                         // e.g. 'Thu Nov 26' 'local'
} finally {
  await mac.close();
}
```

Python:

```python
from revyl_verify import Target, open

with open(Target(platform="mac", inference=True)) as mac:
    print("Model:", mac.inference)  # "ready", "unavailable" or "unknown"
    mac.validation("The Dock is visible at the bottom of the screen")  # raises VALIDATION_FAILED if not
    date = mac.extract("the date at the right end of the menu bar")
    print(date.value, date.engine)  # e.g. Thu Nov 26 local
```

Go (`new(true)` needs Go 1.26, which the module already requires):

```go
mac, err := verify.Open(ctx, verify.Target{Platform: verify.Mac, Inference: new(true)})
if err != nil {
	return err
}
defer mac.Close(context.Background())
fmt.Println("Model:", mac.Inference()) // ready, unavailable or unknown
if _, err := mac.Validation(ctx, "The Dock is visible at the bottom of the screen"); err != nil {
	return err // ErrValidationFailed if not
}
date, err := mac.Extract(ctx, "the date at the right end of the menu bar")
if err != nil {
	return err
}
fmt.Println(date.Value, date.Engine) // e.g. Thu Nov 26 local
```

Runnable versions: [examples/mac-inference](https://github.com/RevylAI/verify/tree/main/examples/mac-inference), [python/examples/mac_inference.py](https://github.com/RevylAI/verify/blob/main/python/examples/mac_inference.py) and [go/examples/macinference](https://github.com/RevylAI/verify/tree/main/go/examples/macinference).

## Check the result of your own commands

The model reads the screen, so pair it with `exec()` and the screen calls. Open something, then check what is on screen:

```ts
await mac.writeFile('notes.txt', 'Release notes for 2.4\n');
await mac.exec(['open', '-a', 'TextEdit', 'notes.txt']);
await new Promise((resolve) => setTimeout(resolve, 3_000));             // let the window open
await mac.validation('A TextEdit window shows the text "Release notes for 2.4"');
const title = await mac.extract('the title of the frontmost window');
```

To check without throwing, pass `{ soft: true }` (Python `soft=True`, Go `verify.ValidationOptions{Soft: true}`) and read `passed`.

## Write steps the model can answer

- **One statement or one value per step.** `'The Save button is enabled'`, not `'The file saved and the button is enabled'`. For `extract()`, describe one value that is on the screen now, such as `'the version number in the About window'`.
- **Run one step at a time per computer.** The Mac's model answers one step at a time, shared with the app sessions inside the computer. Await each step before the next.
- **An answer the model can't confirm is never a pass.** When it can't decide, or `extract()` finds nothing, the step throws `STEP_FAILED` with the model's reason, such as `local_model_found_no_value`. Change the description, or take a `screenshot()` to see what was on the screen.
- **`instruction()` stays off on computers.** To click one thing by its description, use `tap({ target: 'the Save button' })`; to type into a field, use `type({ target: 'the search field' }, text)`. Python: `tap("the Save button")` and `type("the search field", text)`. Go: `Tap(ctx, verify.Element("the Save button"))` and `Type(ctx, verify.Element("the search field"), text)`.

## When the model isn't there

`inference` on the computer (Python `inference`, Go `Inference()`) is `'ready'` when its model answered when Verify last read the computer's report, `'unavailable'` when it didn't, and `'unknown'` while that can't be told yet. Verify reads the report when the computer opens and on each `report()`; in our runs it read `'ready'` as soon as `open()` returned. On a computer opened without inference it is `undefined` (Python `None`, Go `""`).

`error.reason` holds the code for every refusal below except the two `SESSION_BUSY` rows, whose message names it.

| What happened | Error and code | What to do |
| --- | --- | --- |
| Your organization isn't on a paid Revyl plan | `NOT_AVAILABLE_ON_PLATFORM`, `inference_not_enabled`, when opening | Upgrade the organization's plan, or open the Mac without `inference` |
| No Mac with a model is free right now | `NOT_AVAILABLE_ON_PLATFORM`, `inference_unavailable`, when opening; nothing was started | Try again later, or open the Mac without `inference` |
| `validation()` or `extract()` on a Mac opened without `inference`, or its model stopped answering | `NOT_AVAILABLE_ON_PLATFORM`, `step_engine_unavailable`; the step didn't run | Open the Mac with `inference`; if it was, check `inference` and try again shortly |
| The model was busy with another step for too long | `SESSION_BUSY`, `step_engine_busy` | Run one step at a time, and try again in a few seconds |
| Someone controls the screen in the Revyl viewer | `SESSION_BUSY`, `screen_control_held` | Try again after they release it |
| A Linux computer | `NOT_AVAILABLE_ON_PLATFORM` before anything is sent | Use a Mac |

New to Mac computers? [A cloud Mac your agent can drive](mac-computer.md) covers commands, files and the screen. See [computers.md](../computers.md) for everything else a computer does, and [apps inside an inference Mac](apps-inside-an-inference-mac.md) to run an iOS or Web app's steps on the same model.
