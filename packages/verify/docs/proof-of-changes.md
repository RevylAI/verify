# Proof of Changes from your CI

Revyl's [Proof of Changes](https://github.com/RevylAI/revyl-cli/blob/main/docs/proof-of-changes.md) runs an agent on a real device against each pull request and posts the result on the pull request. When your own CI already builds the app, `verify upload` (or `uploadBuild()` from TypeScript, Python, or Go) sends each pull request's build to Revyl with the pull request identity Revyl matches it by.

The policy that turns Proof of Changes on for CI-uploaded builds, its harnesses, and what Revyl does with the build are documented in [Configure Proof of Changes](https://github.com/RevylAI/revyl-cli/blob/main/docs/proof-of-changes.md). This page covers only Verify's part.

## Before you start

- The Revyl GitHub App must be installed on the repository: run `revyl github connect`, or add the repository to the app's repository access on GitHub.
- CI needs a `REVYL_API_KEY` secret holding the API key of a Revyl member (Member role or higher). An organization API key that isn't tied to a member can be rejected as an invalid API key.
- Proof of Changes reads its policy from your **default branch**. Commit it there **before** opening pull requests: a pull request opened before Revyl has the policy doesn't pick up uploads until its next push.

In a GitHub Actions workflow that runs on `pull_request`, upload after your build step:

```yaml
- name: Upload the build to Revyl
  run: |
    npx --yes @revyl/verify@<version> upload "app/build/outputs/apk/debug/app-debug.apk" --app-id <app UUID> --platform android
  env:
    REVYL_API_KEY: ${{ secrets.REVYL_API_KEY }}
```

GitHub doesn't give secrets to workflows triggered by pull requests from forks, so uploads from forks fail authentication.

## Upload a build: `verify upload`

```text
npx @revyl/verify upload <artifact> --app-id <id> [--platform ios|android] [--version <label>]
                         [--repo <owner/name> --commit <sha> [--pr <number>]] [--json]
```

- `<artifact>` is a debug `.apk` (Android), or a simulator `.app` bundle or a `.zip` holding one (iOS). Verify zips an `.app` bundle itself. `.aab`, `.apks`, and `.ipa` aren't supported.
- `--app-id` falls back to `REVYL_APP_ID`.
- `--version` must be unique within the app. It defaults to the first 12 characters of the head commit plus a UTC timestamp.
- On GitHub Actions the pull request identity is detected: the repository, the pull request number, and the PR **head** commit (never the merge commit GitHub checks out).
- On another runner, pass `--repo` (the base repository receiving the pull request) and `--commit` (the full PR head SHA). Add `--pr` to pick the pull request explicitly; without it Revyl matches by head commit.
- `--json` prints the result object below.
- Header values that aren't plain ASCII, such as a non-ASCII branch name, are sent only in the build metadata.

The same call from code:

```ts
import { uploadBuild } from '@revyl/verify';

const result = await uploadBuild({ file: 'app/build/outputs/apk/debug/app-debug.apk', appId: process.env.REVYL_APP_ID! });
console.log(result.buildId, result.identity);
```

```python
from revyl_verify import upload_build

result = upload_build("app/build/outputs/apk/debug/app-debug.apk", app_id)
```

```go
result, err := verify.UploadBuild(ctx, verify.UploadOptions{File: "app/build/outputs/apk/debug/app-debug.apk", AppID: appID})
```

### The result

| Field | Meaning |
| --- | --- |
| `buildId`, `version`, `appId`, `platform`, `packageId` | The build Revyl created. |
| `identity` | The pull request identity that was sent: `ciSystem` (`github-actions` or `external`), `repository`, `commit`, and `pr` when known. Absent when none was detected or given, in which case no review can match the build. |
| `reviewCorrelation.status` | Always `unknown` for now: Revyl doesn't yet report whether the upload attached to a review. Check the pull request's Revyl status. |
| `warnings` | Revyl's artifact validation warnings. |

### Errors

| Code | What happened |
| --- | --- |
| `AUTH_MISSING` | No `REVYL_API_KEY` or Revyl CLI login. |
| `AUTH_REJECTED` | HTTP 401: the key isn't valid for uploads (use a member's API key). HTTP 403: the key's user needs the Member role or higher. |
| `NOT_FOUND` | The app id isn't an app in the key's organization. |
| `VERSION_EXISTS` | The app already has a build with that version. Pass a unique `--version`. |
| `ARTIFACT_REJECTED` | Revyl couldn't validate the artifact, for example an `.app` built for a device instead of the simulator. |
| `UPLOAD_FAILED` | Revyl's storage rejected the artifact or couldn't be reached, after retries. |
| `TIMEOUT` | A phase ran past its bound: 30 s to open the upload, 10 min for the artifact, 90 s to register the build. |
| `INVALID_ARGUMENT` | A bad artifact path or type, or an incomplete `--repo`/`--commit` pair. |
