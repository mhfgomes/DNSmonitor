# Resource and recovery validation

The release validation harness uses 25 A-record monitors: 13 WATCH and 12 EXPECTED, with three DNS resolver sockets each. Every monitor keeps its real 300-second interval. DNS responses have a controlled 20ms delay per resolver. Failure, recovery and change confirmation thresholds are two. A local signed-webhook destination receives alerts; no real notification services or user data are involved.

## Reproduce

Requires Docker Compose, Python 3 and a local image build. Run from the repository root:

```sh
scripts/validation/run.sh 660 test-results/validation
```

The same runner is available as the manually triggered **Resource and recovery validation** GitHub Actions workflow. Its result artifacts are retained for seven days.

The runner builds the current image, seeds a fresh stack, samples for eleven minutes, runs the recovery/restore drills, and removes its own containers and volumes on exit. It refuses to reuse an existing validation stack. JSON evidence remains in the selected output directory. The Compose project is always `dnsmonitor-validation`; it publishes no host ports and uses no existing application volumes or credentials. All passwords and keys in these fixtures are public test-only values.

If a manually interrupted run leaves resources behind, inspect that project before explicitly removing it:

```sh
docker compose -p dnsmonitor-validation -f deploy/compose.validation.yaml -f deploy/compose.validation-restore.yaml down -v
docker compose -p dnsmonitor-validation -f deploy/compose.validation.yaml down -v
```

The default caps are 192 MiB for the application and 256 MiB for MariaDB, with 0.5 CPU each. To test a different budget, set `VALIDATION_APP_MEMORY` and `VALIDATION_DB_MEMORY` before running. The local DNS/webhook fixture is outside the measured application/database budget.

## What is measured

Docker memory and CPU samples are taken about every fifteen seconds. Memory from `docker stats` excludes reclaimable cache; per-container cgroup memory peaks include it and include startup/provisioning. Summing individual peaks gives an upper bound, since the two peaks may occur at different times. CPU figures are sampled percentages of one CPU, not a continuous CPU-time integral. The SQL measurements include check counts, scheduler lateness, check duration and approximate allocated table/index bytes. Database filesystem usage is recorded separately because InnoDB system/redo files add storage beyond table bytes. The fixture uses three-second app health probes and two-second database probes, so their overhead is included.

The baseline must finish at least two checks for every monitor, with three successful resolver responses per check and all monitors healthy. No check may start more than five seconds late. The measurement fails on an unexpected failed/incomplete check or an observed OOM/restart.

This is a short, deterministic workload on Docker Desktop. Container CPU quotas do not emulate a dedicated one-vCPU machine. The budget excludes the operating system, Docker/Kubernetes/Swarm, fixture, reverse proxy, TLS and concurrent browser users. Eleven minutes does not establish long-term storage growth, sustained retention performance or production hardware minimums. An actual 512 MiB host has not been validated by this test.

## Recovery and restore acceptance

After the scheduled baseline, additional rounds use the existing check-now operation to avoid changing configured intervals:

1. Drop all three resolvers for a complete round, then restore successful responses.
2. Kill the app with active DNS requests. Wait for natural lease expiration, reclaim work and verify abandoned runs are recorded.
3. Change answers and verify exactly 13 WATCH changes and 12 EXPECTED incident openings.
4. Restart MariaDB with active requests, then verify checks resume and incident openings are not duplicated.
5. Restore original answers and verify exactly 12 incident resolutions and 13 further WATCH changes. Wait for the local alert deliveries.
6. Stop the app, dump MariaDB, and restore into a newly initialized second volume while retaining the original volume.
7. Compare row counts and SHA-256 digests of every table before resuming. Verify the restored administrator can log in, the encrypted channel can send a test notification, a wrong encryption key is rejected, and every monitor completes another check.

The SQL dump exists only in a temporary directory and is deleted after the drill. Stored report artifacts contain table digests rather than account or notification secrets. This drill validates the logical database backup path on Compose; cluster-specific snapshot restore, multi-node failover and network partitions require separate validation.

## Recorded baseline — 2026-09-12

The first run used Docker Desktop 29.7.2 on ARM64, with MariaDB 11.4 and the current application image. It sampled for 660 seconds, with checks counted from seeding. The container limits were 192 MiB app + 256 MiB database and 0.5 CPU each.

| Measurement | Observed result |
| --- | --- |
| Monitors / completed checks | 25 / 59; at least two checks each |
| Resolver responses | 177 successful; no failures |
| Final monitor states | All 25 healthy |
| Scheduling delay, median / p95 / maximum | 239 / 492 / 502 ms |
| Peak sampled combined Docker memory | 158.85 MiB |
| Sum of individual cgroup memory peaks | 254.43 MiB, including cache and provisioning |
| Sampled combined CPU, mean / peak | 5.59% / 16.59% of one core |
| OOM kills / automatic restarts in baseline | 0 / 0 |
| Allocated table and index bytes, before / after | 704,512 / 753,664 |
| Database filesystem usage after baseline | 170,835,968 bytes (162.92 MiB) |

The [raw baseline evidence](validation/448m-measurement.json) includes individual samples and check timings. These observations support the tested 448 MiB **container budget** for this workload, not a minimum RAM specification for an entire host. Keep the configured limits above the sampled memory figure: cgroup peaks and interactive operations consume more than a typical sample shows.

## Recorded recovery and restore results

The [recovery evidence](validation/448m-recovery.json) records the same 448 MiB container budget:

- A full round with all resolvers timing out finished in 43.21 seconds.
- Worker kill, natural lease recovery and a full verification round finished in 25.14 seconds; two interrupted runs were marked abandoned.
- Database restart and a full verification round finished in 9.81 seconds.
- Answer changes produced exactly 26 WATCH changes, 12 EXPECTED incident openings and 12 recoveries across the change-and-return sequence. Restarting did not duplicate incident openings.
- The 402,934-byte SQL dump restored into a separate fresh volume with matching counts and row digests across all 19 tables.
- Restored account authentication and encrypted channel delivery passed. The wrong encryption key failed decryption and sent nothing.
- All 25 monitors completed a further check after restoration. The final restored containers reported no cgroup OOM events.

Recovery timings include the verification round; they are not just process startup times. The drill retains real lease durations, while manually requested check rounds keep fault testing short. The earlier scheduled baseline is the evidence for five-minute cadence.

Next validation work is a longer soak with retention, concurrent UI use, other record types and TCP fallback on a constrained Linux host, followed by the same failure/restore drills on Swarm and Kubernetes storage. These results do not replace those deployment-specific checks.
