---
# mastofeedbot-5he9
title: vitest unit + integration suites
status: completed
type: task
priority: high
tags:
    - modernize
created_at: 2026-11-27T22:48:51Z
updated_at: 2026-11-27T22:55:44Z
parent: mastofeedbot-kg27
---

vitest 5.1.2, projects config: unit (src) + integration (test/integration). Port jest suite; integration covers main() flow with stub Masto client + real fs cache.

## Todo

Note: @sohailalam2/abu dropped — SHA256Hash crashes on node >=20 (global.crypto.webcrypto undefined); replaced with node:crypto createHash.

- [x] vitest config with named projects
- [x] port jest suite (16 unit tests)
- [x] integration suite green (6 tests, real fs + hashed cache)
