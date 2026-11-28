import { open } from '@revyl/verify';

// Settings by default, which every simulator has; set IOS_APP_ID and IOS_BUILD_ID to open your own app's build instead.
const appId = process.env.IOS_APP_ID;
const buildId = process.env.IOS_BUILD_ID;
const app = appId && buildId ? { appId, buildId } : { bundleId: 'com.apple.Preferences' };

const mac = await open({ platform: 'mac', inference: true, timeoutMs: 20 * 60_000 });
console.log(`Live view: ${mac.viewerUrl}`);
try {
  const session = await mac.open({ platform: 'ios', app });
  try {
    const check = await session.validation('The app has finished launching and shows its main screen');
    console.log(`validation: ${check.passed} in ${check.durationMs} ms, engine ${check.engine}`);
    const name = await session.extract('the title shown at the top of the screen');
    console.log(`extract: "${name.value}" in ${name.durationMs} ms, engine ${name.engine}`);
  } finally {
    await session.close();
  }
} finally {
  await mac.close();
}
