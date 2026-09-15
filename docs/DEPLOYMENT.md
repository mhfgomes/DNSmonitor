# Docker Swarm and Kubernetes

The default is one combined API/worker plus MariaDB. Split mode runs separate API and worker processes using the same image, database leases and notification queue. Redis is not required. Docker Compose remains the simplest single-host option; see the root README.

## Image and credentials

Build and publish an immutable tag to a registry accessible to every node (publishing is an operator step):

```sh
docker build -t mhfgomes/dnsmonitor:0.1.0 .
docker push mhfgomes/dnsmonitor:0.1.0
```

Build for your nodes' architecture; use a multi-platform build for mixed ARM64/AMD64 nodes. Prefer an image digest for releases. Create secret files in a private directory outside the repository:

```sh
umask 077
mkdir -p "$HOME/.config/dnsmonitor-secrets"
openssl rand -hex 32 > "$HOME/.config/dnsmonitor-secrets/database-password"
openssl rand -hex 32 > "$HOME/.config/dnsmonitor-secrets/database-root-password"
openssl rand -hex 32 > "$HOME/.config/dnsmonitor-secrets/encryption-key"
```

Run this once for a NEW installation. For an existing database, supply its existing database password and encryption key. Replacing the encryption key makes existing notification credentials unreadable. Back it up separately from database dumps. Secrets must never be checked into Git or embedded in Helm values. Kubernetes Secret access should be restricted with cluster RBAC and encryption at rest.

## Swarm

Use an existing Swarm manager, or initialize Swarm on the intended deployment host with `docker swarm init`. Exactly one node should carry the database label below: the supplied volume uses that node's local disk and does not follow a rescheduled database to another machine.

```sh
docker node update --label-add dnsmonitor.database=true DATABASE_NODE_NAME
docker secret create dnsmonitor_database_password "$HOME/.config/dnsmonitor-secrets/database-password"
docker secret create dnsmonitor_database_root_password "$HOME/.config/dnsmonitor-secrets/database-root-password"
docker secret create dnsmonitor_encryption_key "$HOME/.config/dnsmonitor-secrets/encryption-key"
export DNSMONITOR_IMAGE=mhfgomes/dnsmonitor:0.1.0
export PUBLIC_URL=https://dns.example.com
export COOKIE_SECURE=true
docker stack config -c deploy/swarm/stack.yaml
docker stack deploy --with-registry-auth -c deploy/swarm/stack.yaml dnsmonitor
docker stack services dnsmonitor
docker service logs dnsmonitor_app
```

Stack deploy does not automatically load Compose's `.env`. Export the documented variables explicitly. The application publishes port 3000 through Swarm's routing mesh, on all nodes; restrict access at the firewall and put your HTTPS reverse proxy in front. Set `APP_PORT` to change the published port. The database is only attached to the internal backend network. App/worker also have an egress network for resolver and notification access.

To split the runtime, export `APP_ROLE=api`, `APP_REPLICAS=1`, and `WORKER_REPLICAS=1` before redeploying. Keep at least one worker when the app role is `api`; otherwise checks and notifications stop. Increase replicas only with sufficient database connections and memory. Set these variables on every subsequent deployment, because omitted variables return to their defaults.

Each process waits for database connectivity, then runs serialized migrations before starting. A database advisory lock prevents concurrent migrations. Startup has a five-minute dependency wait; migration failures stop the process and appear in logs. Updates pause on failure, with one new replica at a time; automatic schema rollback is deliberately absent. Start-first updates need capacity for one extra process.

Secrets are external, immutable Swarm objects. To rotate a database password, coordinate the database account change, create a new versioned secret, then set `DATABASE_PASSWORD_SECRET` and redeploy. Changing a secret alone does not change the password stored in an existing database. Do not rotate the encryption key without a credential re-encryption procedure.

## Kubernetes / Helm

Requires Kubernetes 1.27+, Helm 3, and a suitable default StorageClass or an existing ReadWriteOnce PVC. The chart includes no ingress controller or external database operator.

