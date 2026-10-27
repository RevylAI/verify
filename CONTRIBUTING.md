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

Keep changes focused and update the package docs and changelog when behavior changes. Add regression coverage using existing test conventions. The library lives in `packages/verify/`; examples live in `examples/`. During `prepack`, the root README becomes the npm README with version-pinned repository links and image URLs; license, changelog, and security files are copied from the root. Edit the root sources, not generated copies.

Open a pull request with the behavior change, checks run, and any integration limitations. Do not publish packages or push release tags as part of a contribution. Maintainers follow [RELEASING.md](RELEASING.md).
