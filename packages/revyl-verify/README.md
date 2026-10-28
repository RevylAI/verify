# revyl-verify

Unscoped alias for [`@revyl/verify`](https://www.npmjs.com/package/@revyl/verify). It depends on the exact matching version and re-exports its ESM API and TypeScript types without duplicating the implementation.

```bash
npm install --save-dev revyl-verify
npx revyl-verify init --platform ios
npx revyl-verify whoami
npx revyl-verify --version
```

The CLI delegates to `@revyl/verify`, including its output, generated imports, authentication and exit codes. Authenticate with the Revyl CLI (`revyl auth login`) or supply `REVYL_API_KEY` securely. No cloud session is needed for `init`, `whoami` or `--version`; `whoami` checks your account over the network.

```ts
import { open } from 'revyl-verify';
```

Use Node.js 22.18 or later. See the [Verify documentation](https://github.com/RevylAI/verify/tree/v0.2.0/packages/verify/docs) for configuration, API and platform availability. This package shares Verify's [Apache 2.0 license](https://github.com/RevylAI/verify/blob/v0.2.0/LICENSE).
