# Releasing Verify

Publishing packages and pushing tags are maintainer actions. Preparing this repository does not authorize either action.

## Validate a release

Use a clean checkout of the reviewed `main` revision and the tool versions required by the package manifests. Run from the repository root:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check:package
npm pack --dry-run --workspace ./packages/verify
npm pack --dry-run --workspace ./packages/revyl-verify
```

For Python:

```bash
cd python
uv sync --frozen
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen mypy
uv run --frozen pytest
uv build
uv run --frozen python -m twine check --strict dist/*
uv run --frozen python scripts/check_package.py
```

Review both npm archives and the Python wheel and source distribution. Package checks validate archive contents and local fake-server behavior; they do not prove publication permissions or live service behavior.

## Package rules

Keep the scoped npm package and its alias at the same version, with the alias depending on that exact scoped version. The Go module and Python distribution use their own versions and tags. Never reuse a published version or move an existing tag.

Before any publication, inspect the public registry for the exact package and version. A published version is immutable; network, authorization, malformed-response and registry failures are blockers, not permission to retry blindly.

## Publication

Publication requires a separate maintainer approval. For each package (`@revyl/verify` and `revyl-verify`), configure an npm Trusted Publisher with provider **GitHub Actions**, organization **RevylAI**, repository **verify**, workflow filename **release.yml**, and an empty environment name. Under Allowed actions, enable **npm publish**. The workflow uses Node 24, npm 11.5.1 or later, GitHub OIDC, and no npm token or GitHub environment approval.

After both publishers are configured, publish the reviewed release by pushing an annotated `vX.Y.Z` tag. The workflow validates that both npm package versions match the tag and that a nonempty matching `CHANGELOG.md` section exists before publishing. It runs the full build and checks, compares each packed archive with any exact version already on npm, publishes the scoped package before the alias, and creates an idempotent GitHub release using those validated notes. Stable versions use npm's `latest` dist-tag; prerelease versions use `next` and create a GitHub prerelease. Re-running an identical tag is safe; an existing version with different bytes fails closed. Use the workflow's `dry_run` dispatch input to validate a branch without publishing.

New npm Trusted Publisher configurations expire if they do not complete their first successful publish within two days. Configure them close to the first tag-based release, or recreate expired entries before publishing. Go tags such as `go/vX.Y.Z` do not trigger this workflow.

After publication, verify the exact package version, integrity, dist-tags and archive contents from a fresh consumer. A successful local build or dry run is not proof of publication.
