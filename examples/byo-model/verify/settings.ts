import { open } from '@revyl/verify';

// 'provider/model' reads the provider's key from its usual environment variable, ANTHROPIC_API_KEY here.
const session = await open('ios', { model: process.env.MODEL ?? 'anthropic/claude-sonnet-5-5' });
try {
  const step = await session.instruction('Open General, then About');
  console.log(`${step.model?.turns.length} turns, ${step.model?.inputTokens} input and ${step.model?.outputTokens} output tokens on ${step.model?.id}`);
  await session.validation('The screen shows the iOS version');

  // Exact actions run without a model.
  await session.tap({ target: 'Back button' });
  await session.swipe('up');
  await session.screenshot({ path: '.verify/settings.png' });
} finally {
  await session.close();
}
