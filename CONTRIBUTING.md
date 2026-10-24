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

Keep changes focused and update the package docs and changelog when behavior changes. Add regression coverage using existing test conventions. The library lives in `packages/verify/`; examples live in `examples/`. Package README, license, changelog, and security files are copied from the root during `prepack`; edit the root sources, not generated copies.

Open a pull request with the behavior change, checks run, and any integration limitations. Do not publish packages or push release tags as part of a contribution. Maintainers follow [RELEASING.md](RELEASING.md).
