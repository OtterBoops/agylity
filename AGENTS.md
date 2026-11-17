# Agent Instructions (`agylity`)

Autonomous coding agents and AI pair programmers working in this repository must adhere to these invariants. For domain architecture, Connect-RPC protocols, and ToS guardrails, see [skills/agylity/SKILL.md](./skills/agylity/SKILL.md).

## Repository Invariants

1. **Zero-CVE Minimal Dependencies**: Runtime dependencies are locked to `discord.js`, `ky`, and `zod`. Do not add new external runtime dependencies.
2. **Public-Safe Documentation & Code**: Never commit private hostnames, internal IPs, local filesystem paths, or account identifiers into tracked files (`README.md`, `docs/`, `skills/`, or source).
3. **Always Update Documentation**: Inspect and update relevant docs (`README.md`, `docs/`, `skills/agylity/SKILL.md`) whenever changing behavior, schemas, configuration, or CLI/runner contracts.
4. **Tailwind v4 Invariant**: In `frontend/`, compose styles strictly via utility classes in Preact markup. Root stylesheets (`frontend/src/index.css`) hold only `@import "tailwindcss";`, `@theme`, and design token variables with zero custom CSS classes.
5. **Prettier & Canonical Tailwind Classes**: Keep formatting and Tailwind class ordering compliant with Prettier (`prettier-plugin-tailwindcss`) and ESLint (`eslint-plugin-better-tailwindcss`).
6. **Zero-Clobber Invariant**: Never execute autonomous `agy` tasks headlessly on the monitoring daemon host; runner execution belongs in isolated runner containers or separate checkouts.
7. **Node Native Test Hygiene**: Tests use `node:test` (`node --no-warnings --import tsx --test`). Any test binding HTTP servers, sockets, or timers must guarantee teardown in `try ... finally` or `t.after()`.

## Verification

Run before finishing any change:

```bash
npm run lint
npm run typecheck
npm test
```
