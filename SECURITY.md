# Security

## Reporting a vulnerability

Email **support@revyl.ai** with the subject “Verify security report”. Do not open a public issue for a vulnerability or include API keys, session tokens, customer data, or screenshots containing sensitive information. Share a minimal reproduction with placeholders and affected versions; arrange a private channel before sending sensitive evidence.

The maintainers review reports and coordinate fixes and disclosure. No response-time commitment is promised. Before the first release, report against the current source revision; afterward, security fixes target the latest published version.

## Safe use

Verify starts paid remote sessions and can act on your application. Use test accounts and non-production data, explicitly authorize each workload, and close sessions in `finally`. Automatic shutdown is best effort and cannot run after a forced kill. Keep credentials in environment variables or the Revyl CLI credential store, not in source or config. Step descriptions are sent to Revyl and printed to stderr by default; do not embed private credentials or customer data in them. Treat screenshots and session reports as potentially sensitive.

Only install the package name documented in the README. The unscoped npm package named `verify` is unrelated; outside an installation, use `npx @revyl/verify`, not `npx verify`.
