# Per-PR environments

`environment()` runs a pull request's stack on the CI runner your script runs on, gives each listed port a public HTTPS URL, and tears it all down afterward. Pass the URLs to `proof()` so Revyl Proof of Changes tests the pull request's backend or whole stack, not staging.

```ts
import { environment, proof } from '@revyl/verify';

await using env = await environment({
  start: 'docker compose up -d',
  stop: 'docker compose down',
  expose: { API_URL: 8080 },
  ready: { API_URL: '/health' },
  seed: './scripts/seed-test-data.sh',
});

const run = await proof({
  build: 'app/build/outputs/apk/debug/app-debug.apk',
  appId: process.env.REVYL_APP_ID!,
  environment: { ...env.variables, E2E_TOKEN: { secretRef: 'E2E_TOKEN' } },
  wait: true,
});
```

The same thing from the command line, wrapping any command:

```sh
npx @revyl/verify env --start "docker compose up -d" --stop "docker compose down" \
  --expose API_URL=8080 --ready API_URL=/health -- node verify/proof.mts
```

## Read this first: what the URLs are

- **Public.** Each URL is a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) on `*.trycloudflare.com`. Anyone who has the URL can reach the port behind it. The hostname is random and unguessable, but nothing checks who is calling.
- **Only for the run.** A tunnel lives as long as the `cloudflared` process Verify started. It's gone after `close()`, the end of the `await using` block, or the end of `verify env`.
- **Best effort.** Quick tunnels need no Cloudflare account and come with no uptime guarantee. Cloudflare rate-limits how many one network address can create; Verify retries a refusal twice and then fails with `TUNNEL_FAILED`.
- **Hidden in logs.** Verify never prints a URL unless you pass `showUrls: true` or `--show-urls`. It replaces any quick-tunnel URL in the commands' output with `<tunnel url>`, and on GitHub Actions it also masks each URL. Treat a URL like a password while it's up, and don't put one in a pull request comment.
- **Your secrets stay yours.** The stack runs on your runner with the job's own environment and secrets. Verify sends nothing to Revyl; `proof()` receives only what you pass in `environment`. Plain values there are stored with the run and can appear in reports, so pass secrets as `{ secretRef }`.

If anyone reaching the stack would be a problem (for example a dashboard served already signed in), keep that stack off a public URL.

## What happens, in order

1. **Tunnels.** One quick tunnel per exposed port starts before the stack, so the start command already has `NAME=<url>` in its environment.
2. **Start.** `start` runs through `sh -c` in its own process group, from `cwd`, with `env` added. Its output streams to stderr with a `start:` prefix. It may keep running (`npm run dev`) or exit 0 once it has started things in the background (`docker compose up -d`). Any other exit fails with `ENVIRONMENT_START_FAILED`, the exit code and the last lines of output.
3. **Ready.** Each name with a `ready` path must answer 2xx or 3xx on `localhost`, and then through its public URL. A name without one waits for its port to accept connections and for its URL to reach it. Polls run every second, with a 5-second limit per request, until `readyTimeoutMs` (5 minutes by default). A new quick tunnel usually takes 10 to 30 seconds to route, and that overlaps with the stack starting.
4. **Seed.** `seed` runs once, with the URLs in its environment, within `seedTimeoutMs` (5 minutes).
5. **Teardown.** On `close()`, an error during setup, Ctrl+C or SIGTERM, or a script that ends without closing, Verify removes the tunnels, runs `stop` within `stopTimeoutMs` (2 minutes), and stops the start command's process group: SIGTERM, then SIGKILL after 10 seconds. It tries every step. If any step fails, `close()` throws `CLEANUP_FAILED` naming each one, so a leftover process fails the job instead of hiding.

If the process running Verify is killed outright (SIGKILL), it can't clean up. GitHub Actions ends leftover processes when the job finishes, and a `revyl-macos` job's computer is released with it.

## Keep the URLs up until the run settles

Proof checks the URL when the run is created, then the run can wait minutes in a queue and for its device before the app first calls it. A URL that dies early fails the run. Wrap the `proof({ wait: true })` call inside the environment's lifetime, as in the example above. `verify env -- <command>` gets this right by itself, because it tears down only after the command exits.

`await using` needs Node.js 24 or later. On Node.js 22, use `try`/`finally`:

