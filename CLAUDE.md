# Neuralingual MCP

User-facing CLI for [Neuralingual](https://neuralingual.com) — AI-powered affirmation practice sets. Published as `@innerstacklabs/neuralingual-mcp` on npm.

## Repository Structure

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI commands (Commander.js) |
| `src/user-client.ts` | HTTP client for Neuralingual API (JWT auth) |
| `src/auth-store.ts` | Local token persistence (`~/.config/neuralingual/`) |
| `src/types.ts` | Shared types and API base URLs |
| `src/set-file.ts` | YAML set file serialization/deserialization |
| `scripts/postbuild.mjs` | Adds shebang to dist files after tsc |

## Build

```bash
npm install
npm run build      # tsc + postbuild shebang
npm run typecheck   # type-check only
```

## Relationship to Private Repo

This is the **public** package extracted from `innerstacklabs/neuralingual` (private monorepo). 

**Development flow:** Code is developed in the monorepo's `packages/mcp/`, then synced here with admin commands stripped. This repo is the published artifact.

**What's here:** User-facing CLI only — library management, set creation, rendering, playback, YAML round-trip, voice browsing.

**What's NOT here:** Admin commands (catalog management, user admin, preamble sync), admin API client, MCP server (admin-only, being converted to user auth in #411).

**Issue routing:**
- CLI bugs and feature requests → this repo
- API/backend issues → `innerstacklabs/neuralingual` (private)

## Key Conventions

- **Default env is production** — `--env dev` for local development
- **Auth via Apple Sign-In** — `neuralingual login` opens browser flow
- **Short IDs** — `neuralingual library` shows truncated IDs; all commands resolve them via prefix matching
- **No admin code** — no `AdminApiClient`, no `NL_ADMIN_KEY` references, no admin commands

## npm Publishing

- Package: `@innerstacklabs/neuralingual-mcp`
- Auth: OIDC trusted publishing via GitHub Actions (no stored npm token)
- Workflow: `.github/workflows/publish.yml` triggers on `v*` tags
- Release: `npm version patch && git push && git push --tags`
- Prerequisite: trusted publisher must be linked on [npmjs.com package access page](https://www.npmjs.com/package/@innerstacklabs/neuralingual-mcp/access) (org: `innerstacklabs`, repo: `neuralingual-mcp`, workflow: `publish.yml`)
