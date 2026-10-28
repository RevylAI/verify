# Releasing Verify

Publishing, pushing tags, and configuring npm, PyPI or GitHub are human-maintainer actions. Preparing this repository does not authorize any of them.

## Current release path

`@revyl/verify@0.2.0` is already published from Anam's Mac, without provenance. The `v0.2.0` and `go/v0.1.0` tags already exist; do not move them or rerun their release workflow to add the alias. The first `revyl-verify@0.2.0` publication is a separate, explicitly approved action from Anam's Mac after the alias PR merges. Do not republish or change the scoped 0.2.0 package. GitHub CI publication remains optional and requires a repository administrator to configure the protections and npm authorization below.

Both npm packages use version 0.2.0. The source-free alias depends on exactly the same `@revyl/verify` version and re-exports its API, types and CLI. Keep both versions and that exact dependency in lockstep for future releases, then regenerate `package-lock.json` with npm. The Go module has an independent version and uses `go/v*` tags. Neither merging code nor updating this guide publishes either SDK.

Python is independently versioned at 0.1.0 and uses `py/v*` tags. Its distribution is `revyl-verify`, not the existing `revyl` CLI package. It is prepared in source, not published or live-verified; see [Python release preparation](#python-distribution-release-pyv010).

The root README is the maintained landing page. `prepack` generates the scoped npm README with version-pinned repository and badge links; do not edit `packages/verify/README.md` directly. The alias has a small maintained README and copies the root license during packing.

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
npm pack --dry-run --workspace ./packages/revyl-verify
mkdir -p release-artifacts/scoped release-artifacts/alias
npm pack --workspace ./packages/verify --pack-destination ./release-artifacts/scoped
npm pack --workspace ./packages/revyl-verify --pack-destination ./release-artifacts/alias
```

Stop if the checkout is dirty, the manifest/example versions, alias dependency or generated lockfile disagree, or any check fails. Review both packed inventories, CLI bins and README links. Both packages produce the same tarball basename (`revyl-verify-0.2.0.tgz`), so keep them in separate directories. `check:package` installs both exact archives into a fresh consumer and checks API/type re-exports, CLI parity and web init without a live session. The scoped archive built now is validation evidence, not a replacement for the already-published 0.2.0 bytes. Version-pinned scoped documentation still describes the original `v0.2.0` tree. Publish only the reviewed archive for a missing package/version; do not select old archives with a wildcard. Pack/dry-run checks do not prove npm authorization or provenance.

## Default: publish missing versions from Anam's Mac

1. In Anam's interactive terminal, run `npm login --registry=https://registry.npmjs.org` if needed, complete the browser/2FA flow, then run `npm whoami`. Use an account with publish permission for both packages (or permission to create the unscoped alias on its first release). Do not paste credentials, one-time codes, or tokens into commands, source, logs, or chat.
2. Check each exact version independently with `npm view @revyl/verify@0.2.0 version --registry=https://registry.npmjs.org` and `npm view revyl-verify@0.2.0 version --registry=https://registry.npmjs.org`. An exact published version skips both publication dry-run and publication for that package. Only an explicit npm E404 means the version is absent; network, authorization, or registry errors are blockers, not permission to publish. For this alias bootstrap, confirm scoped 0.2.0 exists, then skip it.
3. After explicit release approval, dry-run and publish only each missing version's reviewed archive, scoped first and alias second. For the alias bootstrap, run only:

   ```bash
   npm publish ./release-artifacts/alias/revyl-verify-0.2.0.tgz --dry-run --access public --registry=https://registry.npmjs.org
   npm publish ./release-artifacts/alias/revyl-verify-0.2.0.tgz --access public --registry=https://registry.npmjs.org
   ```

   Complete npm's interactive approval/2FA prompt. This local route does not produce GitHub Actions provenance; do not add `--provenance` or claim an attestation exists.
4. Verify each published package's exact version, `dist.integrity` and `dist-tags` with `npm view`, then install both exact versions in a fresh consumer. Check `npx revyl-verify --version`, `npx revyl-verify init --platform web` and an import from `revyl-verify`. Compare the alias's published file list and integrity with its reviewed archive. A successful pack or dry run is not a successful publication.
5. For future versions only, after separate tag approval, record the exact source revision with a new immutable annotated `v*` tag. Do not recreate the existing 0.2.0 tag. For example, after bumping both packages and the exact dependency to 0.2.1:

   ```bash
   git tag -a v0.2.1 -m 'Verify 0.2.1'
   git push origin v0.2.1
   ```

   The tag triggers Release validation. Each package already on npm skips its own publication dry-run and publication, while retaining build, tests and package checks. If both exist, the publish job skips without requiring CI credentials. If publication may have succeeded despite an error, inspect npm before retrying; published versions cannot be reused. A partial release must be completed in scoped-before-alias order, without republishing the existing package.

## Optional: configure GitHub Actions trusted publishing

This is an alternative to publishing from the Mac, not a prerequisite for it. Anam or another repository administrator must perform these clicks; the GitHub App cannot do them. CI publication is disabled unless the repository variable `VERIFY_CI_PUBLISH_ENABLED` is exactly `true`. Without it, an unpublished-version tag fails validation before the environment job can run. Naming an environment alone is not protection: GitHub can otherwise create a missing one unprotected. Set this opt-in only after reviewing the environment, tag rules and npm authorization below; it is an administrator attestation, not an automatic audit of those settings.

1. In GitHub **RevylAI/verify → Settings → Environments → New environment**, enter `npm`, then **Configure environment**. Under deployment protection rules, enable **Required reviewers**, choose the release maintainer/team, and **Save protection rules**. Use **Prevent self-review** only if another eligible maintainer is available. Under **Deployment branches and tags**, choose **Selected branches and tags → Add deployment branch or tag rule → Tag**, enter `v*`, and **Add rule**. Do not add Revyl runtime credentials or a publish token.
2. After both packages exist on npm, configure each package independently under **Packages → @revyl/verify / revyl-verify → Settings → Trusted Publisher → GitHub Actions**: organization/user `RevylAI`, repository `verify`, workflow filename `release.yml` (not its directory path), and environment `npm`. Explicitly allow direct **npm publish**, not just staged publishing, then save. New trusted publishers must complete their first successful publication within two days or be recreated.
3. With trusted publishing, in each package's **Settings → Publishing access**, select **Require two-factor authentication and disallow tokens**, then **Update Package Settings** when the team is ready to use this policy. No `NPM_TOKEN` is required for trusted publishing. Alternatively, if the team's npm policy explicitly permits token publishing, create a short-lived granular token limited to publishing both packages (including direct publish permission and bypass-2FA only where that policy allows it), then in GitHub **Settings → Environments → npm → Environment secrets → Add environment secret**, enter `NPM_TOKEN`, paste its value directly into GitHub, and save. Never put it in a command, file, chat, repository variable or repository-wide secret. A stage-only token cannot run this direct-publish workflow. Do not weaken 2FA or use a long-lived token as a workaround.
4. In GitHub **Settings → Rules → Rulesets → New ruleset → New tag ruleset**, protect `v*` against unauthorized creation, updates, and deletion, leaving only the release maintainer's approved path. Review the rule before activating it; repository settings changes are not part of a code PR.
5. After verifying those protections and one npm authentication path, in GitHub **Settings → Secrets and variables → Actions → Variables → New repository variable**, enter name `VERIFY_CI_PUBLISH_ENABLED`, value `true`, then **Add variable**. This is deliberately a repository variable, not a workflow input or an environment variable set in code. Only an authorized settings administrator should enable it. Set it to `false` or delete it to disable future unpublished-version releases; disable it if protection or authorization is removed. Our GitHub App has no access to flip this setting.
6. In GitHub **Actions → Release → Run workflow**, select the intended future-release revision and **Run workflow**. This manual run validates and dry-runs missing versions only; it has no publish credentials or OIDC permission and cannot test npm publish authorization. After it passes and release approval is explicit, push a new approved `v*` tag instead of performing the Mac publication. Do not rerun or move `v0.2.0` for the alias bootstrap.
7. Open the resulting **Actions → Release** tag run, inspect validation and both package artifacts, then use **Review deployments → npm → Approve and deploy**. The publish job uses GitHub-hosted runners, Node 24, npm 11 and `id-token: write`; the repository must be public and match each package's `repository.url`. It publishes the exact validation archives with provenance, scoped first, then alias, skipping each version already present, without reinstalling dependencies or rebuilding. Confirm both npm versions, integrity, dist-tags and provenance afterward.

Release checks lockstep package versions, the exact alias dependency and tag/version match, and that the tagged commit belongs to `main`. Its unauthenticated, time-bounded lookup skips publication for a package only when the public npm registry returns that exact package/version. A 404 permits tag-triggered publication only with the explicit administrator opt-in; other HTTP errors, malformed responses and transport failures fail validation. The publish job also checks the opt-in before running. If the scoped publication fails, the alias step does not run. A partial-release rerun skips the existing version independently. Authentication, provenance or publish failures remain failed jobs; there is no catch-all success. A race with another publisher can still fail at npm: inspect the registry instead of retrying blindly. Manual workflow runs never publish; ordinary branch/PR pushes never publish. When both versions exist, publication dry-runs and the publish job skip but validation still runs without the CI opt-in, so the Mac-first path remains usable. This is not permission to rewrite tags or change published bytes.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Python distribution release: py/v0.1.0

This is preparation only: no PyPI settings, tags or publication are authorized by this guide. Python fake-server and installed-wheel tests do not prove live behavior. Review `python/README.md`, including thread-adapted async cancellation limits and staging-only computer availability, before approving a release.

### Prepare and validate

Use a clean checkout of the approved `main` revision and Python ≥3.10. From `python/`, with no stale files in `dist/`, run:

```bash
uv sync --frozen
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen mypy
uv run --frozen pytest
uv build
uv run --frozen python -m twine check --strict dist/*
uv run --frozen python scripts/check_package.py
uv run --frozen python scripts/check_release.py py/v0.1.0
uv run --frozen python scripts/check_release.py --registry
```

The artifact check compares wheel and sdist file allowlists, metadata, license and `py.typed`, installs the wheel into a fresh venv and runs the loopback fake-server smoke without pytest or a source import. It also extracts the sdist and runs its tests with an independent locked dev environment; repository-only workflow and canonical Go fixture parity checks skip outside the repository. `uv build` builds the wheel through the sdist. Inspect both distributions. The registry check is read-only: only an explicit 404 means absent; HTTP errors, redirects, malformed metadata, timeouts and transport failures fail closed. An exact existing package/version with published files skips publication, even without CI opt-in. Never reuse a published version or move an existing tag.

In **Actions → Release Python → Run workflow**, select the reviewed revision. Dispatch runs validation only, without publish credentials or OIDC permission. It checks the exact registry version and skips the publication metadata/dry-run equivalent when that version already exists. `twine check --strict` is a local metadata check, not a PyPI authorization test or publication. Normal PR/branch pushes run CI, never publish.

### Administrator setup (separate approval required)

1. In GitHub **RevylAI/verify → Settings → Environments**, create `pypi`. Configure required reviewers and tag deployment rules limited to `py/v*` before enabling publication. Naming an environment in YAML is not protection: GitHub can otherwise create it unprotected.
2. In PyPI, configure the `revyl-verify` project's **Publishing → Add a new publisher → GitHub** (or a pending publisher before first publication). Use owner `RevylAI`, repository `verify`, workflow filename `release-python.yml` and environment `pypi`. Confirm package-name ownership and account permissions; the existing `revyl` CLI is a different project and does not grant ownership of `revyl-verify` automatically. Use trusted publishing, not a long-lived API token.
3. Protect `py/v*` tags against unauthorized creation, changes and deletion in GitHub rulesets. Review the source revision and public package contents before any approved tag push.
4. Only after checking the environment, tag protection and PyPI trusted publisher, set repository Actions variable `VERIFY_PYPI_PUBLISH_ENABLED` to exactly `true`. This is an administrator attestation, **not an automatic audit** of those protections. Delete it or set it to `false` if any protection is removed. An absent version on a tag fails validation without this opt-in; dispatch never needs it and never publishes.

### Approved publication

After separate release/tag approval, from the repository root at the checked `main` revision:

```bash
git tag -a py/v0.1.0 -m 'Verify Python SDK 0.1.0'
git push origin py/v0.1.0
```

The `py/v*` workflow checks the exact manifest/tag match and that the commit belongs to `origin/main`. It builds/tests/checks the distributions, uploads the exact validated artifacts, then waits for the `pypi` environment approval. The publish job has OIDC permission, uses `pypa/gh-action-pypi-publish`, and publishes those artifacts without rebuilding. It runs only for an absent exact version and explicit administrator opt-in. It does not use `skip-existing`: a racing publisher or failed publication remains a failure to investigate, not permission to silently replace bytes. npm's `v*` workflow and Go's `go/v*` lifecycle are unaffected.

After publication, inspect `https://pypi.org/pypi/revyl-verify/0.1.0/json`, compare filenames and SHA-256 hashes to the reviewed artifacts, verify the PyPI attestations, and install `revyl-verify==0.1.0` in a clean consumer venv. Run the fake-server smoke against that installed distribution. Update publication status in the Python/root READMEs only after verification; a green dry run is not a release. Live cloud proof still requires separate workload approval.

References: [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/), [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

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
