#!/usr/bin/env bash
# Prepare a local release bundle. Does not publish images, tags or releases.
set -euo pipefail
node scripts/release/check.mjs
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')"
output="${1:-dist/release}"
mkdir -p "$output"
helm lint deploy/helm/dnsmonitor
helm package deploy/helm/dnsmonitor --destination "$output"
cp LICENSE "$output/LICENSE"
cp CHANGELOG.md "$output/CHANGELOG.md"
python3 - "$output/compose.yaml" <<'PYCOMPOSE'
import pathlib,sys
text=pathlib.Path('compose.yaml').read_text().replace('    build: .\n','').replace('image: dnsmonitor:local','image: ${DNSMONITOR_IMAGE:?Set DNSMONITOR_IMAGE to the published version or digest}')
pathlib.Path(sys.argv[1]).write_text(text)
PYCOMPOSE
cp .env.example "$output/env.example"
# Chart images are supplied at installation; no registry is invented here.
tar -czf "$output/dnsmonitor-deploy-${version}.tgz" LICENSE deploy/swarm docs
python3 - "$output" "$version" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]); names=['LICENSE','CHANGELOG.md','compose.yaml','env.example',f'dnsmonitor-{sys.argv[2]}.tgz',f'dnsmonitor-deploy-{sys.argv[2]}.tgz']
(root/'SHA256SUMS').write_text(''.join(hashlib.sha256((root/name).read_bytes()).hexdigest()+'  '+name+'\n' for name in names))
PY
