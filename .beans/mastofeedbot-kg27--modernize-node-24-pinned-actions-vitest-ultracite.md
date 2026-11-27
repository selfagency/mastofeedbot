---
# mastofeedbot-kg27
title: 'Modernize: Node 24, pinned actions, vitest, ultracite, fallow'
status: in-progress
type: epic
priority: high
tags:
    - modernize
created_at: 2026-11-27T22:48:46Z
updated_at: 2026-11-27T22:55:44Z
---

Approved plan 2026-11-27. Unstick git, then modernize toolchain and CI.

## Todo

- [x] Unstick git: abort rebase; archive/local-main-pre-modernize; main reset to origin/main; `git pull` verified
- [x] Carry local work to feature branch (src/index.ts refactor + suite ported to vitest)
- [x] Node 24: .nvmrc, engines, @types/node, action.yml runtime, esbuild target, dist rebuild
- [x] vitest unit + integration suites green (22/22)
- [x] ultracite + biome lint green
- [x] fallow installed, audit run (maintainability 96.1)
- [x] All workflow actions SHA-pinned latest; node16 setup gone; ci.yml gate added
- [x] AGENTS.md created
- [ ] code-review skill run; surfaced issues remediated
- [ ] PR opened for review

branch: feat/kg27-modernize
