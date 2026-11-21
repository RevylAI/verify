import { open } from '@revyl/verify';
import { chromium } from 'playwright-core';

const session = await open('web');
try {
  const { url } = await session.cdp();                    // works for one connection, within 60 seconds
  const browser = await chromium.connectOverCDP(url);
  try {
    const page = browser.contexts()[0]!.pages()[0]!;       // the session's own tab; browser.newContext() is refused
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto('https://www.saucedemo.com');
    console.log(`title: ${await page.title()}, ${requests.length} requests, the first ${requests[0]}`);

    // Sauce Demo publishes these practice credentials on its sign-in page.
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    console.log(`heading: ${await page.locator('.title').textContent()}`);

    const message = page.waitForEvent('console');
    await page.evaluate(() => console.log('hello from Playwright'));
    console.log(`console: ${(await message).text()}`);

    await session.validation('A list of products is shown');   // Verify steps keep working while Playwright is attached
  } finally {
    await browser.close();                                    // disconnects Playwright; the session keeps running
  }
} finally {
  await session.close();
}
