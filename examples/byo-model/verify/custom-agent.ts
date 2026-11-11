import { localAgent, open, openaiCompatible } from '@revyl/verify';

// Your own endpoint with the agent tuned: OpenAI-compatible, a turn cap, and screen coordinates from the model.
const agent = localAgent({
  model: openaiCompatible({ baseURL: process.env.MODEL_BASE_URL ?? 'http://localhost:11434/v1', model: process.env.MODEL ?? 'qwen3-vl:8b' }),
  grounding: 'model',
  maxTurns: 10,
});

const session = await open('ios', { agent });
try {
  await session.instruction('Open General, then About');
  await session.validation('The screen shows the iOS version');
} finally {
  await session.close();
}
