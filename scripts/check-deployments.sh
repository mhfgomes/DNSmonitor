#!/usr/bin/env bash
set -euo pipefail
helm lint deploy/helm/dnsmonitor
for mode in combined split; do
  helm template validation deploy/helm/dnsmonitor --set mode="$mode" > /dev/null
  helm template validation deploy/helm/dnsmonitor --set mode="$mode" \
    --set database.bundled=false --set database.host=db.internal \
    --set ingress.enabled=true --set ingress.host=dns.example.com > /dev/null
done
helm template validation deploy/helm/dnsmonitor --set networkPolicy.enabled=true \
  --set database.storage.existingClaim=existing-database > /dev/null
helm template validation deploy/helm/dnsmonitor --set database.storage.storageClass=- > /dev/null
for invalid in mode=invalid app.replicas=0 worker.concurrency=0 database.bundled=false database.port=3307 migration.timeoutSeconds=0 ingress.enabled=true; do
  if helm template validation deploy/helm/dnsmonitor --set "$invalid" > /dev/null 2>&1; then
    echo "Unexpectedly accepted invalid values: $invalid" >&2
    exit 1
  fi
done
DNSMONITOR_IMAGE=dnsmonitor:validation docker stack config -c deploy/swarm/stack.yaml > /dev/null
DNSMONITOR_IMAGE=dnsmonitor:validation APP_ROLE=api WORKER_REPLICAS=2 \
  docker stack config -c deploy/swarm/stack.yaml > /dev/null
docker compose -f deploy/compose.validation.yaml -f deploy/compose.validation-restore.yaml config --quiet
DNSMONITOR_IMAGE=dnsmonitor:validation docker stack config -c deploy/swarm/stack.yaml -c deploy/swarm/setup.yaml > /dev/null
echo 'Deployment template checks passed'
