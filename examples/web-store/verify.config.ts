import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: {
    web: {
      platform: 'web',
      app: {
        // A web app you created in Revyl.
        appId: process.env.REVYL_WEB_APP_ID ?? '',
        url: 'https://www.saucedemo.com',
      },
      viewport: { width: 1280, height: 800 },
    },
  },
});
