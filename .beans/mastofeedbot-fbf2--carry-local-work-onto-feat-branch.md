---
# mastofeedbot-fbf2
title: Carry local work onto feat branch
status: in-progress
type: task
priority: high
tags:
    - modernize
created_at: 2026-11-27T22:48:51Z
updated_at: 2026-11-27T22:48:51Z
parent: mastofeedbot-kg27
---

Restore src/index.ts refactor (incl. empty-after-filter guard) and test suite from archive/local-main-pre-modernize; port jest suite to vitest.

## Todo

- [ ] restore src/index.ts + src/index.test.ts from archive
- [ ] recreate .vscode beans tweak lost in rebase abort
