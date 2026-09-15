#!/usr/bin/env bash
# Run from the repository root. Uses only the dnsmonitor-validation Compose project.
set -euo pipefail
seconds="${1:-660}"
output="${2:-test-results/validation}"
if [[ ! "$seconds" =~ ^[0-9]+$ ]] || (( seconds < 600 )); then
  echo 'The measurement must last at least 600 seconds' >&2; exit 1
fi
docker info >/dev/null
if docker volume inspect dnsmonitor-validation_database >/dev/null 2>&1 || \
   docker volume inspect dnsmonitor-validation_restored_database >/dev/null 2>&1 || \
   [[ -n "$(docker ps -aq --filter label=com.docker.compose.project=dnsmonitor-validation)" ]]; then
  echo 'A validation stack already exists. Inspect it and remove it explicitly before rerunning.' >&2
  exit 1
fi
mkdir -p "$output"
docker build -t dnsmonitor:validation .
cleanup() {
  docker compose -p dnsmonitor-validation -f deploy/compose.validation.yaml logs --no-color > "$output/containers.log" 2>&1 || true
  docker compose -p dnsmonitor-validation -f deploy/compose.validation.yaml -f deploy/compose.validation-restore.yaml down -v
  docker compose -p dnsmonitor-validation -f deploy/compose.validation.yaml down -v
}
trap cleanup EXIT
docker compose -p dnsmonitor-validation -f deploy/compose.validation.yaml up -d --wait
docker compose -p dnsmonitor-validation -f deploy/compose.validation.yaml exec -T app node scripts/validation/probe.mjs seed
python3 scripts/validation/measure.py --seconds "$seconds" --output "$output/measurement.json"
python3 scripts/validation/recover.py --output "$output/recovery.json"
