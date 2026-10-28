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

Publication requires a separate maintainer approval and the repository's configured package-publishing protections. Use the package manager's documented authentication and trusted-publishing flow, complete any required review or MFA step interactively, and never place credentials in commands, source, logs, or chat.

After publication, verify the exact package version, integrity, dist-tags and archive contents from a fresh consumer. A successful local build or dry run is not proof of publication.
