# Operational health and metrics

Open **System health** in the main navigation. The authenticated page shows live/expired worker heartbeats, overdue work, recent scheduling delay and DNS timeouts, notification queues, approximate database size and retention progress. Failed refreshes retain the last snapshot with an explicit stale status. A snapshot more than 30 seconds old also loses its healthy indicator.

`GET /api/v1/operations` exposes the same data to signed-in users, including viewers. No new database migration or extra service is required.

## Definitions and cost

- Online workers have status ONLINE and a heartbeat newer than 15 seconds. Expired ONLINE entries may be historical crashed/replaced workers; they do not imply that currently online replacements are unhealthy. STOPPED workers do not count as expired.
- Overdue monitors are enabled, eligible to be claimed, and more than 30 seconds past due. A still-valid active lease is excluded. Oldest-due age uses the same eligibility rule without the 30-second grace.
- Recent statistics cover ended checks in the last 15 minutes, capped at the latest 1,000. The truncation flag is explicit. SQL returns resolver status strings, never DNS answer payloads. Timeout ratio uses resolver results as its denominator. No observations means an absent Prometheus ratio and “No samples” in the UI, rather than an invented zero.
- Scheduling delay is start time minus scheduled time, clamped at zero. Percentiles use the nearest-rank method on the bounded sample. ERROR runs are counted separately; an ordinary DNS timeout is a completed check with a timeout result.
- Notification routing, pending, processing and failed counts reflect currently retained database rows. Failed delivery counts can include older unresolved failures.
- Retention is late when it has never completed or its last completion is older than the greater of 180 seconds or three configured cleanup intervals. Disabled retention is shown explicitly.
- Storage counts allocated table/index bytes approximately, excluding system files, redo logs and other database disk usage.

The API and exporter share a ten-second cache per process, including concurrent requests. Payload reads are limited; queue and monitor counts use SQL aggregates. No collector runs in the background when nobody requests the page or metrics. A failed collection returns an error once the cached snapshot expires. Database downtime must not appear as zero pending work or healthy monitoring.

## Private Prometheus endpoint

API/combined runtimes start a separate listener at **127.0.0.1:3002/metrics** by default. Worker-only runtimes do not export duplicate installation-wide metrics. Port 3002 is not published by Compose/Swarm or exposed by a Helm Service/Ingress. `/metrics` is not a route on the web server.

```sh
# Inspect from inside the existing combined Compose app container.
docker compose exec worker node -e \
  "fetch('http://127.0.0.1:3002/metrics').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())})"
```

`METRICS_ENABLED=false` disables the listener; `METRICS_HOST` changes its bind address. The application also accepts `METRICS_PORT` (default 3002) when set directly in its runtime environment. Compose and Swarm expose the enable/host settings; Helm uses `metrics.enabled` and `metrics.host`.

For an existing trusted scraper on the container/pod network, explicitly set the host to `0.0.0.0` and target the API container/pod at port 3002. Restrict access with your network controls. The exporter has no application-session or token authentication, so do not publish it through the public ingress. A scraper in the same pod network namespace can use the loopback default. No Prometheus installation, ServiceMonitor or ingress rule is created automatically.

Example scrape configuration for one reachable, trusted API target:

```yaml
scrape_configs:
  - job_name: dnsmonitor
    scrape_interval: 30s
    static_configs:
      - targets: ['dnsmonitor-api.internal:3002']
```

The endpoint uses the [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/). Values are **gauges**, including rolling-window counts; do not apply `rate()` to them. Replica exports reflect the same shared database, so do not sum them across API replicas. Scrape one target or deduplicate by installation. No monitor names, DNS names, worker IDs, destination URLs or secrets appear as metric labels.

The `dnsmonitor_` families cover `workers_online`, `workers_stale`, `monitors_enabled`, `monitors_overdue`, `scheduler_oldest_due_seconds`, `scheduler_delay_p95_seconds`, `scheduler_delay_max_seconds`, `notifications_{routing,pending,processing,failed}`, `recent_{checks,sample_truncated,check_errors,dns_queries,dns_timeouts,dns_timeout_ratio}`, `database_approximate_bytes`, `retention_{enabled,late,last_completed_timestamp_seconds}`, and `snapshot_timestamp_seconds`.

Example conditions to adapt to your installation: overdue monitors for five minutes, enabled monitors with no online workers, failed deliveries, or sustained timeout ratio above your tolerance when sampled DNS queries are nonzero. Monitor Prometheus's own `up` value too: the endpoint responds 503 if data collection fails. The UI displays operational status; this increment does not itself send alerts about these system conditions.
