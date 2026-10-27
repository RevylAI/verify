# Contributing

Use Node.js 22.18 or later and npm. From the repository root:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check:package
```

Tests use a fake Revyl API and need no account. Do not start live sessions merely to run the test suite; any live run needs an authorized account, environment, and workload limit. Never put credentials, private URLs, or customer data in fixtures, logs, screenshots, issues, or pull requests. Follow [SECURITY.md](SECURITY.md) for private reports.

For the Go SDK, use Go 1.26.9 or later and run `test -z "$(gofmt -l .)"`, `go vet ./...`, and `go test -race ./...` from `go/`. See [the Go SDK guide](go/README.md). Both SDKs consume `go/testdata/device-contract.json` and `go/testdata/computer-contract.json`; keep those fixtures aligned with the public API.

For the Python SDK, use Python ≥3.10 and `uv`. From `python/`, run `uv sync --frozen`, `uv run --frozen ruff check .`, `uv run --frozen ruff format --check .`, `uv run --frozen mypy`, and `uv run --frozen pytest`. Build with `uv build` into an empty `dist/`, then run `uv run --frozen python -m twine check --strict dist/*` and `uv run --frozen python scripts/check_package.py`. The latter installs the wheel in an isolated fresh venv and runs a fake-server smoke without pytest. Regenerate `python/uv.lock` using `uv lock` after intentional dependency changes. See [the Python guide](python/README.md); no live sessions are part of these checks.

Keep changes focused and update the package docs and changelog when behavior changes. Add regression coverage using existing test conventions. The library lives in `packages/verify/`; examples live in `examples/`. During `prepack`, the root README becomes the npm README with version-pinned repository links and image URLs; license, changelog, and security files are copied from the root. Edit the root sources, not generated copies.

Open a pull request with the behavior change, checks run, and any integration limitations. Do not publish packages or push release tags as part of a contribution. Maintainers follow [RELEASING.md](RELEASING.md).

`packages/revyl-verify/` is a source-free alias: keep its version and exact `@revyl/verify` dependency aligned with `packages/verify/package.json`, and regenerate the root lockfile with npm. `npm run check:package` inspects both tarballs and checks a clean consumer installation, API/type re-exports, and CLI delegation without a live session.
