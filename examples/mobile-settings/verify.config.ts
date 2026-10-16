import { defineConfig } from '@revyl/verify';

// Both targets launch the Settings app that ships with the OS, so there is no build to upload.
export default defineConfig({
  targets: [
    { platform: 'ios', app: { bundleId: 'com.apple.Preferences' } },
    { platform: 'android', app: { bundleId: 'com.android.settings' } },
  ],
});
