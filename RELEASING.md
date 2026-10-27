# Releasing Verify

Publishing, pushing tags, and configuring npm or GitHub are human-maintainer actions. Preparing this repository does not authorize any of them.

## Current release path

`@revyl/verify@0.1.0` was published manually from Anam's Mac, without provenance. The package already exists; no scope-claim or first-publication bootstrap is needed. The default path for 0.2.0 is another reviewed, interactive publication from that Mac. As of this release preparation, GitHub has no configured `NPM_TOKEN` or trusted-publishing environment for this repository. The connected GitHub App cannot administer repository settings, so Anam or another repository administrator must configure the optional CI path below.

The TypeScript package version is 0.2.0. The Go module has an independent version and uses `go/v*` tags. Neither merging code nor updating this guide publishes either SDK.

The root README is the maintained landing page. `prepack` generates the npm README with version-pinned repository and badge links; do not edit `packages/verify/README.md` directly. After the public Verify guide is deployed and `https://docs.revyl.com/verify` resolves successfully, replace the Documentation section's repository-documentation link with that page and regenerate the package README. After the agent-platform example merges into the release tree, add its example link too; do not link an absent directory.

## Prepare the exact revision

Use a clean checkout of the approved `main` revision, Node 24 and npm 11. Do not tag an unapproved branch. Review [the end-to-end evidence](packages/verify/docs/end-to-end.md), including failures and unverified platforms; fake-server tests are not live proof. Mac and Linux remain staging-only early access for enabled organizations, not yet available in production.

From the repository root:

```bash
git switch main
git pull --ff-only origin main
git status --short
npm ci
npm run build
npm run typecheck
npm test
npm run check:package
npm pack --dry-run --workspace ./packages/verify
mkdir -p release-artifacts
npm pack --workspace ./packages/verify --pack-destination ./release-artifacts
npm publish ./release-artifacts/revyl-verify-0.2.0.tgz --dry-run --access public
```

Stop if the checkout is dirty, the manifest/example versions or generated lockfile disagree, or any check fails. Review every packed file, both CLI bins (`verify` and `revyl-verify`), and the README links. The packaged README and CLI documentation links target `v0.2.0`, not mutable `main`; they will not resolve until the approved version tag exists. Check those paths against the reviewed tree before publication and resolve them again after tagging. Publish the reviewed archive, not a rebuilt directory. Keep old archives out of the selection: the exact filename above avoids a wildcard publishing the wrong version. Pack/dry-run checks do not prove npm authorization or provenance.

## Default: publish 0.2.0 from Anam's Mac

1. In Anam's interactive terminal, run `npm login --registry=https://registry.npmjs.org` if needed, complete the browser/2FA flow, then run `npm whoami`. Use an account with publish permission for `@revyl/verify`. Do not paste credentials, one-time codes, or tokens into commands, source, logs, or chat.
2. Check the exact version with `npm view @revyl/verify@0.2.0 version --registry=https://registry.npmjs.org`. If it returns 0.2.0, stop: it is already published. Only an explicit npm E404 means the version is absent; network, authorization, or registry errors are blockers, not permission to publish.
3. After explicit release approval, publish the exact archive prepared above:

   ```bash
   npm publish ./release-artifacts/revyl-verify-0.2.0.tgz --access public --registry=https://registry.npmjs.org
   ```

   Complete npm's interactive approval/2FA prompt. This local route does not produce GitHub Actions provenance; do not add `--provenance` or claim an attestation exists.
4. Verify `npm view @revyl/verify@0.2.0 version dist.integrity --json`, `npm view @revyl/verify dist-tags --json`, and a clean consumer installation of that exact version. Compare the published file list and package integrity with the reviewed archive. A successful pack or dry run is not a successful publication.
5. If separately approved, record the exact source revision with an immutable annotated tag:

   ```bash
   git tag -a v0.2.0 -m 'Verify 0.2.0'
   git push origin v0.2.0
   ```

   The tag triggers Release validation. If npm already has 0.2.0, the workflow reports that fact and skips the publication dry-run and publish job while retaining the build, tests and package checks, so this default path does not require CI publishing credentials. Do not move or delete an existing public tag to retry a release. If publication may have succeeded despite an error, inspect npm before retrying; published versions cannot be reused.

## Optional: configure GitHub Actions trusted publishing

This is an alternative to publishing from the Mac, not a prerequisite for it. Anam or another repository administrator must perform these clicks; the GitHub App cannot do them. CI publication is disabled unless the repository variable `VERIFY_CI_PUBLISH_ENABLED` is exactly `true`. Without it, an unpublished-version tag fails validation before the environment job can run. Naming an environment alone is not protection: GitHub can otherwise create a missing one unprotected. Set this opt-in only after reviewing the environment, tag rules and npm authorization below; it is an administrator attestation, not an automatic audit of those settings.

