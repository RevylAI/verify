import { anthropic, localAgent, open, openaiCompatible, type Grounding } from '@revyl/verify';

// Claude when ANTHROPIC_API_KEY is set; otherwise any OpenAI-compatible server, Ollama on this machine by default.
const model = process.env.ANTHROPIC_API_KEY
  ? anthropic({ model: process.env.MODEL ?? 'claude-sonnet-4-5' })
  : openaiCompatible({
      baseURL: process.env.MODEL_BASE_URL ?? 'http://localhost:11434/v1',
      model: process.env.MODEL ?? 'qwen2.5vl:7b',
      apiKey: process.env.MODEL_API_KEY,
    });

// 'model' sends Revyl only device actions. 'revyl' lets your model name elements and Revyl find them on screen.
const agent = localAgent({ model, grounding: (process.env.GROUNDING ?? 'model') as Grounding });

const session = await open('ios', { agent });
try {
  const step = await session.instruction('Open General, then About');
  console.log(`${step.agent?.turns.length} turns, ${step.agent?.inputTokens} input and ${step.agent?.outputTokens} output tokens on ${step.agent?.model}`);
  await session.validation('The screen shows the iOS version');

  // Exact actions run without a model.
  await session.tap({ target: 'Back button' });
  await session.swipe('up');
  await session.screenshot({ path: '.verify/settings.png' });
} finally {
  await session.close();
}
