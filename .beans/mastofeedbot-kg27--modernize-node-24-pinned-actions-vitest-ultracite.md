---
# mastofeedbot-kg27
title: 'Modernize: Node 24, pinned actions, vitest, ultracite, fallow'
status: in-progress
type: epic
priority: high
tags:
    - modernize
created_at: 2026-11-27T22:48:46Z
updated_at: 2026-11-27T22:48:56Z
---

Approved plan 2026-11-27. Unstick git, then modernize toolchain and CI.

## Todo

- [x] Unstick git: abort rebase; archive/local-main-pre-modernize; main reset to origin/main; `git pull` verified
- [ ] Carry local work to feature branch (src/index.ts refactor + suite ported to vitest)
- [ ] Node 24: .nvmrc, engines, @types/node, action.yml runtime, esbuild target, dist rebuild
- [ ] vitest unit + integration suites green
- [ ] ultracite + biome lint green
- [ ] fallow installed, audit run
- [ ] All workflow actions SHA-pinned latest; node16 setup gone; ci.yml gate added
- [ ] AGENTS.md created
- [ ] code-review skill run; surfaced issues remediated
- [ ] PR opened for review

branch: feat/kg27-modernize
