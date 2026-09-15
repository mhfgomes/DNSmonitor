# Changelog

## 0.1.0 — release candidate, not yet published

First release of DNSmonitor, a shared, self-hosted DNS monitoring application.

- WATCH and EXPECTED monitoring for A, AAAA, CNAME, MX and TXT records, with resolver quorum and UDP-to-TCP fallback.
- Per-monitor scheduling, timeout and failure/recovery/change confirmation settings.
- Persistent worker leases, incident history, SMTP and signed webhook alerts with retries.
- Responsive light/dark interface, full monitor editing, first-admin setup and account password changes.
- Bounded retention, hourly history, operational health and private Prometheus metrics.
- Docker Compose, Swarm and Kubernetes Helm deployments, with combined or separate API/worker roles.
- Account-page version information and authenticated `/api/v1/version` metadata.

Validation so far includes a 25-monitor, five-minute baseline under a 448 MiB app/database container budget, Compose recovery/restore drills, and initial Swarm/Kubernetes deployment smoke checks. The budget excludes host/orchestrator overhead. A 24-hour soak and deployment-specific recovery/restore drills remain outstanding; see docs/VALIDATION.md.
