---
# mastofeedbot-fbf2
title: Carry local work onto feat branch
status: completed
type: task
priority: high
tags:
    - modernize
created_at: 2026-11-27T22:48:51Z
updated_at: 2026-11-27T22:55:44Z
parent: mastofeedbot-kg27
---

Restore src/index.ts refactor (incl. empty-after-filter guard) and test suite from archive/local-main-pre-modernize; port jest suite to vitest.

## Todo

- [x] restore src/index.ts + src/index.test.ts from archive
- [x] recreate .vscode beans tweak lost in rebase abort
