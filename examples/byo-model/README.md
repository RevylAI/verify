# Bring your own model example

Runs Verify's instruction and validation steps on a model you choose instead of Revyl's agent. The device is still a Revyl cloud iPhone running the built-in Settings app; the agent loop, the prompts and your model key stay on your machine.

```bash
export REVYL_API_KEY=...                  # or: revyl auth login
npm install

# A built-in provider: the key comes from its usual environment variable
ANTHROPIC_API_KEY=... node verify/settings.ts
OPENAI_API_KEY=... MODEL=openai/gpt-5.5 node verify/settings.ts
CEREBRAS_API_KEY=... MODEL=cerebras/qwen-3.8-27b node verify/settings.ts

# A custom agent on your own endpoint, here Ollama on this machine
ollama pull qwen3-vl:8b && node verify/custom-agent.ts
```

By default your model names the elements it wants ("General row") and Revyl's grounding model finds them on screen. `verify/custom-agent.ts` shows the advanced form, where `localAgent()` sets the adapter, the turn cap and `grounding: 'model'`, so the model gives screen coordinates and Revyl receives only taps, typing and swipes.

[Use your own model](../../packages/verify/docs/own-model.md) covers every provider, which ones are verified live, the limits and troubleshooting.
