# API and notification setup

The application now runs an authenticated REST API, DNS worker, and notification dispatcher in one process by default. Compose publishes the API at `http://localhost:3000` on loopback only. The same address serves the React interface, with login, monitor management, incidents, and notification settings.

## Initial setup

Keep the existing `.env` and database volume. Add `ENCRYPTION_KEY` if this is an upgrade from the DNS-only worker. Generate it once with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save that value as `ENCRYPTION_KEY` in `.env`, then run `docker compose up --build -d --wait`. Back up the key together with database backups: changing or losing it makes existing channel configurations and queued delivery snapshots unreadable. Mounted `ENCRYPTION_KEY_FILE` is also supported outside the default Compose file. The key is never stored in the database.

Provision an admin account from the CLI. There is no public registration/bootstrap endpoint. The following prompts silently for the password without placing its value in the command line:

```sh
read -rs ADMIN_PASSWORD
export ADMIN_PASSWORD
docker compose exec -e ADMIN_PASSWORD worker node dist/apps/cli/src/database.js admin you@example.com
unset ADMIN_PASSWORD
```

Use at least 12 characters (maximum 256). Alternatively provide `ADMIN_PASSWORD_FILE` pointing to a readable mounted secret. Running `admin` again for the same email resets its password and revokes all sessions. Passwords use Argon2id (19 MiB, two passes, one lane); concurrent verification is capped at two per API process.

## Authentication

`POST /api/v1/auth/login` accepts JSON:

```json
{ "email": "you@example.com", "password": "your-password" }
```

It sets the `dnsmonitor_session` HttpOnly, SameSite=Strict cookie and returns `{email, role, csrfToken}`. Include the cookie on subsequent requests and send `X-CSRF-Token` on all mutations, including logout. `GET /api/v1/auth/session` returns the current identity and CSRF token. `POST /api/v1/auth/logout` revokes the current session.

Sessions expire after 12 hours and are shared across replicas through MariaDB; only their token hashes are stored. Login attempts are limited for 15 minutes by both email (10) and connecting IP (30), shared across replicas. Forwarded client IP headers are deliberately not trusted. Behind a proxy, all traffic from that proxy shares the IP limit until explicit trusted-proxy configuration is implemented.

The runtime defaults to Secure cookies. Compose explicitly sets `COOKIE_SECURE=false` for local HTTP. For HTTPS deployment set `COOKIE_SECURE=true`, configure `PUBLIC_URL` to the exact public origin, and expose the application through the reverse proxy. Requests with another Origin are rejected; CORS is not enabled. Only admins can mutate resources, except that any signed-in user may log out. The current provisioning command creates admins; user/role management is future work.

## Resource endpoints

| Method and path | Behaviour |
|---|---|
| `GET /api/v1/monitors` | List monitors; `limit` 1–100 and `offset` 0–100000 |
| `POST /api/v1/monitors` | Create using the same shape as `examples/watch.json` / `examples/expected.json` |
| `GET /api/v1/monitors/:id` | Configuration, state, latest 20 checks/events/incidents |
| `PATCH /api/v1/monitors/:id` | Update per-monitor timing and thresholds |
| `POST /api/v1/monitors/:id/check` | Request an immediate check |
| `POST /api/v1/monitors/:id/pause` | Pause and invalidate active execution |
| `POST /api/v1/monitors/:id/resume` | Resume with a fresh check |
| `GET /api/v1/incidents` | Paginated incident history |
| `POST /api/v1/incidents/:id/acknowledge` | Acknowledge an open incident; monitoring/recovery continue |
| `GET, POST /api/v1/notification-channels` | List channel metadata or create an encrypted channel |
| `PATCH /api/v1/notification-channels/:id` | Set `{enabled: true/false}` |
| `POST /api/v1/notification-channels/:id/test` | Immediately send a test message to an enabled channel |
| `GET, POST /api/v1/alert-rules` | List/create rules |
| `PATCH /api/v1/alert-rules/:id` | Set `{enabled: true/false}` |
| `GET /api/v1/notification-deliveries` | Paginated delivery status, attempts and sanitized errors |
| `POST /api/v1/notification-deliveries/:id/retry` | Requeue a FAILED delivery on an enabled channel |

All mutation endpoints require the session cookie and CSRF token. UUID parameters and payloads are validated. API errors omit database SQL and secrets. Channel/rule lists currently cap at 1000 entries. Monitor details and incident values return parsed JSON. `GET /api/v1/dashboard` returns monitor-state totals, online workers, and recent events. Monitor listing supports `search` and `mode` filters with a total count. Check observations include the evaluated monitor status; older checks may omit it.

Timing PATCH example:

```json
{ "intervalSeconds": 300, "timeoutMs": 3000, "failureThreshold": 3, "recoveryThreshold": 2, "changeThreshold": 2 }
```

Omitted fields are preserved. Updates invalidate in-flight checks and reset confirmation streaks while preserving WATCH baselines and open incidents. Paused monitors stay paused. Use the full PUT endpoint below for DNS target, mode, expected-set and resolver changes, and DELETE for confirmed deletion. Shared resolver-group editing remains future work.

## Channels and rules

