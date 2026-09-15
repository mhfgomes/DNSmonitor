# Persistent worker operation

## Docker Compose

The current stack runs MariaDB and one combined application (API, DNS worker, notifications). A one-shot migration container exits successfully before the worker starts. Create `.env` from `.env.example` only when it does not already exist, set unique database passwords and ENCRYPTION_KEY (see [API setup](API.md)), then run:

```sh
docker compose up --build -d --wait
docker compose ps
docker compose logs --tail 50 worker migrate
```

On macOS, if Docker Desktop is installed but `docker` is not found, open a new terminal or add `/Applications/Docker.app/Contents/Resources/bin` to PATH.

The database volume survives `docker compose down`. The API is published on loopback port 3000; the database and dedicated-worker health port remain private. The worker has an egress network for DNS; the database has only an internal network.

## Create and inspect monitors

Use `examples/watch.json` or `examples/expected.json` as a template. EXPECTED contains documentation-only addresses that must be replaced with your own values and resolver. All timing and thresholds live in each monitor's `config`:

| Field | Meaning |
|---|---|
| `intervalSeconds` | Scheduled time between checks, 1–604800 seconds |
| `timeoutMs` | Timeout per resolver, 1–60000 ms |
| `failureThreshold` | Consecutive failed observations to open an incident |
| `recoveryThreshold` | Consecutive successful observations to resolve it |
| `changeThreshold` | Consecutive identical observations to establish/change a WATCH baseline |

Thresholds accept 1–1000. Use 1–16 resolvers. Each resolver must have a unique ID, literal IP, protocol (`UDP` or `TCP`), and optional port. The config's resolver IDs must match the resolver definitions exactly. An EXPECTED monitor must specify a nonempty expected record set and `EXACT` or `CONTAINS` matching.

```sh
# Import the included WATCH example.
docker compose exec worker node dist/apps/cli/src/database.js add examples/watch.json

# Or import a local file using a short-lived container with a read-only mount.
docker compose run --rm --no-deps -v "$PWD/my-monitor.json:/input/monitor.json:ro" worker node dist/apps/cli/src/database.js add /input/monitor.json

docker compose exec worker node dist/apps/cli/src/database.js list
docker compose exec worker node dist/apps/cli/src/database.js inspect MONITOR_ID
docker compose exec worker node dist/apps/cli/src/database.js check MONITOR_ID
docker compose exec worker node dist/apps/cli/src/database.js pause MONITOR_ID
docker compose exec worker node dist/apps/cli/src/database.js resume MONITOR_ID
```

Import creates a new monitor each time and a dedicated resolver group. Initial execution is staggered within its interval. `check` requests the next scheduler execution immediately; it refuses paused or currently running monitors. Resume schedules an immediate fresh check. Pause/resume clears confirmation streaks and pending WATCH candidates, preserving accepted baseline and active incidents. Timing and threshold editing is available through the authenticated API; general DNS configuration editing and shared resolver management remain pending. List is limited to 1000 monitors; inspect returns the latest 20 checks, events, and incidents.

## Multiple workers and shutdown

```sh
docker compose -f compose.yaml -f deploy/compose.scaled.yaml up -d --scale dns-worker=2 --wait
```

Each worker gets a random ID at startup. `WORKER_CONCURRENCY` defaults to 2 and bounds simultaneous DNS queries per worker: resolvers within a monitor run sequentially. Claims are limited to available capacity. Known database contention retries are bounded; lost database connections never count as DNS failures.

SIGTERM/SIGINT stop new claims, allow 15 seconds for active queries to finish, then cancel remaining queries and release their claims. Compose permits 45 seconds for shutdown, including database operations. If a worker is killed, its leases expire after the configured total DNS timeout budget plus 15 seconds. A replacement marks the interrupted check ABANDONED and retries it. A late result cannot overwrite current state.

For dedicated workers, the private health endpoints are `/health/live` and `/health/ready` on port 3001. Readiness requires a recent successful worker heartbeat and becomes false during shutdown/database outages. Heartbeats are stored in `workers`; liveness checks the HTTP process only. Worker startup requires already-applied migrations.

## Configuration and secrets

For direct Node execution, provide either:

- `DATABASE_URL` or `DATABASE_URL_FILE` (`mysql://` or `mariadb://`, URL-encode credentials); or
- `DATABASE_HOST`, optional `DATABASE_PORT` (3306), `DATABASE_NAME` (dnsmonitor), `DATABASE_USER` (dnsmonitor), and `DATABASE_PASSWORD` or `DATABASE_PASSWORD_FILE`.

Do not set a secret and its `_FILE` counterpart together. Compose uses separate credential fields so passwords do not need URL encoding. For manual migrations or local worker execution after `pnpm build`:

```sh
pnpm db migrate
pnpm db add examples/watch.json
pnpm worker
```

The Compose database is intentionally not host-accessible. Use its container CLI commands above or provide an independently accessible development database for local Node execution. The runtime also requires ENCRYPTION_KEY or ENCRYPTION_KEY_FILE for notification delivery. Optional worker settings: `WORKER_ID` (unique across processes), `WORKER_CONCURRENCY`, and `HEALTH_PORT`.

## Integration tests

These tests delete data in the configured test database. They require an explicit URL whose database name ends in `_test`. Never point them at application data.

```sh
docker compose -f deploy/compose.test.yaml up -d --wait
INTEGRATION_DATABASE_URL=mysql://dnsmonitor_test:test-only-password@127.0.0.1:13306/dnsmonitor_test pnpm test:integration
docker compose -f deploy/compose.test.yaml down
```

The test database uses tmpfs and a localhost-only port (13306). Tests cover migration serialization, duplicate-free claiming, 25-monitor batches, expiring leases, pause/revision fencing, transactional outbox rollback, both modes through a local DNS server, process death, and graceful shutdown. The crash test explicitly advances its lease expiration to keep runtime short. It validates the expiration path without waiting for the entire production lease duration.

## Current limitations

SMTP/webhook delivery and the authenticated API are implemented; see [API operation](API.md). The browser UI is served by the API. Automatic history retention and hourly aggregation run inside each worker role with a shared database schedule; see [retention operation](RETENTION.md). Swarm and Kubernetes deployment definitions are available in the [deployment guide](DEPLOYMENT.md); resource benchmarks remain on the implementation plan. Do not expose a database service as an application interface.

## Orchestrator startup

`RUN_MIGRATIONS=true` opts the API/combined/worker entrypoint into waiting for MariaDB and running serialized migrations before startup (used by Swarm). It defaults off. Kubernetes uses `node dist/apps/cli/src/bootstrap.js migrate` in a Job and `bootstrap.js wait` in init containers instead. `BOOTSTRAP_TIMEOUT_SECONDS` defaults to 300 and accepts 1–3600. Migration errors fail startup rather than starting against a partial schema.
