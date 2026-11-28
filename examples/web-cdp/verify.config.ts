import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: {
    web: {
      platform: 'web',
      app: {
        // Verify finds or creates the Revyl web app for this URL's origin and prints its id; add appId: '<id>' to pin it.
        url: 'https://www.saucedemo.com',
      },
      viewport: { width: 1280, height: 800 },
    },
  },
});
