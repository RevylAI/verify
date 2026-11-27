import { open } from '@revyl/verify';

const mac = await open({ platform: 'mac', inference: true });
try {
  console.log("Mac's model:", mac.inference);
  const dock = await mac.validation('The Dock is visible at the bottom of the screen');
  console.log('Dock visible:', dock.passed, `(${dock.engine})`);
  const date = await mac.extract('the date at the right end of the menu bar');
  console.log('Menu bar date:', date.value, `(${date.engine})`);

  const appId = process.env.IOS_APP_ID;
  const buildId = process.env.IOS_BUILD_ID;
  if (appId && buildId) {
    const app = await mac.open({ platform: 'ios', app: { appId, buildId } });
    try {
      const shown = await app.validation("The app's first screen is showing", { soft: true });
      console.log('App first screen:', shown.passed, `(${shown.engine})`);
    } finally {
      await app.close();
    }
  }
} finally {
  await mac.close();
}
