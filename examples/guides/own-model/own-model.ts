import { open } from '@revyl/verify';

const session = await open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } }, { model: 'anthropic/claude-sonnet-5-5' });
console.log(`Live view: ${session.viewerUrl}`);
try {
  await session.instruction('Open General, then About.');
  await session.validation('The screen shows the iOS version.');
  for (const step of session.steps) {
    console.log(`${step.type} "${step.text}": ${step.passed ? 'passed' : 'failed'} on ${step.model?.id} in ${step.model?.turns.length} turns`);
  }
} finally {
  await session.close();
}
