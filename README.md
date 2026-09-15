# DNSmonitor

Lightweight, self-hosted DNS monitoring with equally supported WATCH and EXPECTED modes.

The React interface, authenticated API, DNS worker, and SMTP/webhook dispatcher are implemented and runnable in Docker Compose. The default is one application container plus MariaDB. Swarm and Kubernetes deployments support the same combined or split runtime; see the [deployment guide](docs/DEPLOYMENT.md).

## Run with Docker Compose

```sh
cp -n .env.example .env
# Set unique database passwords and a 64-hex-character ENCRYPTION_KEY in .env.
docker compose up --build -d --wait
```

If `.env` already exists, keep it: changing passwords there does not update an existing database volume. Compose runs migrations before starting the worker. MariaDB data persists in the `dnsmonitor_database` volume. Open the application at http://localhost:3000. For a fresh installation, configure an installation token and [create the first admin in the browser](docs/ACCOUNTS.md). Existing accounts can change passwords under **Account**. See [API setup](docs/API.md) for operator recovery and notification configuration.

```sh
# Add the bundled WATCH example; initial checks are staggered within its interval.
docker compose exec worker node dist/apps/cli/src/database.js add examples/watch.json
docker compose exec worker node dist/apps/cli/src/database.js list
# Replace MONITOR_ID with the ID returned by add/list.
docker compose exec worker node dist/apps/cli/src/database.js check MONITOR_ID
docker compose exec worker node dist/apps/cli/src/database.js inspect MONITOR_ID
```

See [worker operation](docs/WORKER.md) for custom monitor files, pause/resume, multiple workers, health checks, and integration tests.

## Development

Requires Node.js 24+ and pnpm 11.24.0.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm query example.com A 1.1.1.1 UDP 3000
```

`pnpm check` typechecks, builds, and tests. The CLI runs the compiled output; run `pnpm build` after edits. Tests start a local UDP/TCP DNS server and do not require Internet access. An environment that blocks localhost socket binding must allow it to run transport tests.

## Implemented

- A, AAAA, CNAME, MX, TXT queries over UDP or TCP; automatic TCP fallback for truncated UDP responses within one timeout budget.
- Explicit SUCCESS, NODATA, NXDOMAIN, SERVFAIL, REFUSED, TIMEOUT, and ERROR outcomes.
- Canonical record sets, IPv6 normalization, DNS hostname normalization, order-independent hashes, exact and contains matching. TTL is excluded from value comparison. TXT chunks are joined within each record; distinct TXT records remain distinct. TXT bytes use a reversible latin1 mapping in the core.
- Strict majority across configured resolvers. Missing/failing resolvers count against quorum; dissent with quorum produces a warning.
- WATCH stable baseline learning and confirmed changes; EXPECTED mismatch incidents and recovery.
- Per-monitor interval, query timeout, failure threshold, recovery threshold, and WATCH change confirmation threshold.
- Pure state transitions producing events and next due time; no database or framework dependencies in monitoring logic.
- MariaDB migrations serialized with advisory locks and tracked checksums.
- Bounded worker concurrency, database-clock scheduling, execution leases, stale-result fencing, and crash recovery.
- Atomic check/state/incident/event/outbox writes, graceful shutdown and persistent worker heartbeats.
- CLI monitor creation, list/details, pause/resume, and immediate check requests.
- Non-root application image, combined/separate runtime roles, and Compose startup with explicit migrations.
- Local Argon2id authentication, persistent expiring sessions, CSRF protection, and login throttling.
- Browser interface with monitor search, creation, per-resolver history, timing controls, incidents, and notification settings.
- shadcn/ui Base UI components, Tailwind CSS, and Lucide icons; plum/pink light and dark themes with a saved system/light/dark preference.
- Authenticated API with per-monitor timing updates, incident acknowledgement, channels, rules, and delivery status.
- AES-256-GCM encrypted channel settings, SMTP and signed webhooks, durable delivery leases/retries, and channel deduplication.

- Automatic bounded cleanup, configurable history windows, and atomic hourly check summaries. See [retention settings](docs/RETENTION.md).

- Full monitor editing and confirmed deletion, including stale-edit protection, state reset rules, and related-history cleanup. See [monitor management](docs/MONITOR-MANAGEMENT.md).

## Repository

- `packages/dns-engine`: query transport and canonical record values.
- `packages/monitoring`: monitor configuration, consensus, state transitions, domain events.
- `apps/cli`: DNS queries, migrations, and monitor management.
- `packages/database`: schema, migrations, transactions, and repository.
- `apps/worker`: persistent scheduling and query execution.
- `apps/api`: API and shared application lifecycle.
- `apps/web`: React interface, bundled and served by the API.
- `packages/auth`: accounts, sessions, and login limits.
- `packages/notifications`: encrypted channels, rule routing, and delivery.
- `tests`: offline DNS fixtures and state-machine tests.
- [Implementation plan](docs/IMPLEMENTATION.md): decisions, milestones, acceptance criteria.
- [Original blueprint](docs/BLUEPRINT.md): supplied proposal; the implementation plan records subsequent decisions.

## Deployment direction

One application image with `all`, `api`, and `worker` roles, plus MariaDB. Docker Compose, Swarm, and Kubernetes are required release targets. The smallest finished installation will use one `all` instance and one MariaDB instance. The image supports all three roles and CLI commands now. React assets are served by the API. Application instances have no persistent local state.

The baseline workload is 25 monitors, three resolvers each, every five minutes. Faster intervals remain configurable. A total 1 vCPU / 512 MiB deployment is an unverified benchmark target, not a supported minimum yet.

For browser development, run the application API and `pnpm dev:web`. For automated browser tests, start the disposable database in `deploy/compose.test.yaml`, run `pnpm exec playwright install chromium`, then `INTEGRATION_DATABASE_URL=mysql://dnsmonitor_test:test-only-password@127.0.0.1:13306/dnsmonitor_test pnpm test:e2e`. The browser fixture resets that test database and uses local DNS and webhook receivers. Never point it at an installation database.

## Resource and recovery evidence

The 25-monitor, five-minute workload passed an eleven-minute baseline with a 448 MiB combined app/database container limit, followed by worker/database restart and backup restoration drills. See [results and reproduction instructions](docs/VALIDATION.md). The tested container budget excludes the host and orchestrator overhead.

## System health

Open **System health** for worker heartbeats, overdue checks, scheduler delay, DNS timeouts, notification queues and retention/storage status. A private loopback Prometheus endpoint is included without an extra service. See [operational health and metrics](docs/OPERATIONS.md).

## v0.1 release preparation

Versioned image publishing and Helm/deployment bundles are prepared. See [release preparation, installation and upgrades](docs/RELEASE.md) and [the changelog](CHANGELOG.md). Publishing is a manual action; the long soak remains outstanding. Version and build information are displayed under **Account** and returned by authenticated `GET /api/v1/version`.

## License

[MIT](LICENSE) © 2026 Mário Gomes.
