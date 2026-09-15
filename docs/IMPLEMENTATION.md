# Implementation specification and progress

## Agreed requirements

- One shared workspace; no tenant isolation.
- Low resource usage takes priority. Baseline: 25 monitors at five-minute intervals, with three resolvers per monitor.
- Timing and thresholds belong to each monitor. Installation defaults only prefill creation fields and never rewrite existing monitors.
- WATCH and EXPECTED have equal first-release priority.
- Docker Compose, Docker Swarm, and Kubernetes are first-release deployment targets.
- MariaDB coordinates persistent application state. One application image supports combined and separate runtime roles. Redis is unnecessary initially.
- Local authentication; modular DNS and monitoring code independent of API/UI.

## Current increment: browser interface, authenticated API and notifications

Implemented: DNS/monitoring core, MariaDB migrations, persistent scheduler with leases and revision fencing, atomic check/state/incident/event/outbox writes, bounded query concurrency, worker heartbeats, graceful shutdown, monitor CLI, non-root container image, and Docker Compose. Real MariaDB integration tests cover concurrent migrations, competing workers, transaction rollback, DNS changes, SIGKILL recovery, and SIGTERM shutdown.

Also implemented: Fastify API, local admin provisioning, Argon2id passwords, expiring sessions, CSRF protection, persistent login limits, audit records, per-monitor timing edits, incident acknowledgement, encrypted channels, alert rules, durable SMTP/webhook delivery, and all/api/worker runtime roles.

The React interface includes login, dashboard, searchable monitor list, WATCH/EXPECTED creation, per-resolver check history, timing controls, incident acknowledgement, channels, rules, and delivery status. The frontend uses source-owned shadcn/ui Base UI components with Tailwind CSS and Lucide. Light/dark colors follow the supplied palette, and theme choice persists locally. Local browser tests cover operator workflows, keyboard dialog dismissal/focus restoration, mobile layout, and theme persistence/system preference.

Not implemented: shared resolver-group management, Discord, Swarm/Helm manifests or resource benchmarking. Audit records are best-effort after domain mutations (login audit is transactional); a failed audit write is logged explicitly. Do not describe the current repository as production-ready.

## Behaviour decisions

- A successful observation needs identical normalized answers from more than half of configured resolvers. Two configured resolvers therefore require both. This strict policy is an initial implementation choice.
- Missing results and DNS failures count against quorum. No quorum increments monitor failures. Quorum with dissent is WARNING but does not by itself open a critical incident.
- EXPECTED supports EXACT and CONTAINS. An empty expected set is invalid; absence monitoring is outside this increment.
- WATCH requires `changeThreshold` consecutive observations of the same value to establish or replace its baseline. Establishment is an informational event, not a change alert.
- A different candidate or unavailable observation resets change confirmation. Query failures never become a baseline.
- Confirmed WATCH changes emit one VALUE_CHANGED event and adopt the new baseline. Availability failures follow incident thresholds in both modes.
- Consecutive failures open one incident. Consecutive successful observations resolve it. A recovery streak does not hide an open critical incident.
- Initial WATCH baseline learning is UNKNOWN. A pending change after baseline establishment is WARNING.
- The state machine rejects out-of-order checks. Database fencing remains necessary; timestamps alone do not establish worker ownership.
- TTL is omitted from value hashes. TTL rules, additional modes/types, DNSSEC, DoH/DoT, and remote probes are later work.

## Persistent service design and remaining work

1. Add MariaDB migrations for monitors, resolver groups/members, monitor states, executions, events, incidents, notification jobs, and worker heartbeats. Use UTC timestamps with millisecond precision.
2. Store configuration revision separately from execution ownership. Claim only available worker capacity using short transactions, a lease expiration, and a unique claim token. Do DNS I/O outside transactions.
3. On completion, verify claim token and configuration revision. Atomically persist checks, state, incident transitions, and notification jobs. Enforce unique execution/event keys.
4. Recover expired leases after process failure. Bound total DNS concurrency and connection pools; stagger initial due times. Skip missed slots instead of accumulating unbounded catch-up work.
5. Implemented: schedule from the intended due time, advancing to the next future slot after overruns. The repository computes this independently from the pure evaluator.
6. Implemented: pause invalidates active claims; resume schedules a fresh check. Both reset confirmation counters/candidates while preserving accepted baseline and active incidents. Changes to query/rule inputs increment config revision and reset relevant candidate/counter state. Timing-only changes preserve baseline. Full query edits close the previous incident with a configuration-change reason, clear the baseline and cancel obsolete alerts without sending a recovery notification.
7. Implemented SMTP and webhook dispatch with finite timeouts, retry backoff, job leases, stable delivery keys, and dead-letter status. External delivery is at least once; ambiguous provider responses may cause duplicates.

