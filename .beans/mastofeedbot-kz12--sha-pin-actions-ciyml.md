---
# mastofeedbot-kz12
title: SHA-pin actions + ci.yml
status: completed
type: task
priority: high
tags:
    - modernize
created_at: 2026-11-27T22:48:51Z
updated_at: 2026-11-27T22:55:44Z
parent: mastofeedbot-kg27
---

jewschool.yml: github-script v9, cache latest, SHA pins. release.yml: checkout v7, setup-node v7 node 24, pin third-party actions. New ci.yml lint/test/build gate.

## Todo

- [x] jewschool.yml pins (github-script v9, cache v5.1.0)
- [x] release.yml pins + node 24
- [x] ci.yml added (lint+test+build; fallow on PR)
