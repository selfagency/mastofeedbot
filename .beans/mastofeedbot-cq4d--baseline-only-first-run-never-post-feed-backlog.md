---
# mastofeedbot-cq4d
title: 'Baseline-only first run: never post feed backlog'
status: completed
type: bug
priority: high
tags:
    - modernize
created_at: 2026-11-27T23:49:19Z
updated_at: 2026-11-27T23:59:36Z
parent: mastofeedbot-kg27
---

Cold/missing cache dumped entire feed history (racknerd: 4,488 entries, ~180 posts before cancel). Behavior fix: missing cache = first sighting; record baseline, post nothing. Corrupt cache = fail loudly, post nothing.

## Todo

- [x] failing tests first (RED), then implementation (36→42 tests)
- [x] getCache returns existed/failed/lastRun; cache file v2 stores lastRun + seen (legacy arrays migrate)
- [x] main(): baseline write instead of posting when cache is new (closes issue #3)
- [x] dedupe hashing into one helper
- [x] tests green (42/42), tsc clean, dist rebuilt
- [x] workflow seed step dropped (bot self-baselines); cache-limit 10000; rackspace racknd flood incident post-mortem in run 46083573049
