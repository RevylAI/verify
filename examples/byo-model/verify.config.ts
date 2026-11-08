import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: {
    ios: { platform: 'ios', app: { bundleId: 'com.apple.Preferences' } },
  },
});
