import { open } from '@revyl/verify';

const mac = await open({ platform: 'mac', inference: true, timeoutMs: 20 * 60_000 });
console.log(`Live view: ${mac.viewerUrl}`);
try {
  const app = await mac.open({ platform: 'ios', app: { appId: process.env.IOS_APP_ID ?? '', buildId: process.env.IOS_BUILD_ID ?? '' } });
  try {
    const check = await app.validation('The app has finished launching and shows its main screen');
    console.log(`validation: ${check.passed} in ${check.durationMs} ms, engine ${check.engine}`);
    const name = await app.extract('the app name and version shown on screen');
    console.log(`extract: "${name.value}" in ${name.durationMs} ms, engine ${name.engine}`);
  } finally {
    await app.close();
  }
} finally {
  await mac.close();
}