```sh
kubectl create namespace dnsmonitor
kubectl -n dnsmonitor create secret generic dnsmonitor-secrets \
  --from-file=database-password="$HOME/.config/dnsmonitor-secrets/database-password" \
  --from-file=database-root-password="$HOME/.config/dnsmonitor-secrets/database-root-password" \
  --from-file=encryption-key="$HOME/.config/dnsmonitor-secrets/encryption-key"
helm upgrade --install dnsmonitor deploy/helm/dnsmonitor --namespace dnsmonitor \
  --set image.repository=mhfgomes/dnsmonitor --set image.tag=0.1.0 \
  --wait --wait-for-jobs --timeout 10m
kubectl -n dnsmonitor port-forward service/dnsmonitor-dnsmonitor 3000:3000
```

The default URL and cookie setting support this localhost port-forward. For a public installation, put the following in a values file and supply `-f your-values.yaml` on each upgrade:

```yaml
publicUrl: https://dns.example.com
cookieSecure: true
image:
  repository: mhfgomes/dnsmonitor
  tag: 0.1.0
mode: combined
ingress:
  enabled: true
  className: nginx
  host: dns.example.com
  tls:
    - hosts: [dns.example.com]
      secretName: dnsmonitor-tls
```

Provision that TLS Secret and ingress controller separately. `image.digest` overrides the tag; `imagePullSecrets` supports private registries. To split, set `mode: split` and `worker.replicas: 1` or more. `app.replicas` scales HTTP instances. Configure all retention values under `retention` and DNS concurrency under `worker.concurrency`.

For an external MariaDB, set `database.bundled: false`, `database.host`, `database.port`, `database.name`, and `database.user`. Pre-create the database and grant that user migration permissions on it. The existing Secret then only needs `database-password` and `encryption-key`. The chart does not configure external-database TLS; use a trusted private network until database TLS configuration is added.

Bundled storage defaults to 2Gi with the cluster's default StorageClass. Set `database.storage.storageClass`, or `database.storage.existingClaim` to reuse a PVC in the same namespace. `storageClass: "-"` requests no class. Storage changes can require a separate PVC expansion/migration; Helm cannot freely change StatefulSet claim templates. PVCs created by the StatefulSet are retained on uninstall. An existing claim is never managed by the chart.

A release-specific, regular migration Job runs after resources are created. This allows MariaDB to start on a first install. App init containers wait for the expected schema; no Kubernetes API credentials or migration-status RBAC is required. Always use `--wait --wait-for-jobs`. Inspect failures with:

```sh
kubectl -n dnsmonitor get pods,jobs,pvc
kubectl -n dnsmonitor logs job/dnsmonitor-dnsmonitor-migrate-1
kubectl -n dnsmonitor logs deployment/dnsmonitor-dnsmonitor-app -c wait-schema
```

Replace the Job revision suffix after an upgrade. Completed Jobs expire after 24 hours. The app runs as UID 1000 with a read-only filesystem and no Linux capabilities. Only database credentials and the encryption key are mounted in app pods; the root database password is confined to MariaDB. MariaDB secret files are readable inside its pod to support its entrypoint dropping privileges.

`networkPolicy.enabled: true` restricts bundled database ingress to this release's app, worker and migration pods, when the cluster CNI enforces NetworkPolicy. Resolver/notification egress stays open: allow UDP and TCP to each configured resolver, and HTTP/SMTP destinations. Private resolvers must be reachable from the worker nodes/pods. Worker health ports have no public Service.

## First administrator

For browser setup, configure an installation token as described in [account setup](ACCOUNTS.md). Existing accounts use **Account** for password changes. The CLI procedure below remains available for operator recovery.

Use a private password file with at least 12 characters. The following reads the password through stdin, not command arguments. Run against the app container on Swarm (use its container ID on the node running it), or the app Deployment on Kubernetes:

