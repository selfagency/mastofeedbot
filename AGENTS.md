# AGENTS.md

## Project Overview

MastoFeedBot is a GitHub Action that syndicates RSS feed entries to Mastodon. It's packaged as a composite JavaScript action (`action.yml` → `dist/index.js`), built with esbuild. The `dist/` folder is committed because Actions consume it directly — always rebuild after changing source.

Runtime: **Node 24** (`.nvmrc`, `engines.node`, esbuild target, action runtime). Lint/format: **Ultracite (Biome)**. Tests: **Vitest** (unit + integration). Tracker: **Beans** (`.beans/`).

## Setup Commands

- Install dependencies: `nvm use` then `npm ci`
- Requires Node >= 24.15.0

## Development Workflow

- Build: `npm run build` (bundles `src/index.ts` → `dist/index.js` + regenerated `dist/package.json`) — commit `dist/` changes with source changes
- Format: `npx ultracite fix`
- Lint: `npm run lint` (exit 1 on any error)
- All commits: Conventional Commits (`feat(scope):`, `fix(scope):`, `chore(scope):`), one logical change per commit

## Testing Instructions

- Run all tests: `npm test` (22 tests)
- Unit only: `npm run test:unit` — `src/index.test.ts`, external deps mocked
- Integration only: `npm run test:integration` — `test/integration/main.integration.test.ts`; real filesystem cache + real `node:crypto` hashing, Mastodon client and feed fetch stubbed at their boundaries
- Assertions must be behavioral (verify outcomes, not file existence)
- All tests must pass before any commit

## Code Style

- Ultracite/Biome enforces style; `npx ultracite fix` before committing. Config: `biome.jsonc` (extends `ultracite/biome/core`)
- No `any`; use typed casts (`as unknown as X`) in test mocks
- Sequential `await` in loops is intentional (feed order + Mastodon rate limits) — suppressed with `// biome-ignore` + reason
- ESM (`type: module`); node builtins imported with `node:` prefix

## Build and Deployment

- `action.yml`: `runs.using: node24`, entry `dist/index.js` (bundled/minified, sourcemapped)
- CI (`.github/workflows/ci.yml`): lint + tests + build on push/PR; fallow audit on PRs
- Release: `release.yml` cuts a GitHub release when package version bumps on main
- All workflow actions are pinned by full commit SHA (never move tags in `uses:`)

## Security

- Mastodon tokens flow via GitHub Actions secrets; never commit tokens
- Third-party actions pinned by SHA

## Pull Request Guidelines

- Branch naming: `feat/<bean-short-id>-<short-title>`
- Required checks: `npm run lint`, `npm test`, `npm run build` green before push
- Tracker: every task has a bean in `.beans/`; update the bean's `## Todo` and commit it with the related change; PR closes the epic's bean
