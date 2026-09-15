# Preparing and publishing v0.1.0

The release files are prepared locally. Creating this workflow or building a bundle does not publish anything. The repository currently needs a GitHub remote and a committed version tag before the publishing workflow can run.

## Local preparation

Requires Node 24, pnpm 11.24, Helm 3 and Python 3:

```sh
pnpm install --frozen-lockfile
pnpm check
scripts/check-deployments.sh
scripts/release/package.sh
```

The bundle is written to `dist/release`: `dnsmonitor-0.1.0.tgz` (Helm), `dnsmonitor-deploy-0.1.0.tgz` (Swarm and documentation), a Compose file that uses `DNSMONITOR_IMAGE` instead of building source, an environment example, changelog and SHA256SUMS. No credentials or `.env` are packaged. Verify checksums with `sha256sum -c SHA256SUMS` (or `shasum -a 256 -c SHA256SUMS` on macOS).

Version `0.1.0` is recorded in package.json, the Helm chart and the OCI image label. `scripts/release/check.mjs` prevents these from drifting and validates a supplied RELEASE_TAG. On the Account page the app displays its version and, for release builds, abbreviated source revision. `GET /api/v1/version` returns `{version,revision}` to authenticated clients. Local images use revision `unknown` unless built with `--build-arg VCS_REF=...`.

## Publishing, when authorized

1. Configure the actual GitHub repository remote, commit the reviewed source, and pass normal CI. No remote address is hardcoded in these release files.
2. Create a protected `release` GitHub environment with required reviewers if your repository plan supports them. Configure tag protection and restrict who can dispatch publishing.
3. Add a repository or `release` environment Actions secret named `DOCKERHUB_TOKEN`: a Docker Hub access token for `mhfgomes` with write access to `mhfgomes/dnsmonitor`. A local `docker login` does not authenticate GitHub Actions. Do not put this token in Git or workflow YAML.
4. Create and push `v0.1.0` pointing to that reviewed commit.
5. Manually run **Publish versioned release** with tag `v0.1.0` from the trusted default branch. The workflow verifies the tag, version consistency, build checks and deployment templates.
6. The workflow publishes `mhfgomes/dnsmonitor:0.1.0` for Linux AMD64 and ARM64, with source/version/revision labels, provenance and SBOM. It then creates a **draft GitHub release** containing deployment artifacts and the image digest. Review the draft before making it public.

Dispatching this workflow publishes the image even though the GitHub release remains a draft. Create `mhfgomes/dnsmonitor` in Docker Hub with the intended public/private visibility before dispatching. The workflow deliberately does not move a `latest` tag. A failed draft-release step can leave a successfully published image, so inspect the registry before retrying. Treat version tags as immutable; choose a new patch version for changed source.

## Install from release artifacts

After publication, download the Compose/environment files and set the exact image:

```sh
cp env.example .env
# Fill unique database passwords, ENCRYPTION_KEY, optional SETUP_TOKEN, and URL/cookie settings.
export DNSMONITOR_IMAGE=mhfgomes/dnsmonitor:0.1.0
docker compose up -d --wait
```

Use the digest in IMAGE.txt to pin the release precisely. For Helm, install the packaged chart with `--set image.repository=mhfgomes/dnsmonitor --set image.tag=0.1.0`; create the namespace and application Secret first. For Swarm, unpack the deployment archive, set DNSMONITOR_IMAGE and follow the node-label/secret instructions. See [deployment operations](DEPLOYMENT.md) and [browser account setup](ACCOUNTS.md).

## Upgrade and rollback

Back up MariaDB and the matching encryption key first. Preserve passwords, existing volumes/PVCs, PUBLIC_URL, retention settings and runtime roles. Change only the selected image version/digest (and chart version for Helm), then use the existing deployment update command. For release Compose, pull the selected image before `docker compose up -d --wait`. Migrations run through the existing deployment mechanism.

Check readiness, the Account page version, worker heartbeats and a monitor's next check after an upgrade. No schema change is introduced by the release metadata itself. Image rollback does not reverse database migrations; confirm old-binary compatibility before rolling back, or restore the pre-upgrade database and matching key into a separate recovery installation.

## Known validation limits

The short 25-monitor baseline, Compose restart/restore tests and initial orchestrator smoke checks are documented in [validation evidence](VALIDATION.md). A 24-hour soak, full constrained-host testing and Swarm/Kubernetes-specific recovery/restore drills remain outstanding by choice. Do not describe v0.1.0 as having passed those checks. The automation's cross-platform build is not evidence of runtime validation on both architectures.