Create a webhook channel:

```json
{
  "name": "Operations webhook",
  "config": {
    "type": "WEBHOOK",
    "url": "https://receiver.example.com/dns-alerts",
    "signingSecret": "replace-with-a-long-shared-secret"
  }
}
```

The signing secret is optional (16–256 characters). The receiver gets JSON and a stable delivery UUID in `Idempotency-Key` and `X-DNSMonitor-Delivery`. `X-DNSMonitor-Signature` is `sha256=` followed by the hex HMAC-SHA256 of the exact request body. Redirects are not followed. HTTP and HTTPS are supported to allow private self-hosted receivers; only admins configure destinations.

Create an SMTP channel:

```json
{
  "name": "Operations email",
  "config": {
    "type": "SMTP",
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "requireTLS": true,
    "username": "dnsmonitor@example.com",
    "password": "smtp-password",
    "from": "dnsmonitor@example.com",
    "to": ["ops@example.com"]
  }
}
```

`secure=true` uses TLS immediately (usually port 465); otherwise `requireTLS=true` requires STARTTLS. Certificate validation remains enabled. Username/password may both be omitted for a trusted local relay. Up to ten recipients are supported. Email currently contains a generic subject and the JSON event as plain text. Channel list responses never return credentials, URLs, recipients, or encrypted configuration.

Then create an alert rule using the channel UUID:

```json
{
  "name": "Production DNS alerts",
  "config": {
    "eventTypes": ["VALUE_CHANGED", "INCIDENT_OPENED", "INCIDENT_RESOLVED"],
    "channelIds": ["replace-with-channel-uuid"],
    "monitorIds": []
  }
}
```

An empty/omitted `monitorIds` matches all monitors. Baseline establishment is informational and is never sent. Overlapping rules generate one delivery per event/channel. Rules and channels apply to events timestamped at or after their creation; historical outbox events are not intentionally replayed. Events without a matching rule/channel become IGNORED.

Outbox routing and creation of channel deliveries happen in one transaction. Each delivery snapshots the encrypted channel configuration. Network I/O happens outside database transactions, with a ten-second deadline and a 45-second execution lease. Retries follow 30 seconds, 2 minutes, 10 minutes, and 30 minutes, stopping after five attempts (including claims interrupted by a crash). A failed delivery may be manually retried with the same delivery ID. Delivery is at least once: a provider may receive duplicates after an ambiguous network failure or partial SMTP recipient acceptance. Receivers should deduplicate by delivery ID.

Disabling a channel cancels pending/claimed deliveries; an already-transmitted request cannot be recalled. Re-enabling does not replay cancelled deliveries. Disabling a rule stops future routing, but does not cancel deliveries already created by that rule. There is no automatic reminder/escalation or maintenance suppression yet.

## Runtime roles

- `RUNTIME_ROLE=all` (default): API + DNS scheduler + notification dispatcher, one process.
- `RUNTIME_ROLE=api`: API only, suitable for a separate frontend/API service.
- `RUNTIME_ROLE=worker`: DNS + notifications, with private health endpoints on port 3001.

For a separate API process and multiple workers:

```sh
docker compose -f compose.yaml -f deploy/compose.scaled.yaml up -d --scale dns-worker=2 --wait
```

The existing service name `worker` is retained for CLI compatibility; in the default Compose file it runs the combined application. Do not scale that service directly because it publishes the API port. To return to the minimal deployment:

```sh
docker compose -f compose.yaml -f deploy/compose.scaled.yaml stop dns-worker
docker compose up -d --remove-orphans --wait
```

An API-only readiness check verifies database connectivity; combined readiness additionally requires a fresh DNS worker heartbeat. Delivery problems are visible through the delivery status endpoint. Auth cleanup removes expired session/rate-limit rows in bounded batches. Check/event history retention and resource benchmarks remain future work.

## Archived history and cleanup

`GET /api/v1/monitors/:id/hourly` returns paginated hourly summaries of expired detailed checks. `GET /api/v1/retention` returns the policy, last cleanup result, and approximate storage sizes. Both require a session. See [retention semantics and settings](RETENTION.md).

## Full monitor management

Monitor details include `configRevision` and resolver settings. Use `PUT /api/v1/monitors/:id` with a full monitor input and `revision` for editing; use `DELETE /api/v1/monitors/:id` with `revision` and `confirmName` for permanent deletion. Both require admin authorization and CSRF. Stale revisions return 409. See [state resets, incident closure, and deletion effects](MONITOR-MANAGEMENT.md).

## Operational health

`GET /api/v1/operations` returns the authenticated installation snapshot used by System health. It shares a ten-second cache with the separate private metrics listener. See [definitions, limits and scraping](OPERATIONS.md). `/metrics` is not exposed on the public API/web listener.

## Browser accounts

First-admin setup and self-service password changes are available in the UI. See [account setup](ACCOUNTS.md) for token configuration, routes, concurrent setup behavior and session revocation. The CLI remains available for operator recovery.

## Version metadata

`GET /api/v1/version` requires authentication and returns `{ "version": "0.1.0", "revision": "unknown" }` for a local build. Published builds report the source commit. See [release operations](RELEASE.md).
