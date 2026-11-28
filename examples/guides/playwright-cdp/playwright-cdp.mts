import { open } from '@revyl/verify';
import { chromium } from 'playwright-core';

const session = await open({ platform: 'web', app: { appId: process.env.WEB_APP_ID ?? '', url: 'https://www.saucedemo.com' } });
console.log(`Live view: ${session.viewerUrl}`);
try {
  const { url } = await session.cdp();
  const browser = await chromium.connectOverCDP(url);
  try {
    const page = browser.contexts()[0]!.pages()[0]!;
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    await page.locator('#add-to-cart-sauce-labs-backpack').click();
    console.log('Playwright: signed in and added the backpack');

    await session.validation('The cart icon shows 1 item and the backpack button now says Remove.');
    await session.screenshot({ path: 'cart.png' });
  } finally {
    await browser.close();
  }
} finally {
  await session.close();
}