1. In GitHub **RevylAI/verify → Settings → Environments → New environment**, enter `npm`, then **Configure environment**. Under deployment protection rules, enable **Required reviewers**, choose the release maintainer/team, and **Save protection rules**. Use **Prevent self-review** only if another eligible maintainer is available. Under **Deployment branches and tags**, choose **Selected branches and tags → Add deployment branch or tag rule → Tag**, enter `v*`, and **Add rule**. Do not add Revyl runtime credentials or a publish token.
2. In npm **Packages → @revyl/verify → Settings → Trusted Publisher → GitHub Actions**, configure organization/user `RevylAI`, repository `verify`, workflow filename `release.yml` (not its directory path), and environment `npm`. Explicitly allow direct **npm publish**, not just staged publishing, then save. New trusted publishers must complete their first successful publication within two days or be recreated.
3. With trusted publishing, in npm **@revyl/verify → Settings → Publishing access**, select **Require two-factor authentication and disallow tokens**, then **Update Package Settings** when the team is ready to use this policy. No `NPM_TOKEN` is required for trusted publishing. Alternatively, if the team's npm policy explicitly permits token publishing, create a short-lived granular token limited to publishing this package (including direct publish permission and bypass-2FA only where that policy allows it), then in GitHub **Settings → Environments → npm → Environment secrets → Add environment secret**, enter `NPM_TOKEN`, paste its value directly into GitHub, and save. Never put it in a command, file, chat, repository variable or repository-wide secret. A stage-only token cannot run this direct-publish workflow. Do not weaken 2FA or use a long-lived token as a workaround.
4. In GitHub **Settings → Rules → Rulesets → New ruleset → New tag ruleset**, protect `v*` against unauthorized creation, updates, and deletion, leaving only the release maintainer's approved path. Review the rule before activating it; repository settings changes are not part of a code PR.
5. After verifying those protections and one npm authentication path, in GitHub **Settings → Secrets and variables → Actions → Variables → New repository variable**, enter name `VERIFY_CI_PUBLISH_ENABLED`, value `true`, then **Add variable**. This is deliberately a repository variable, not a workflow input or an environment variable set in code. Only an authorized settings administrator should enable it. Set it to `false` or delete it to disable future unpublished-version releases; disable it if protection or authorization is removed. Our GitHub App has no access to flip this setting.
6. In GitHub **Actions → Release → Run workflow**, select the intended revision and **Run workflow**. This manual run validates and dry-runs only; it has no publish credentials or OIDC permission and cannot test npm publish authorization. After it passes and release approval is explicit, push the approved `v0.2.0` tag instead of performing the Mac publication.
7. Open the resulting **Actions → Release** run, inspect validation and the package artifact, then use **Review deployments → npm → Approve and deploy**. The publish job uses GitHub-hosted runners, Node 24, npm 11 and `id-token: write`; the repository must be public and match the package's `repository.url`. It publishes the exact validation artifact with provenance, without reinstalling dependencies or rebuilding. Confirm the npm version, integrity, dist-tag and provenance afterward.

Release checks the exact tag/version match and that the tagged commit belongs to `main`. Its unauthenticated, time-bounded lookup skips publication only when the public npm registry returns the exact package/version. A 404 proceeds only with the explicit administrator opt-in; other HTTP errors, malformed responses and transport failures fail validation. The publish job also checks the opt-in before running. Authentication, provenance or publish failures remain failed jobs; there is no catch-all success. A race with another publisher can still fail at npm: inspect the registry instead of retrying blindly. Manual workflow runs never publish; ordinary branch/PR pushes never publish. An already-published version skips the publish job but still runs validation, even without the CI opt-in, so the Mac-first path remains usable. This is not permission to rewrite tags or change published bytes.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Go module release: go/v0.1.0

The module path is `github.com/RevylAI/verify/go`, so its release tag must be `go/v0.1.0`, not `v0.1.0`. The root `v*` workflow is for npm; a `go/v*` tag does not publish npm. Go releases require no npm token or npm package.

1. Select the reviewed, approved `main` revision in a clean checkout. From `go/`, run:

   ```bash
   test -z "$(gofmt -l .)"
   go vet ./...
   go test -race ./...
   ```

2. Return to the repository root. After separate approval to create and push this Go tag:

   ```bash
   git tag -a go/v0.1.0 -m 'Verify Go SDK 0.1.0'
   git push origin go/v0.1.0
   ```

3. From a fresh consumer module, run `go get github.com/RevylAI/verify/go@v0.1.0` and `go list -m -json github.com/RevylAI/verify/go`; confirm the resolved version and build the consumer. Go's public module proxy may take time to discover a tag. Do not move a tag or publish a different tree under an existing version. Before the first tag, use a reviewed commit or `@main`, which resolves to a pseudo-version.
