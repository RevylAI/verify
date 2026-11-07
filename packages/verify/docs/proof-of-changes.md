# Proof of Changes from your CI

Revyl's [Proof of Changes](https://github.com/RevylAI/revyl-cli/blob/main/docs/proof-of-changes.md) runs an agent on a real device against each pull request and posts the result on the pull request. When your own CI already builds the app, `verify upload` (or `uploadBuild()` from TypeScript, Python, or Go) sends each pull request's build to Revyl with the pull request identity Revyl matches it by.

The policy that turns Proof of Changes on for CI-uploaded builds, its harnesses, and what Revyl does with the build are documented in [Configure Proof of Changes](https://github.com/RevylAI/revyl-cli/blob/main/docs/proof-of-changes.md). This page covers only Verify's part.

To prove a pull request without a Revyl config, use [`verify proof`](#prove-a-pull-request-without-a-revyl-config-verify-proof).

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
| `reviewCorrelation` | Whether Revyl attached the build to a pull request review. `associated` is true only for status `associated`. Other statuses are `not_owned`, `ambiguous_review`, `stale_review`, `closed_review`, and `unmatched`; `not_owned` and `unmatched` can still attach once the review picks its targets for that commit. `no_identity` means no complete pull request identity was sent, and `unknown` means Revyl didn't report a match. `matchedTargetCount` comes with Revyl's statuses. |
| `warnings` | Revyl's artifact validation warnings. |

### Errors

| Code | What happened |
| --- | --- |
| `AUTH_MISSING` | No `REVYL_API_KEY` or Revyl CLI login. |
| `AUTH_REJECTED` | HTTP 401: the key isn't valid for uploads. Use a member's API key, or a revyl-macos job's `ci_runner` key after the job's activation hook has run; an organization API key with no runtime authenticator is rejected as "Invalid API key". HTTP 403: the key's user needs the Member role or higher (a Viewer gets 403). |
| `NOT_FOUND` | The app id isn't an app in the key's organization. |
| `VERSION_EXISTS` | The app already has a build with that version. Pass a unique `--version`. |
| `ARTIFACT_REJECTED` | Revyl couldn't validate the artifact, for example an `.app` built for a device instead of the simulator. |
| `UPLOAD_FAILED` | Revyl's storage rejected the artifact or couldn't be reached, after retries. |
| `TIMEOUT` | A phase ran past its bound (30 s to open the upload, 10 min for the artifact, 90 s per attempt to register the build), or the caller aborted. Registering the build is retried up to 3 times on 5xx, 429, and network errors. |
| `INVALID_ARGUMENT` | A bad artifact path or type, an incomplete `--repo`/`--commit` pair, or a head commit that isn't a full SHA. |

## Prove a pull request without a Revyl config: `verify proof`

`verify proof` (or `proof()` from TypeScript, Python, or Go) proves a pull request from your own CI with no `.revyl/config.yaml` in the repository. It uploads each mobile build or registers each Web URL, starts one Proof of Changes run per target through Revyl's Proof API, and waits for every verdict. Revyl reports on the pull request in one comment with a section per app.

**Revyl adds no check run for these proofs, so your CI job is the gate.** `verify proof` exits `0` only when the overall verdict is `passed`, and `1` for `failed`, `inconclusive`, a run that ended without a verdict, a timeout, or a refusal. From code, fail the job yourself unless `verdict` is `passed`. To block merges on it, make the job a required status check.

The first owner of a pull request head keeps it. A head the repository's own Revyl config already proves is refused with `CONFIG_MANAGED_REVIEW`, and when `verify proof` proves a head first, the config skips that head and resumes on the next one.

### Requirements

- The Revyl GitHub App is connected to your organization and can read the repository: run `revyl github connect`, or grant the repository to the App.
- The job runs on a `pull_request` event on GitHub Actions. Verify reads the repository, pull request number, and head commit from it; anywhere else `proof()` fails with `PR_CONTEXT_MISSING`.
- The pull request is open and its head branch is in the same repository. Pull requests from forks are refused, and GitHub doesn't give them secrets anyway.
- `REVYL_API_KEY` holds a Revyl member's API key (Member role or higher) or the key of a Revyl CI runner job. Referencing a secret launch variable needs a member's key.

```yaml
- name: Prove the pull request on Revyl
  run: |
    npx --yes @revyl/verify@<version> proof "app/build/outputs/apk/debug/app-debug.apk" --app-id <app UUID> \
      --guidance "Focus on the new checkout screen"
  env:
    REVYL_API_KEY: ${{ secrets.REVYL_API_KEY }}
```

### The command

```text
npx @revyl/verify proof <artifact> | --url <https-url> --app-id <id> [options]
npx @revyl/verify proof --target <app-id>=<artifact-or-https-url>... [options]
options: [--guidance <text>] [--env NAME[=value]]... [--env-secret NAME]... [--auth-deep-link <template>]... [--timeout <minutes>] [--no-wait] [--json]
```

- Prove up to three targets, one per platform: an iOS build, an Android build, and a Web URL. Give one with `<artifact>` or `--url` and `--app-id`, or several with repeated `--target`; a value starting with `https://` is a Web URL. Builds are the artifacts `verify upload` takes.
- `--app-id` falls back to `REVYL_APP_ID`.
- `--guidance` tells the agent what to focus on.
- `--env` and `--env-secret` set launch variables on every mobile target (see [Launch environment](#launch-environment)). `--env NAME` without a value reads `NAME` from the job's environment.
- `--auth-deep-link` signs the app in after launch (see [Sign in with a deep link](#sign-in-with-a-deep-link)). With one target it takes the template; with `--target` it takes `<app-id>=<template>`, once per mobile target.
- `--timeout` bounds the wait, 30 minutes by default. The runs keep going on Revyl after it.
- `--no-wait` returns once the runs start and exits `0`, so it doesn't gate anything.
- `--json` prints the result object below.
- Ctrl+C or SIGTERM while waiting cancels every run that hasn't settled, then exits `130`.

| Exit code | Meaning |
| --- | --- |
| `0` | The overall verdict is `passed`, or `--no-wait` started the runs. |
| `1` | The overall verdict is `failed` or `inconclusive`, a run ended without a verdict, the wait timed out, or Revyl refused the proof. |
| `2` | A usage problem, missing or rejected credentials, or no pull request context. |
| `130` | Interrupted; the runs that hadn't settled were cancelled. |

The same call from code:

```ts
import { proof } from '@revyl/verify';

const run = await proof({
  targets: [
    {
      build: 'app/build/outputs/apk/debug/app-debug.apk',
      appId: androidAppId,
      environment: { API_URL: 'https://staging.example.com', REVYL_AUTH_BYPASS_TOKEN: { secretRef: 'REVYL_AUTH_BYPASS_TOKEN' } },
      authBypass: { deepLink: 'myapp://revyl-auth?token=${REVYL_AUTH_BYPASS_TOKEN}' },
    },
    { url: previewUrl, appId: webAppId },
  ],
  guidance: 'Focus on the new checkout screen',
});
if (run.verdict !== 'passed') process.exitCode = 1;
```

```python
from revyl_verify import ProofTarget, proof

run = proof(
    targets=[
        ProofTarget(
            app_id=android_app_id,
            build="app/build/outputs/apk/debug/app-debug.apk",
            environment={"API_URL": "https://staging.example.com", "REVYL_AUTH_BYPASS_TOKEN": {"secret_ref": "REVYL_AUTH_BYPASS_TOKEN"}},
            auth_bypass={"deep_link": "myapp://revyl-auth?token=${REVYL_AUTH_BYPASS_TOKEN}"},
        ),
        ProofTarget(app_id=web_app_id, url=preview_url),
    ],
    guidance="Focus on the new checkout screen",
)
if run.verdict != "passed":
    raise SystemExit(1)
```

```go
run, err := verify.Proof(ctx, verify.ProofOptions{
	Targets: []verify.ProofTarget{
		{
			AppID: androidAppID,
			Build: "app/build/outputs/apk/debug/app-debug.apk",
			Environment: map[string]verify.EnvValue{
				"API_URL":                 verify.EnvPlain("https://staging.example.com"),
				"REVYL_AUTH_BYPASS_TOKEN": verify.EnvSecretRef("REVYL_AUTH_BYPASS_TOKEN"),
			},
			AuthBypass: &verify.AuthBypass{DeepLink: "myapp://revyl-auth?token=${REVYL_AUTH_BYPASS_TOKEN}"},
		},
		{AppID: webAppID, URL: previewURL},
	},
	Guidance: "Focus on the new checkout screen",
})
if err != nil || run.Verdict != "passed" {
	os.Exit(1)
}
```

A single target can also be given inline, as `proof({ build, appId })` or `proof({ url, appId })`.

### The verdict

Each run has its own raw `verdict` (`passed`, `failed`, or `inconclusive`) and its `label`, which is the label the pull request comment shows, such as `Ready`, `Ready with issues`, or `Partial coverage`. Revyl builds the label from the run's write-up and findings, so a passed run can read `Partial coverage`; Verify reports it as Revyl sends it, and the CLI prints it next to the verdict. The overall `verdict` is `failed` if any run failed, otherwise `inconclusive` if any run is inconclusive (a verdict Verify doesn't recognize counts as inconclusive), otherwise `passed`. It is set only once every run has a verdict. The overall `label` is that of the first run that decided the verdict, and `reportUrl` is the pull request comment with the report.

| Field | Meaning |
| --- | --- |
| `runs` | One per target, in order: `id`, `appId`, `platform`, Revyl's `status`, `verdict`, `label`, `reportUrl`, `reviewUrl`, `createdAt`, `settledAt`, and the `build` that was uploaded or registered. |
| `verdict`, `label`, `reportUrl` | The overall outcome, as above. |
| `pullRequest` | The repository, pull request number, and head commit that were proved. |

A run that is cancelled, or superseded by a newer build or commit, ends without a verdict, and the wait fails with `PROOF_RUN_ENDED` once the other runs settle.

### Reruns and conflicts

Each pull request head has one proof per app:

- Starting the same builds with the same settings at the same head returns the existing runs in whatever state they are in, cancelled included. A Web URL that Revyl registers as the same build therefore gets its earlier run back.
- A new build for a target starts a new run for it and supersedes its earlier run for that head. Every `verify proof` uploads its mobile builds afresh, so rerunning the job proves them again.
- Different apps, `--guidance`, launch environment, or deep link for a head that already has proofs are refused with `PROOF_RUN_CONFLICT`, which lists the existing runs. Push a new commit to prove with other settings.
- A new commit supersedes the runs of the previous head.

### Launch environment

Launch variables apply to iOS and Android targets only; a Web target takes none. They apply to the proof's own device sessions, not to the pull request's open-preview link.

- A plain value (`--env NAME=value`, a string in code) is shown to the proof agent and can appear in the report. Never pass a secret this way.
- A secret reference (`--env-secret NAME`, `{ secretRef: 'NAME' }` in TypeScript, `{"secret_ref": "NAME"}` in Python, `verify.EnvSecretRef("NAME")` in Go) uses the organization launch variable `NAME`. The reference must equal the variable's own name. Its value stays in Revyl and only the name reaches the agent. Only a member's API key can reference one; a CI runner job key is refused with `SECRET_REF_NOT_ALLOWED`.

Verify never puts a launch value in an error, a log, or its result.

### Sign in with a deep link

A mobile target can take a deep link that Revyl opens right after the app launches, the same as `session.auth_bypass.deep_link` in a Revyl config. Use it to sign the app in so the agent starts past the login screen. The link opens once on each device the agent starts.

```bash
npx @revyl/verify proof app-debug.apk --app-id <app UUID> \
  --env REVYL_AUTH_BYPASS_ENABLED=true \
  --env-secret REVYL_AUTH_BYPASS_TOKEN \
  --auth-deep-link 'myapp://revyl-auth?token=${REVYL_AUTH_BYPASS_TOKEN}&role=buyer'
```

- Each `${NAME}` placeholder resolves on Revyl's side from that target's launch environment only, so name every placeholder with `--env` or `--env-secret` (`environment` in code). Verify refuses a placeholder the environment doesn't set before it sends anything.
- If your app only honors the link when a launch variable turns the bypass on, such as `REVYL_AUTH_BYPASS_ENABLED`, put that variable in the target's environment too. Without it the app ignores the link and the run proves a signed-out app.
- A link with placeholders must use the app's own URL scheme, such as `myapp://`, not `http` or `https`.
- Put the template in single quotes. In double quotes the shell replaces `${NAME}` with its value, and the token would then travel as part of the link.
- Use a secret reference for a token. Revyl fills placeholders in as it opens the link, so the secret's value never reaches the agent, the report, or the pull request comment.
- Web targets take no deep link.

### Web URLs

A Web target is proved at its URL, so the URL must be public HTTPS on port 443 and load signed in or need no sign-in: URL builds take no headers or basic auth, and any HTTP status of 400 or above fails the page. Revyl requests the URL once when it starts the run and refuses an unreachable one with `PREVIEW_UNREACHABLE`.

Keep the URL up from the call until its run settles, which can take minutes; with `--no-wait` keeping it up is yours. After the run settles, the comment's **Re-run** and **Open preview** links still use the URL and fail once it is gone, while the report and the comment stay readable.

### Proof errors

| Code | What happened |
| --- | --- |
| `PR_CONTEXT_MISSING` | The job isn't a `pull_request` event on GitHub Actions. |
| `AUTH_REJECTED` | The key isn't a member's API key or a CI runner job key, or its user is a Viewer. |
| `GITHUB_APP_NOT_CONNECTED` | The Revyl GitHub App isn't connected, or can't read the repository or its pull requests. |
| `CONFIG_MANAGED_REVIEW` | The repository's own Revyl config already proves this head. |
| `PROOF_RUN_CONFLICT` | Proofs with other apps, settings, or environment already cover this head. The error lists their run ids (`proofRunIds`). |
| `PR_CLOSED` | The pull request isn't open. |
| `HEAD_NOT_CURRENT` | The pull request's head or base moved on since the job started. |
| `UNTRUSTED_PR_HEAD` | The pull request comes from a fork. |
| `BUILD_REJECTED` | Revyl can't prove the build: an unsupported build or platform, or a build uploaded for another repository, pull request, or commit. |
| `PREVIEW_UNREACHABLE` | Revyl couldn't reach the Web URL when it started the run. |
| `SECRET_REF_NOT_ALLOWED` | A CI runner job key referenced a secret launch variable. Use a member's key. |
| `PROOF_RUN_LIMIT` | Too many Proof API runs are queued or running for the organization. Verify doesn't retry it; try again once some settle. |
| `PROVIDER_UNAVAILABLE` | Revyl couldn't reach GitHub, after Verify retried. |
| `NOT_FOUND` | The pull request, app, build, or run doesn't exist for the key's organization. |
| `INVALID_ARGUMENT` | Checked before any request: no targets or more than three, two targets for one app or platform, both or neither of a build and a URL, a URL that isn't plain HTTPS, environment on a Web target, an invalid variable name, a secret reference that doesn't name its own variable, a deep link on a Web target, a deep-link placeholder the target's environment doesn't set, or an `http` or `https` deep link with placeholders. Revyl also refuses an unknown secret launch variable, an alias, a secret's value sent as a plain value, a deep link on a Web target, or a placeholder the environment doesn't name. |
| `PROOF_RUN_ENDED` | A run was cancelled or superseded before it had a verdict. |
| `TIMEOUT` | The wait ran past `--timeout`; the runs keep going on Revyl. |

Starting the runs is retried on 5xx and network errors, which is safe because a repeat returns the same runs. Upload errors are in [Errors](#errors) above.