```sh
kubectl -n dnsmonitor exec -i deployment/dnsmonitor-dnsmonitor-app -c app -- \
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { databasePool } from "./dist/packages/database/src/connection.js";
    import { Auth } from "./dist/packages/auth/src/index.js";
    const pool = databasePool();
    try { await new Auth(pool).setAdmin(process.argv[1], readFileSync(0, "utf8").trim()); }
    finally { await pool.end(); }
  ' admin@example.com < /path/to/private/admin-password
```

For Swarm substitute `docker exec -i APP_CONTAINER_ID` for the kubectl exec prefix. This command can reset an existing administrator's password; use it intentionally.

## Backups, upgrades and resources

Before an upgrade, save a consistent database dump and the matching encryption key. For bundled Kubernetes MariaDB:

```sh
umask 077
kubectl -n dnsmonitor exec dnsmonitor-dnsmonitor-db-0 -- sh -c \
  'export MYSQL_PWD="$(cat /run/secrets/database-root-password)"; exec mariadb-dump --user=root --single-transaction --routines --events "$MARIADB_DATABASE"' \
  > dnsmonitor-backup.sql
```

For Swarm use `docker exec DATABASE_CONTAINER_ID` with the same shell command on the database node. Check the exit status and protect the dump: it contains account hashes and monitoring configuration. Test restore into a separate empty database, using the same encryption key and compatible application image. Keep its workers stopped until ready to resume monitoring; do not connect test restores to real notification destinations. Take filesystem/PVC snapshots only with database-consistent tooling.

Upgrade with the new immutable image and the same values/secrets. Migrations must remain compatible with old processes during a rolling update. Neither orchestrator reverses database migrations. If the new binary changes schema incompatibly, stop application processes and use a planned maintenance upgrade. Roll back an image only after checking schema compatibility, or restore the pre-upgrade database and matching key into a separate recovery installation.

The default reservations/requests are 96MiB per app process and 128MiB for MariaDB, with 512MiB limits each. These are initial settings, **not measured minimum hardware requirements**. Allow additional memory for migrations, rolling replacements and the orchestrator. Every runtime uses up to four database connections; bootstrap uses one more temporarily. The bundled database allows 30 connections, so account for app + worker replicas, rollout surge, migrations and administrative sessions before scaling. Replica count does not provide database high availability.

The first 25-monitor, five-minute Compose baseline and restart/backup/restore drill passed with a 448 MiB app/database container budget; see [validation evidence](VALIDATION.md). Longer soaks and Kubernetes/Swarm measurements remain release gates and must include orchestrator overhead.

## Validation performed

On 2026-09-11, the image was built locally and validated with 12 passing unit tests and 32 passing MariaDB integration tests, including orchestrator bootstrap. `scripts/check-deployments.sh` checks combined/split templates, external database, existing PVC, ingress, NetworkPolicy and invalid configuration; CI runs it with Helm 3.19.

A disposable kind cluster passed a fresh Helm installation, migration completion, an upgrade to one API plus two workers, HTTP readiness, live three-resolver DNS execution, and database pod replacement with persistent monitor/history data and resumed checks. Kubernetes also accepted server-side dry runs including ingress and NetworkPolicy. These checks do not validate a particular ingress controller, CNI enforcement, external database service or multi-node storage driver.

A disposable Docker-in-Docker Swarm passed fresh combined startup, serialized migrations, HTTP readiness through the published port, and transition to one API plus two healthy workers. The host Docker daemon was not converted to Swarm. Multi-node scheduling, network partitions and target-specific restore/resource validation remain release work. A later Compose logical backup restoration and resource baseline are documented in [validation evidence](VALIDATION.md).

## Operational metrics

The API/combined runtime includes an unexposed loopback listener on port 3002. Compose/Swarm use `METRICS_ENABLED` and `METRICS_HOST`; Helm uses `metrics.enabled` and `metrics.host`. Nothing publishes the port or adds a metrics Ingress/Service by default. See [scraping and metric semantics](OPERATIONS.md) before enabling access for a trusted scraper.
