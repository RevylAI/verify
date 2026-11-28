import { open } from '@revyl/verify';

const session = await open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } });
console.log(`Live view: ${session.viewerUrl}`);
try {
  await session.instruction('Open General, then About.');
  await session.validation('The screen shows the iOS version.');
  await session.screenshot({ path: 'about.png' });
} finally {
  await session.close();
}
