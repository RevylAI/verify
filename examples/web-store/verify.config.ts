import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: [
    {
      platform: 'web',
      app: {
        // Create a web app in Revyl and put its id in REVYL_WEB_APP_ID.
        appId: process.env.REVYL_WEB_APP_ID ?? '',
        url: 'https://www.saucedemo.com',
      },
      viewport: { width: 1280, height: 800 },
    },
  ],
});
