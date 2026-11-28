import { open, type TargetConfig } from '@revyl/verify';

const checks: Record<string, { target: TargetConfig; instruction?: string; validation: string }> = {
  web: {
    target: { platform: 'web', app: { appId: process.env.WEB_APP_ID ?? '', url: 'https://www.saucedemo.com' } },
    validation: 'The Swag Labs login form is shown.',
  },
  ios: {
    target: { platform: 'ios', app: { bundleId: 'com.apple.Preferences' } },
    instruction: 'Open General, then About.',
    validation: 'The screen shows the iOS version.',
  },
  android: {
    target: { platform: 'android', app: { bundleId: 'com.android.settings' } },
    instruction: 'Open About phone, then scroll or navigate until the Android version is visible.',
    validation: 'The screen shows the Android version.',
  },
};

const names = Object.keys(checks);
const results = await Promise.allSettled(
  names.map(async (name) => {
    const { target, instruction, validation } = checks[name];
    const session = await open(target);
    console.log(`${name}: ${session.viewerUrl}`);
    try {
      if (instruction) await session.instruction(instruction);
      await session.validation(validation);
    } finally {
      await session.close();
    }
  }),
);

results.forEach((result, i) => console.log(`${names[i]} ${result.status === 'fulfilled' ? 'passed' : `failed: ${result.reason}`}`));
if (results.some((result) => result.status === 'rejected')) process.exitCode = 1;
