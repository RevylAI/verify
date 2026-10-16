# Mobile settings example

Runs the same tests on an iOS simulator and an Android emulator in Revyl, against the Settings app each OS ships with. Nothing needs to be built or uploaded.

```bash
export REVYL_API_KEY=...       # or: revyl auth login
npm install
npx verify run                 # both platforms
npx verify run --target ios    # one platform
```

The first test uses exact native locators on iOS and an agent step on Android to reach the About screen, then reads the version with `agent.extract` and carries it into a later `agent.assert`. The second test is all plain-language agent steps.
