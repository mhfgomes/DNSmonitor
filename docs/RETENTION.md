# History retention

Cleanup runs in the existing `all` or `worker` process. No additional container, queue or scheduler is required. Migration 5 adds hourly summaries, a shared cleanup schedule and retention indexes. Existing checks are processed gradually after upgrading; existing monitor state and baselines remain intact.

## Default policy

| Data | Retained for | Setting |
| --- | --- | --- |
| Detailed completed, errored and abandoned checks | 24 hours after completion | `RETENTION_CHECK_HOURS=24` |
| Hourly check summaries | 90 days | `RETENTION_SUMMARY_DAYS=90` |
| DNS events | 30 days, longer while dependencies remain | `RETENTION_EVENT_DAYS=30` |
| Resolved incidents | 90 days after resolution, longer while events reference them | `RETENTION_INCIDENT_DAYS=90` |
| Terminal notification deliveries and routed/ignored/cancelled jobs | 30 days | `RETENTION_DELIVERY_DAYS=30` |
| Audit events | 90 days | `RETENTION_AUDIT_DAYS=90` |
| Expired sessions and login limits | Eligible immediately after expiry | Fixed |
| Worker heartbeats | 7 days without a heartbeat | Fixed |

Set these in `.env` and recreate the app using `docker compose up -d --wait`. Compose and the scaled override pass the settings through. All API/worker replicas must use the same policy. `RETENTION_ENABLED=false` suspends cleanup. Durations must be positive integers, with summary retention longer than check retention. Extending retention cannot restore previously deleted data.

Each pass removes at most `RETENTION_BATCH_SIZE=250` rows **per table** (maximum 1000). The shared schedule defaults to `RETENTION_INTERVAL_SECONDS=60` (range 1–3600). A backlog can take several passes to clear; retention is a minimum age for eligibility, not an exact deletion deadline. Reduce batch size to shorten transactions on constrained installations.

## Hourly summaries

Each expired check is assigned to its UTC start hour and configuration revision. Rollup increments and deletion of the original checks commit together, preventing double counting after a crash or retry. Workers coordinate through a locked maintenance row, so only one performs a scheduled cleanup pass.

Summaries record total checks, completed checks, evaluated healthy/warning/critical/unknown observations, infrastructure errors, abandoned executions, and sum/count/maximum latency of successful resolver responses. Mean latency is weighted by successful resolver responses; timeouts are not included. Health counts are sampled observations, **not time-based uptime percentages**. Checks whose old observation JSON lacks an evaluated status are counted as unknown, rather than re-evaluated using current configuration.

Monitor details show **Archived hourly history**, with pagination. Recent raw checks are not included in the archive, and the newest archived hour can fill incrementally as more checks become eligible. Very old backlog outside the summary window is removed without creating already-expired summaries. No DNS answer payloads or secrets are copied into hourly summaries.

## Protected records and notification history

Running checks remain the scheduler's responsibility. Open and acknowledged incidents are retained, along with their associated events. Pending jobs and pending/processing deliveries are never removed by retention. Events survive while notification jobs reference them; resolved incidents survive while events or active monitor state reference them. Deleting raw checks clears the event's optional check reference while preserving the event payload.

Terminal deliveries are SENT, FAILED or CANCELLED. Age is measured from `sent_at`, or the last `next_attempt_at` for unsent terminal records. Failed delivery entries can be retried only while retained. Jobs must be routed/ignored/cancelled, old enough and have no remaining deliveries before deletion. This dependency order can retain some records beyond the configured durations.

## Operations and storage

Authenticated endpoints:

- `GET /api/v1/monitors/:id/hourly?limit=50&offset=0`: bounded archived summary pages (limit 1–100).
- `GET /api/v1/retention`: configured policy, last completed cleanup, next eligible run, per-table deletion counts, and estimated database table/index sizes.

Worker logs emit `retention_completed` counts and `retention_error` codes. On failure, the transaction rolls back and the next loop retries. Check `last_completed_at` to detect stalled maintenance; an API-only deployment needs at least one worker for cleanup.

MariaDB table and index sizes are approximate allocated sizes. Deletion makes pages reusable, but does not necessarily shrink database files or immediately reduce reported disk usage. Automatic table optimization is deliberately excluded because it can require large temporary space and disruptive locks. Resource benchmarks and operational alerting remain separate release work.
