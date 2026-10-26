import { open } from '@revyl/verify';

const session = await open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } });
try {
  await session.instruction('Open General, then About.');
  await session.validation('The screen shows the iOS version.');
} finally {
  await session.close();
}
