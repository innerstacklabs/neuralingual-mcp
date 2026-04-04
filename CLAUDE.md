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
- Token: stored in 1Password ("npm - ISL Publish Token") and GitHub secret `NPM_TOKEN`
- Publish: `npm publish --access public` (CI via GitHub Actions on tagged releases)
- Token expires every 90 days — check 1Password for rotation date
