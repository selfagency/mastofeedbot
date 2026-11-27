---
# mastofeedbot-cq4d
title: 'Baseline-only first run: never post feed backlog'
status: in-progress
type: bug
priority: high
tags:
    - modernize
created_at: 2026-11-27T23:49:19Z
updated_at: 2026-11-27T23:49:19Z
parent: mastofeedbot-kg27
---

Cold/missing cache dumped entire feed history (racknerd: 4,488 entries, ~180 posts before cancel). Behavior fix: missing cache = first sighting; record baseline, post nothing. Corrupt cache = fail loudly, post nothing.

## Todo

- [ ] failing tests: baseline-on-missing-cache, corrupt-cache posts nothing
- [ ] getCache returns existed/failed
- [ ] main(): baseline write instead of posting when cache is new
- [ ] dedupe hashing into one helper
- [ ] tests green, dist rebuilt
- [ ] drop workflow seed step (bot self-baselines); cache-limit raised
