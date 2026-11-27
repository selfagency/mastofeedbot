---
# mastofeedbot-9ypo
title: code-review remediation
status: completed
type: task
priority: normal
tags:
    - modernize
created_at: 2026-11-27T22:48:51Z
updated_at: 2026-11-27T23:42:25Z
parent: mastofeedbot-kg27
---

Run code-review skill against final state; remediate surfaced issues; re-verify gates.

## Todo

- [x] run review (13 dimensions, diff origin/main..HEAD)
- [x] remediate: ENOENT-vs-corrupt cache handling + tests; tsconfig modernized for TS7 (bundler, ESNext+DOM lib, explicit paths); CI typecheck gate added. API usage verified: masto v8 createRestAPIClient + v1.statuses.create, @actions/core v3 exports, feed-extractor v8 extract.

Second pass over the post-review delta (mastofeedbot-test.yml, semgrep hardening, AGENTS.md): added least-priv permissions (contents: read) and a concurrency guard to the test workflow (double dispatch would double-post); verified no injection surfaces in the matrix seed (static feed list); 23/23 tests, tsc, lint clean at 32eccc2.
