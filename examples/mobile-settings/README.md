# Mobile settings example

Opens the Settings app that ships with iOS and Android on a Revyl cloud device, goes to the About screen, scrolls or navigates until the OS version is visible, validates it, and saves a screenshot. Android can put the version below the fold or behind another screen; opening About alone is not enough. Nothing needs to be built or uploaded.

```bash
export REVYL_API_KEY=...        # or: revyl auth login
npm install
node verify/about.ts ios
node verify/about.ts android
```

The last step is a soft validation: it reports whether dark mode is on without failing the script either way.