Acceptance: seed a monitor, observe checks, mutate fixture answers, see a WATCH event and EXPECTED incident, restore answers, and see recovery. Kill a worker during execution and verify recovery without duplicate incident transitions. Test with two competing workers against real MariaDB.

## Usable application

- Fastify API, shared runtime validation, bounded pagination and safe error responses.
- Local admin setup, Argon2id password hashes, secure sessions, authorization and audit trail.
- React/Vite UI: dashboard, monitors, creation/editing, per-resolver results, old/new change views, incidents and settings.
- Same-origin frontend served by API; no separate frontend container.
- DNS failure reasons and check freshness visible to operators.
- Store notification secrets encrypted with an externally supplied master key; accept mounted secret files.

Acceptance: create both monitor modes in the browser, configure distinct timing/thresholds, trigger failures, receive alerts, and observe recovery without direct database edits.

## Release and deployment

- Multi-stage non-root image, runtime roles `all|api|worker`, graceful shutdown, bounded draining, HTTP liveness/readiness and worker heartbeat.
- Compose file for application + persistent MariaDB.
- Swarm stack with external secrets, volume placement guidance and update settings.
- Helm chart with external/bundled MariaDB options, probes, resource settings, secrets, and migration Job. Migrations must be serialized; never assume replica startup order.
- Keep database, worker health, and metrics private by default. Document UDP/TCP egress and split-DNS network reachability.
- Twenty-four-hour detailed check retention by default, configurable event/incident retention, hourly aggregates, small cleanup batches, and database-size metrics.
- Benchmarks at 1 vCPU / 512 MiB and 1 GiB, including database memory. Measure scheduler lateness, query latency, steady-state memory, CPU and storage. Publish observed limits.
- Test backup/restore, upgrades, restart recovery and graceful shutdown on each deployment target. Replicated application containers do not provide database high availability.

## Later scope

Additional record types, EXISTS/CONSENSUS modes, Discord, tags, bulk import/export, maintenance windows, more roles, advanced TTL policies, and domain monitoring. Before maintenance ships, specify whether a still-open incident generates an alert when suppression ends.

## Operational constraints of this increment

- Resolver groups are created per monitor and replaced privately by full edits. Shared group editing will need revision invalidation for every affected monitor.
- Each monitor queries its resolvers sequentially; worker concurrency therefore bounds simultaneous DNS queries without an unbounded inner queue. Leases cover all resolver timeouts plus 15 seconds for persistence.
- Scheduler scans use a forced ordered index containing only enabled, due time, and ID. Lease fields are excluded so claiming does not move entries in the scanned index. Known database deadlocks/lock timeouts get at most three transaction attempts; ambiguous commits are never automatically retried.
- Implemented bounded retention with atomic hourly rollups, dependency-aware event/incident/notification cleanup, shared scheduling, archived history UI, and approximate storage sizes. See [retention policy](RETENTION.md).
- Compose has been built and run with MariaDB 11.4. Swarm and Helm deployment files now include secret mounts, startup migrations, persistent storage, probes and optional split workers; see [deployment operations](DEPLOYMENT.md).

## Next implementation increment

Full monitor editing/deletion is implemented with revision checks and explicit incident/baseline reset semantics; see [monitor management](MONITOR-MANAGEMENT.md). Swarm/Kubernetes deployment manifests are implemented. A first 25-monitor resource baseline and Compose restart/backup/restore drills passed; see [validation evidence](VALIDATION.md). Operational health UI and private Prometheus gauges are implemented; see [operations](OPERATIONS.md). Next run longer constrained-host soaks and orchestrator-specific recovery drills. Extend browser creation coverage to all supported record types alongside the existing core and API coverage.

## Account release preparation

First-admin browser setup now requires a deployment token and closes once any account exists. Account password changes verify the current password and revoke all sessions. Both flows retain the CLI operator-recovery path and need no schema migration; see [account setup](ACCOUNTS.md). The long soak remains an outstanding validation item; version metadata, changelog, local Helm/deployment packaging and manual multi-architecture image publishing are prepared. Actual publication requires a configured GitHub repository and reviewed version tag; see [release operations](RELEASE.md).
