# Use your own model

**Early access.** Since TypeScript (`@revyl/verify`) 0.4.0, Python (`revyl-verify`) 0.2.0 and Go v0.3.0; the [Python](https://github.com/RevylAI/verify/blob/v0.5.0/python/README.md#your-own-model) and [Go](https://github.com/RevylAI/verify/blob/v0.5.0/go/README.md#your-own-model) READMEs show them with each language's names. Verify normally runs `instruction()` and `validation()` on Revyl's agent. Pass a `model` and the agent loop runs in your process instead, on a model you choose, with your own key. Revyl still provides the cloud browser or device and, by default, finds the elements your model names on screen.

Use it when you want a specific model, your own prompts and key, or faster steps on a cheap model. Leave `model` out and nothing changes.

Your model uses the same [exact actions](api.md#exact-actions) you can call yourself: `tap`, `doubleTap`, `longPress`, `type`, `swipe`, `drag`, `pressKey`, `openUrl` and, where the platform has them, `typeFocused` and Web keys with modifiers (Web), `back` (Web and Android) and `goHome` (iOS and Android). So a script can mix your own actions, steps on your model and steps on Revyl's agent.

## The one-line form

```ts
import { open } from '@revyl/verify';

const session = await open('ios', { model: 'anthropic/claude-sonnet-5-5' });
try {
  const step = await session.instruction('Open General, then About');
  console.log(step.model); // { id, grounding, turns, inputTokens, outputTokens }
  await session.validation('The screen shows the iOS version');
} finally {
  await session.close();
}
```

That needs only your Revyl sign-in, as for any Verify script, and the provider's key in its usual environment variable, here `ANTHROPIC_API_KEY`. The key is read when the step's agent is built, and a missing key fails before any session starts.

The same works in Python and Go. Python uses snake_case (`model=`, `CustomModel(id, base_url, api_key, headers, provider)`, `local_agent()`, `anthropic()`, `openai_compatible()`) on both the sync and the asyncio API, with timeouts in seconds. Go uses options (`verify.WithModel`, `verify.WithCustomModel`, `verify.WithAgent(verify.LocalAgent{...})`) with `verify.Anthropic` and `verify.OpenAICompatible`. Providers, key variables, base-URL handling, limits and error codes are the same in all three.

```python
from revyl_verify import Target, open

with open(
    Target(platform="ios", bundle_id="com.apple.Preferences"),
    model="anthropic/claude-sonnet-5-5",
) as session:
    step = session.instruction("Open General, then About")
    print(step.model)  # ModelRun(id, grounding, turns, input_tokens, output_tokens)
    session.validation("The screen shows the iOS version")
```

```go
s, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"},
	verify.WithModel("anthropic/claude-sonnet-5-5"))
if err != nil {
	return err
}
defer s.Close(context.Background())
step, err := s.Instruction(ctx, "Open General, then About")
if err != nil {
	return err
}
log.Println(step.Model.ID, len(step.Model.Turns), step.Model.InputTokens, step.Model.OutputTokens)
_, err = s.Validation(ctx, "The screen shows the iOS version")
```

The [Python](https://github.com/RevylAI/verify/blob/v0.5.0/python/README.md#your-own-model) and [Go](https://github.com/RevylAI/verify/blob/v0.5.0/go/README.md#your-own-model) READMEs have the full reference for each.

Set `model` on `open()` to run every step on it, or on one step to override it:

```ts
await session.instruction('Open Privacy', { model: 'openai/gpt-5.5' });
await session.validation('Location Services is on', { model: 'google/gemini-3.8-flash' });
```

## Providers

The string is `'provider/model'`. Everything after the first slash is the provider's own model name, so `'openrouter/anthropic/claude-sonnet-5-5'` works.

| Prefix | Key variable | Endpoint | Status |
| --- | --- | --- | --- |
| `anthropic/` | `ANTHROPIC_API_KEY` | Anthropic Messages API | The one-line form run live against an Anthropic-compatible proxy with Claude Sonnet 5.5, real screenshots and tool schemas; the run on a Revyl device is pending |
| `openai/` | `OPENAI_API_KEY` | `https://api.openai.com/v1` | Request shape checked; not yet run live |
| `google/` | `GOOGLE_API_KEY`, or `GEMINI_API_KEY` when it is unset | `https://generativelanguage.googleapis.com/v1beta/openai/` | Request shape checked; not yet run live |
| `openrouter/` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | Request shape checked; not yet run live |
| `groq/` | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | Request shape checked; not yet run live |
| `cerebras/` | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` | Run live on iOS and Web with `qwen-3.8-27b` |
| `xai/` | `XAI_API_KEY` | `https://api.x.ai/v1` | Request shape checked; not yet run live |
| `ollama/` | none | `http://localhost:11434/v1` | Request shape checked; not yet run live |

`anthropic/` and `openai/` also read `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`, as the vendors' own SDKs do; see [behind a proxy or gateway](#behind-a-proxy-or-gateway).

"Request shape checked" means Verify's requests and response parsing were checked against a local fake of that API, not against the provider itself. Expect rough edges on those until they are run live.

## Picking a model

The model must accept images and support tool calls. Each turn it gets one screenshot and must call exactly one tool, such as `tap` or `done`.

By default your model names the element it wants ("General row") and Revyl's grounding model finds it. That is `grounding: 'revyl'`, and it means the model never has to point at pixels, so a small, fast vision model is usually enough. The alternative, `grounding: 'model'`, has the model give screenshot coordinates itself. It keeps element descriptions away from Revyl but needs a model that points accurately.

Measured in production on Cerebras `qwen-3.8-27b`, a fast vision model (about 0.6 s per call) that cannot point accurately:

| Flow | Agent | Instruction | Validation | Turns | Tokens in/out |
| --- | --- | --- | --- | --- | --- |
| iOS Settings: open General, then About; check the OS version | Revyl's agent | pass, 37.4 s | pass, 9.8 s | | |
| | your model, `grounding: 'revyl'` | pass, 11.1 s to 15.2 s | pass, 1.4 s to 1.5 s | 3 + 1 | 3,957/215 + 800/122 |
| | your model, `grounding: 'model'` | fail after 20 turns, 66.3 s | | 20 | 33,832 total |
| Web: sign in to a demo store; check the product list | Revyl's agent | pass, 58.0 s | pass, 9.6 s | | |
| | your model, `grounding: 'revyl'` | pass, 21.2 s | pass, 1.3 s | 4 + 1 | 7,854/355 + 1,380/136 |
| | your model, `grounding: 'model'` | fail after 20 turns, 64.4 s | | 20 | 52,726 total |

Each local turn costs one model call plus one device action: about 3.7 s per turn on iOS and 5.3 s on Web here, most of it the device action and the screen settling. These are two short flows on one model, so treat them as a direction, not a benchmark. Claude, GPT and Gemini have not been measured yet, and `grounding: 'model'` has not yet been shown to pass with any model.

Start with the default grounding and the cheapest vision model your provider has. Move to a stronger model if steps run out of turns or pick the wrong elements.

## Your own endpoint

Any server that speaks OpenAI's chat completions with tools and image input works through an object:

```ts
await open('ios', {
  model: {
    id: 'qwen-3.8-27b',                     // the model name the server expects
    baseURL: 'https://my-gateway.example/v1', // the root that serves /chat/completions
    apiKey: process.env.MY_GATEWAY_KEY,       // optional, sent as a bearer token
    headers: { 'x-team': 'mobile' },          // optional, extra headers
    provider: 'qwen',                         // optional, reported as 'qwen/qwen-3.8-27b'
  },
});
```

The key comes only from `apiKey`. Verify never reads an environment variable for a custom endpoint, so a key meant for one provider can't reach another server. This covers vLLM, LiteLLM, LM Studio, Azure-style gateways and self-hosted models. For Ollama on your machine, `'ollama/qwen3-vl:8b'` is the short form of `{ id: 'qwen3-vl:8b', baseURL: 'http://localhost:11434/v1' }`. Pull a vision model that supports tools first, and expect slow turns without a GPU. For OpenRouter, `'openrouter/<their model id>'` reaches every model they list.

## Behind a proxy or gateway

Many teams reach models through a proxy or an LLM gateway with its own key. Two ways work:

1. Keep the one-line form and point the provider's base-URL variable at the proxy, the same variables Anthropic's and OpenAI's SDKs read:

   ```bash
   export ANTHROPIC_BASE_URL=https://llm-proxy.example.com/anthropic   # with or without a trailing /v1
   export ANTHROPIC_API_KEY=<the proxy's key>
   # or OPENAI_BASE_URL=https://llm-proxy.example.com/openai/v1 with OPENAI_API_KEY
   ```

   ```ts
   await open('ios', { model: 'anthropic/claude-sonnet-5-5' });
   ```

2. Or name the proxy in code, when it speaks OpenAI's chat completions:

   ```ts
   await open('ios', { model: { id: 'claude-sonnet-5-5', baseURL: 'https://llm-proxy.example.com/v1', apiKey: process.env.PROXY_KEY } });
   ```

A base address works with or without a trailing `/v1`. For Anthropic, Verify calls `<base>/v1/messages`, or `<base>/messages` when the base already ends in a version such as `/v1`. For OpenAI-compatible addresses, Verify adds `/v1` only to a bare host, so `https://gw.example.com` and `https://gw.example.com/v1` both call `https://gw.example.com/v1/chat/completions`, and a path such as `/openai/v1` is used as given.

Verify doesn't check a key's prefix or shape, so a proxy's own key format works. If the proxy rejects the key, the error names the host Verify called and the variable the key and address came from, never the key itself. If it answers 404, the error names the path Verify added to the base address (such as `/v1/messages`), so you can see whether the base address needs `/v1` or the model id is one the proxy doesn't serve.

## Custom agents

For control beyond a model name, build the agent with `localAgent()` and pass it as `agent`. The `model` forms build exactly this agent, so behavior is the same. Passing both `model` and `agent` throws `INVALID_ARGUMENT`.

```ts
import { localAgent, open, openaiCompatible } from '@revyl/verify';

const agent = localAgent({
  model: openaiCompatible({ baseURL: 'http://localhost:11434/v1', model: 'qwen3-vl:8b' }),
  grounding: 'model', // default 'revyl'
  maxTurns: 10,       // default 20, at most 100
  modelTimeout: 120_000,
});
const session = await open('ios', { agent }); // or session.instruction(text, { agent })
```

- `anthropic({ model, apiKey?, baseURL?, maxTokens?, maxRetries? })` and `openaiCompatible({ model, baseURL?, apiKey?, headers?, provider?, maxTokens?, maxRetries? })` are the two built-in adapters. When `baseURL` is left out, `anthropic()` reads `ANTHROPIC_BASE_URL` and `openaiCompatible()` reads `OPENAI_BASE_URL` and `OPENAI_API_KEY`; with a `baseURL`, `openaiCompatible()` sends only the `apiKey` you pass.
- To use another SDK or runtime, implement `ModelAdapter`: a `name` and `complete(request, signal)`, which gets the system prompt, the text, the screenshot and the tools, and returns the chosen tool call and token usage.
- See [api.md](api.md#custom-agents) for every option.

## What goes where

**Your model sees** the system prompt, the step text, a short log of the actions it took so far and whether they worked, and the current screenshot, downscaled so its longest side is at most 1280 pixels (`maxImageSide`).

**Revyl sees** what it always sees for a session it hosts: the device and its screen. On top of that it receives each device action (taps, long presses, drags, typed text, swipes, key presses, URLs), the element descriptions your model writes, such as "General row" (not with `grounding: 'model'`), and the model's name, such as `anthropic/claude-sonnet-5-5`, for the session report.

**Revyl does not receive** the step text, the prompts, your model's output or reasoning, or your key. Keys go only to the provider's endpoint, are never logged, and are replaced with `[redacted]` in error messages, as are custom header values. A custom endpoint's address is never sent to Revyl.

## Limits

| Limit | Default | Change it with |
| --- | --- | --- |
| Turns per instruction | 20 (at most 100) | `localAgent({ maxTurns })` |
| Verdict attempts per validation | 3 | |
| Whole step | 180 s | the step's `timeout`, or `stepTimeout` in the config |
| One model call, retries included | 60 s | `localAgent({ modelTimeout })` |
| Retries per model call | 2, on rate limits, 5xx and network errors; `Retry-After` is honored up to 10 s | the adapter's `maxRetries` (0 to 5) |
| Output tokens per turn, thinking included | 4096 on Anthropic, OpenAI and Google, 2048 elsewhere; a reply cut off at the cap throws `MODEL_ERROR`, and a tool call in it is never run | the adapter's `maxTokens` |
| Turns in a row without a tool call | 3, then `MODEL_ERROR` | |

Input token counts include cached input, so a proxy or provider that caches prompts doesn't make a step look cheaper than it is. Input tokens grow with the number of turns, not with history: each turn sends one screenshot and a text log. Expect roughly 1,300 input tokens per iOS turn at the default size. `step.model` reports each turn's action, model and action time, and token counts, so you can see the cost of every step.

Device actions are never retried; a failed action goes back to the model to choose its next move. An instruction that runs out of turns fails with `INSTRUCTION_FAILED` like any other.

## Troubleshooting

| Error | What it means | What to do |
| --- | --- | --- |
| `MODEL_KEY_MISSING` | The provider's key variable is not set | Set the variable the message names, or pass `{ id, baseURL, apiKey }` |
| `INVALID_ARGUMENT`: Unknown model | No provider prefix, or one Verify doesn't know | Use `'provider/model'` with a prefix from the table, or the object form |
| `MODEL_ERROR` with HTTP 401 or 403 | The host named in the message rejected the key | Check that the key in the variable the message names belongs to that host; behind a proxy, set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` too |
| `MODEL_ERROR` with HTTP 404, or "not a valid model" | The provider doesn't serve that model name, or the base address is missing or repeating `/v1` | Copy the exact model id from the provider's model list, and check the path the message says Verify added |
| `MODEL_ERROR` with HTTP 429 | Still rate limited after the retries | Wait and rerun, run fewer sessions at once, or raise your provider limit |
| `MODEL_ERROR`: does not accept images | The model is text-only | Pick a vision model |
| `MODEL_ERROR`: does not support tool calls, or answered without calling a tool | The model or server ignores tools | Pick a model that supports tool calls; on Ollama, one tagged "tools" |
| `MODEL_ERROR`: cut off at its output token cap | The model, often while thinking, used all of `maxTokens` before finishing its tool call; Verify never runs a cut-off call | Pass the model through `localAgent()` with a higher `maxTokens`, such as `anthropic({ model, maxTokens: 8192 })` |
| `TIMEOUT` from the model | A call took longer than `modelTimeout` | Raise `modelTimeout`, common with local models |
| `INSTRUCTION_FAILED`: did not finish within 20 turns | The model looped or kept missing | Split the instruction, use a stronger model, or keep `grounding: 'revyl'` |

[errors.md](errors.md) lists every Verify error code.

## In the session report

The session link works as usual and shows the recording. On iOS and Android, your model's device actions appear as steps named "Agent Step: Verify local: <model>", with a screenshot after each action. A long instruction can show as two report steps, and the step's text and your model's verdict are not in the report yet. On Web, the same actions show as manual control. `step.model` and Verify's own log are the full record for now. Revyl is adding report support for steps run on your model.

## Not supported yet

- Mac computers: `model` and `agent` work on Web, iOS and Android sessions only.
- Agent runtimes that run their own loop, such as Claude Code over ACP. Wrap a single-call model in a `ModelAdapter` instead.
