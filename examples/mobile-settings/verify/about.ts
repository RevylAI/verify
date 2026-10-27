import { open } from '@revyl/verify';

const target = process.argv[2] ?? 'ios';
const session = await open(target);
try {
  await session.instruction('Open the screen that shows information about this device, such as About or About phone, then scroll or navigate until the operating system version is visible');
  await session.validation('The screen shows the version of the operating system');
  await session.screenshot({ path: `.verify/about-${target}.png` });

  const darkMode = await session.validation('Dark mode is turned on', { soft: true });
  console.log(`Dark mode is ${darkMode.passed ? 'on' : 'off'} on ${target}.`);
} finally {
  await session.close();
}