```ts
const env = await environment({ /* … */ });
try {
  await proof({ /* … */, environment: env.variables, wait: true });
} finally {
  await env.close();
}
```

## Web stacks

A browser loads the page from Revyl's cloud, so every origin the page calls from the browser must be public too: the frontend, the API, and any auth or asset server you run. Expose each one, and configure the frontend with the exposed origins, not `localhost`. The start command sees every URL in its environment for that:

```ts
await using env = await environment({
  start: 'NEXT_PUBLIC_API_URL="$API_URL" npm run dev',
  expose: { APP_URL: 3000, API_URL: 8080 },
  ready: { APP_URL: '/', API_URL: '/health' },
});
```

Give the page Proof loads a `ready` path: Proof fails a page that answers 400 or above, and the ready check is what proves it doesn't.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `expose` | required | `{ NAME: port }`. Each name becomes a variable holding that port's public URL. |
| `start` | none | Shell command that starts the stack. Leave it out to expose something already running. |
| `ready` | none | `{ NAME: '/path' }`, checked on localhost and through the URL. |
| `stop` | none | Shell command run during teardown. |
| `seed` | none | Shell command run once everything is ready. |
| `cwd` | current folder | Where `start`, `stop` and `seed` run. |
| `env` | none | Variables added to `start`, `stop` and `seed`. `undefined` removes an inherited one. |
| `readyTimeoutMs` | `300000` | Time for every name to be ready. |
| `seedTimeoutMs` | `300000` | Time `seed` may run. |
| `stopTimeoutMs` | `120000` | Time `stop` may run. |
| `showUrls` | `false` | Print each URL. |
| `log` | stderr | Function receiving progress and command output, or `false` for silence. |
| `signal` | none | An `AbortSignal` that stops setup and tears down. |
| `provider` | `'quick-tunnel'` | How ports get URLs. Quick tunnels are the only provider today. |

The result has `urls` and `variables` (the same `{ NAME: url }` map), `closed`, and `close()`.

### Command line

```text
npx @revyl/verify env [--start <command>] --expose NAME=port... [--ready NAME=/path]... [--stop <command>] [--seed <command>]
                      [--ready-timeout <seconds>] [--show-urls] -- <command> [args...]
```

The command after `--` runs with the URLs in its environment, and its exit code becomes `verify env`'s. The first Ctrl+C or SIGTERM goes to the command, then the environment is torn down. A second one exits right away and can leave processes behind. A failed teardown exits 1 even when the command succeeded.

## Where it runs

On the machine your script runs on: a GitHub-hosted runner, your own runner, or the job's own Mac on `runs-on: revyl-macos`. Verify needs macOS or Linux, outbound HTTPS, and `cloudflared`:

- If `cloudflared` 2026.10.2 or later is on `PATH`, Verify uses it. Earlier releases trust revoked certificates, so Verify skips them.
- Otherwise Verify downloads a pinned `cloudflared` release from GitHub into `$XDG_CACHE_HOME/revyl-verify` (or `~/.cache/revyl-verify`, then the temp folder), checks its SHA-256 before running it, and re-checks it on every later use. It installs nothing globally and needs no `sudo`, which matters on `revyl-macos`, where `sudo` and `/opt/homebrew` aren't available. If that fails, setup fails with `TUNNEL_UNAVAILABLE`; install `cloudflared` on the runner.

A `revyl-macos` job's computer has a hard expiry 7,200 seconds (two hours) after it is created, and the clock starts before your job does. Set `timeout-minutes` well below that, so the job finishes and tears down before the computer is stopped.

## Errors

| Code | What happened |
| --- | --- |
| `ENVIRONMENT_START_FAILED` | `start` exited non-zero before the stack was ready, `seed` failed or ran out of time, or setup was interrupted. The message has the exit code and the last lines of output. |
| `ENVIRONMENT_NOT_READY` | A name wasn't ready in time. The message names it, says whether it got stuck on localhost or on its public URL, and gives the last status. |
| `TUNNEL_FAILED` | `cloudflared` couldn't create or keep a tunnel, including Cloudflare's rate limit. |
| `TUNNEL_UNAVAILABLE` | No usable `cloudflared` on `PATH`, and the pinned download failed. |
| `CLEANUP_FAILED` | A teardown step failed: a tunnel didn't stop, `stop` failed or ran out of time, or a process outlived SIGKILL. Check the runner before reusing it. |
