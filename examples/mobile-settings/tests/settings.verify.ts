import { expect, test } from '@revyl/verify';

test('the About screen shows the OS version', async ({ screen, agent, target }) => {
  if (target.platform === 'ios') {
    await screen.getByText('General', { exact: true }).tap();
    await screen.getByText('About', { exact: true }).tap();
  } else {
    await agent.act('Scroll to the bottom of Settings and open "About phone" or "About emulated device"');
  }

  const version = await agent.extract('the operating system version number shown on this screen');
  expect(version).toMatch(/\d+/);
  await agent.assert(`The screen shows details about the device, including version ${version}`);
});

test('a setting can be opened with a plain-language step', async ({ agent }) => {
  await agent.act('Open the display or brightness settings');
  await agent.assert('A brightness setting is visible on screen');
});
