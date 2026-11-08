# Bring your own model example

Runs Verify's instruction and validation steps on a model you choose instead of Revyl's agent. The device is still a Revyl cloud iPhone running the built-in Settings app; the agent loop, the prompts and your model key stay on your machine.

```bash
export REVYL_API_KEY=...                  # or: revyl auth login
npm install

# Claude
ANTHROPIC_API_KEY=... node verify/settings.ts

# Any OpenAI-compatible server, here Cerebras
MODEL_BASE_URL=https://api.cerebras.ai/v1 MODEL=qwen-3.8-27b MODEL_API_KEY=$CEREBRAS_API_KEY node verify/settings.ts

# Ollama on this machine (the default), with a vision model pulled
ollama pull qwen2.5vl:7b && node verify/settings.ts
```

Set `GROUNDING=revyl` to let the model name elements ("General row") and have Revyl's grounding model find them, which helps models that are weak at pixel coordinates. With the default `GROUNDING=model`, Revyl receives only taps, typing and swipes.
