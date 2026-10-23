# Releasing Verify

Publishing, creating tags, changing repository visibility, and npm account setup are human-maintainer actions. This repository's release workflow does not publish on a branch push, pull request, or manual run. A manual **Release** run is always a dry run; a pushed `v*` tag can publish after validation and the `npm` environment's approval.

## One-time setup

1. On npmjs.com, confirm the team controls the `@revyl` organization and that the publishing maintainer has package-write permission. Create or claim the organization if necessary; an unused package name does not prove scope ownership. Enable 2FA. Public scoped packages are supported. If the scope is unavailable, select the fallback below before releasing.
2. Review the entire repository and git history, resolve the pre-public audit findings, and make `RevylAI/verify` **public** in GitHub settings. Provenance requires a public source repository matching the case-sensitive `repository.url` in the package manifest. The workflow refuses an internal/private source.
3. Create a GitHub environment named **npm**, require maintainer review, and limit deployments to release tags. Protect release-tag creation with repository rules. Add no Revyl runtime credentials to release jobs; unit tests and package builds do not need them.
4. Prefer npm trusted publishing after the package exists: npm package **Settings → Trusted Publisher → GitHub Actions**, organization/user **RevylAI**, repository **verify**, workflow filename **release.yml**, environment **npm**. Explicitly allow direct **npm publish**; stage-only permission does not allow this workflow. It uses GitHub-hosted runners, Node 24, npm 11 (OIDC requires npm >=11.5.1), and `id-token: write`.
5. A brand-new package may not expose trusted-publisher settings until its first publication. For that bootstrap, create a short-lived **granular** npm token with read/write **publish and stage** permission for the package/scope, not merely organization-management permission. Non-interactive direct publishing requires bypass-2FA permission where the account/package policy permits it. Store it as the **NPM_TOKEN** secret in the protected **npm** GitHub environment. Do not put it in a file, command line, or chat. A stage-only token cannot run this direct-publish workflow. If policy forbids token publishing, stop and have an npm organization administrator arrange the first publication; do not weaken policy.
6. After the first publication, configure and validate the trusted publisher, remove/revoke `NPM_TOKEN`, and select npm's “Require two-factor authentication and disallow tokens” publishing access. New publisher configurations must successfully publish within two days or be recreated. npm documents removal of direct token publication in January 2027; the token path is a temporary bootstrap, not the long-term release mechanism.

References: [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/), [granular tokens](https://docs.npmjs.com/about-access-tokens/). A dry run checks contents, not npm ownership, publisher configuration, token permissions, or actual provenance issuance.

## Optional fallback package name

The selected name remains `@revyl/verify`. If the scope cannot be claimed, run this **single command** from a clean release checkout before publication:

```bash
npm run package:rename -- revyl-verify
```

It updates the maintained package references, examples and install/import docs, then regenerates the npm lockfile. Runtime init imports and install guidance read the package manifest. Review and commit the diff, rerun all checks, and configure the npm publisher/token for the selected name. The binaries remain `verify` and `revyl-verify`; never publish as the unrelated unscoped `verify` package. Do not change the name after publishing a version without a separate migration decision.

## Cut 0.1.0

1. Merge the reviewed library, Mac early-access, and release-preparation changes to `main`, in that order. Do not include unapproved features by tagging their branch. Review the approved production mobile/web smoke results before release approval; unit tests are not live proof. Mac remains early access and has no live-run proof in this release preparation.
2. In a clean checkout of the intended `main` commit, verify `packages/verify/package.json` is `0.1.0`, update the changelog, and run `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run check:package`. Pack and dry-run that exact archive:

   ```bash
   mkdir release-artifacts
   npm pack --workspace ./packages/verify --pack-destination ./release-artifacts
   npm publish ./release-artifacts/*.tgz --dry-run --access public
   ```

   Review every listed file, both CLI bins, and the npm README links. Publishing an archive also avoids npm 11's workspace-directory dry-run warning that incorrectly removes bins while resolving their paths from the workspace root. Future version changes must also update example dependency versions and regenerate the lockfile.
3. From GitHub Actions, run **Release → Run workflow** on the intended revision. It only validates and dry-runs, with no publish credentials or OIDC permission. Confirm it succeeds. This workflow must first exist on the default branch to be manually selectable.
4. When npm setup, repository visibility, audit, live verification, and review are complete, the human maintainer creates and pushes the annotated tag:

   ```bash
   git switch main
   git pull --ff-only origin main
   git tag -a v0.1.0 -m 'Verify 0.1.0'
   git push origin v0.1.0
   ```

5. Review and approve the protected **npm** environment deployment. The workflow checks exact tag/version equality, verifies the commit belongs to `main`, builds/types/tests/checks the tarball, then publishes that exact package artifact with `--provenance --access public`. The publish job does not reinstall project dependencies or rebuild the artifact. It never creates a tag itself. Verify the published version, README, file list, and provenance on npmjs.com afterward.

If validation fails, fix and review the cause before another attempt. If publication may already have succeeded, inspect npm before retrying; published version numbers cannot be reused. Do not move a public release tag or publish a different artifact under the same version.
