import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { databasePool } from "../../dist/packages/database/src/connection.js";
import { Repository } from "../../dist/packages/database/src/repository.js";
import { Auth } from "../../dist/packages/auth/src/index.js";
import { Notifications } from "../../dist/packages/notifications/src/service.js";
const database = process.env.DATABASE_NAME;
assert.equal(
  database,
  "dnsmonitor_validation_test",
  "Only the disposable validation database is allowed",
);
const pool = databasePool();
const repository = new Repository(pool);
const notifications = new Notifications(
  pool,
  Buffer.from(process.env.ENCRYPTION_KEY, "hex"),
);
try {
  let returnSnapshot = false;
  const command = process.argv[2];
  const fixture = (await lookup("fixture")).address;
  if (command === "seed") {
    assert.equal(
      (await pool.query("SELECT COUNT(*) AS n FROM monitors"))[0].n,
      0,
      "Use a fresh validation volume",
    );
    await new Auth(pool).setAdmin(
      "validation@example.test",
      "validation-only-admin-password",
    );
    const channelId = await notifications.createChannel(
      "Local validation webhook",
      {
        type: "WEBHOOK",
        url: "http://fixture:8080/alert",
        signingSecret: "validation-only-signing-secret",
      },
    );
    await notifications.createRule("Validation alerts", {
      eventTypes: ["VALUE_CHANGED", "INCIDENT_OPENED", "INCIDENT_RESOLVED"],
      channelIds: [channelId],
      monitorIds: [],
    });
    for (let i = 0; i < 25; i++) {
      const mode = i % 2 ? "EXPECTED" : "WATCH";
      await repository.createMonitor({
        name: `Validation ${mode} ${i}`,
        config: {
          hostname: `monitor-${i}.example.test`,
          recordType: "A",
          mode,
          ...(mode === "EXPECTED"
            ? { expected: ["192.0.2.1"], match: "EXACT" }
            : {}),
          intervalSeconds: 300,
          timeoutMs: 1000,
          failureThreshold: 2,
          recoveryThreshold: 2,
          changeThreshold: 2,
          resolverIds: ["one", "two", "three"],
        },
        resolvers: ["one", "two", "three"].map((id, n) => ({
          id,
          server: fixture,
          port: 5353 + n,
          protocol: "UDP",
        })),
      });
    }
  } else if (command === "due") {
    for (const row of await pool.query("SELECT id FROM monitors"))
      await repository.checkNow(row.id);
  } else if (command === "verify-restore") {
    assert.equal(
      (await pool.query("SELECT COUNT(*) AS n FROM monitors"))[0].n,
      25,
    );
    assert.ok(
      await new Auth(pool).login(
        "validation@example.test",
        "validation-only-admin-password",
        "restore",
      ),
    );
    const rows = await pool.query("SELECT id FROM notification_channels");
    assert.equal(rows.length, 1);
    await notifications.testChannel(rows[0].id);
  } else if (command === "snapshot") {
    const tables = await pool.query("SHOW TABLES");
    const snapshot = {};
    for (const row of tables) {
      const table = Object.values(row)[0];
      assert.match(table, /^[a-z_]+$/);
      const rows = await pool.query(`SELECT * FROM ${table}`);
      snapshot[table] = {
        count: rows.length,
        sha256: createHash("sha256")
          .update(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()))
          .digest("hex"),
      };
    }
    console.log(JSON.stringify(snapshot));
    process.exitCode = 0;
    returnSnapshot = true;
  } else if (command !== "report")
    throw new Error("Unknown validation command");
  if (!returnSnapshot) {
    const checks = await pool.query(
      "SELECT id, monitor_id, status, resolver_results, TIMESTAMPDIFF(MICROSECOND,scheduled_at,started_at)/1000 AS lateness_ms, TIMESTAMPDIFF(MICROSECOND,started_at,finished_at)/1000 AS duration_ms FROM check_runs ORDER BY started_at",
    );
    for (const check of checks) {
      check.successfulResolvers = JSON.parse(
        check.resolver_results ?? "[]",
      ).filter((r) => r.status === "SUCCESS").length;
      delete check.resolver_results;
    }
    const states = (await pool.query("SELECT state FROM monitor_states")).map(
      (row) => JSON.parse(row.state).status,
    );
    const counts = {};
    for (const table of [
      "monitors",
      "users",
      "check_runs",
      "incidents",
      "dns_events",
      "notification_channels",
      "notification_deliveries",
    ])
      counts[table] = (
        await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)
      )[0].n;
    const events = await pool.query(
      "SELECT type, COUNT(*) AS n FROM dns_events GROUP BY type",
    );
    const bytes = (
      await pool.query(
        "SELECT SUM(data_length+index_length) AS n FROM information_schema.tables WHERE table_schema=DATABASE()",
      )
    )[0].n;
    console.log(
      JSON.stringify({
        counts,
        events,
        checks,
        states,
        databaseBytes: Number(bytes),
      }),
    );
  }
} finally {
  await pool.end();
}
