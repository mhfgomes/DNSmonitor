import { useEffect, useState } from "react";
import { RefreshCw, HeartPulse, Clock3, Bell, Database } from "lucide-react";
import type { OperationsSnapshot } from "../../../../packages/database/src/operations";
import { useResource, dateText } from "../api";
import { Badge, ErrorBox } from "./ui";
import { Button } from "./ui/button";

export function OperationsPage() {
  const { data, error, loading, refresh } =
    useResource<OperationsSnapshot>("/operations");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const stale = Boolean(
    error || (data && now - Date.parse(data.collectedAt) > 30000),
  );
  const attention =
    data &&
    ((data.workers.online === 0 &&
      (data.monitors.enabled > 0 ||
        data.notifications.routing +
          data.notifications.pending +
          data.notifications.processing >
          0)) ||
      data.monitors.overdue > 0 ||
      data.notifications.failed > 0 ||
      data.retention.late);
  const seconds = (value: number | null) =>
    value === null ? "No samples" : `${value.toFixed(2)} s`;
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>System health</h1>
          <p>Keep the monitoring system itself in view.</p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={loading}>
          <RefreshCw size={16} />
          Refresh
        </Button>
      </header>
      <ErrorBox
        error={error ? `Could not refresh system health. ${error}` : ""}
      />
      {!data ? (
        <p role="status">
          {loading
            ? "Checking system health…"
            : "System health is unavailable. Try refreshing."}
        </p>
      ) : (
        <>
          <section
            className="panel p-5 mb-6 flex flex-wrap items-center justify-between gap-4"
            aria-label="System status"
          >
            <div className="flex items-center gap-3">
              <HeartPulse className="text-primary" aria-hidden="true" />
              <div>
                <h2 className="text-lg font-semibold">
                  {stale
                    ? "Last known status"
                    : attention
                      ? "Needs attention"
                      : data.monitors.enabled
                        ? "Monitoring is running"
                        : "Ready for monitors"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  Snapshot from {dateText(data.collectedAt)}
                  {stale
                    ? " · Updates unavailable"
                    : " · Updates every 10 seconds"}
                </p>
              </div>
            </div>
            <Badge
              status={stale ? "UNKNOWN" : attention ? "WARNING" : "HEALTHY"}
            />
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="panel p-5">
              <h2 className="flex items-center gap-2 text-lg font-semibold mb-4">
                <HeartPulse size={18} />
                Workers
              </h2>
              <p className="mb-4">
                {data.workers.online} online · {data.workers.stale} expired
                heartbeats
              </p>
              {!data.workers.online && (
                <p className="text-sm text-muted-foreground mb-4">
                  Start a combined instance or worker to run checks, send alerts
                  and clean up history.
                </p>
              )}
              <ul className="divide-y divide-border">
                {data.workers.items.map((worker) => (
                  <li
                    key={worker.id}
                    className="py-3 flex flex-wrap justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <code className="block text-xs break-all">
                        {worker.id}
                      </code>
                      <span className="text-sm text-muted-foreground">
                        Heartbeat {worker.ageSeconds}s ago · {worker.activeJobs}{" "}
                        active checks
                      </span>
                    </div>
                    <Badge
                      status={
                        worker.status === "ONLINE" && worker.ageSeconds < 15
                          ? "HEALTHY"
                          : worker.status === "STOPPED"
                            ? "PAUSED"
                            : "WARNING"
                      }
                    />
                  </li>
                ))}
              </ul>
              {data.workers.truncated && (
                <p className="text-sm">Showing the 100 most recent workers.</p>
              )}
              {data.workers.stale > 0 && (
                <p className="text-sm text-muted-foreground mt-3">
                  Expired entries can belong to replaced workers. Check that the
                  expected number of workers is online.
                </p>
              )}
            </section>
            <section className="panel p-5">
              <h2 className="flex items-center gap-2 text-lg font-semibold mb-4">
                <Clock3 size={18} />
                Scheduling and DNS
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt>Enabled monitors</dt>
                <dd className="text-right">{data.monitors.enabled}</dd>
                <dt>Overdue checks</dt>
                <dd className="text-right">{data.monitors.overdue}</dd>
                <dt>Oldest eligible check</dt>
                <dd className="text-right">
                  {seconds(data.monitors.oldestDueSeconds)}
                </dd>
                <dt>Scheduling delay · p95</dt>
                <dd className="text-right">
                  {seconds(data.recent.delayP95Seconds)}
                </dd>
                <dt>Maximum delay</dt>
                <dd className="text-right">
                  {seconds(data.recent.delayMaxSeconds)}
                </dd>
                <dt>DNS timeout rate</dt>
                <dd className="text-right">
                  {data.recent.timeoutRatio === null
                    ? "No samples"
                    : `${(data.recent.timeoutRatio * 100).toFixed(1)}%`}{" "}
                  ({data.recent.timeouts}/{data.recent.queries})
                </dd>
                <dt>Check execution errors</dt>
                <dd className="text-right">{data.recent.errors}</dd>
              </dl>
              <p className="text-sm text-muted-foreground mt-4">
                {data.recent.checks} completed or ended checks in the last 15
                minutes
                {data.recent.truncated
                  ? " · Limited to the latest 1,000 checks"
                  : ""}
                . Overdue means more than 30 seconds late, excluding active
                leases.
              </p>
            </section>
            <section className="panel p-5">
              <h2 className="flex items-center gap-2 text-lg font-semibold mb-4">
                <Bell size={18} />
                Notifications
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt>Waiting to route</dt>
                <dd className="text-right">{data.notifications.routing}</dd>
                <dt>Pending delivery</dt>
                <dd className="text-right">{data.notifications.pending}</dd>
                <dt>Sending</dt>
                <dd className="text-right">{data.notifications.processing}</dd>
                <dt>Failed deliveries</dt>
                <dd className="text-right">{data.notifications.failed}</dd>
              </dl>
              <a
                className="inline-block mt-4 text-sm underline underline-offset-4"
                href="#/notifications"
              >
                Review notification deliveries
              </a>
            </section>
            <section className="panel p-5">
              <h2 className="flex items-center gap-2 text-lg font-semibold mb-4">
                <Database size={18} />
                Storage and retention
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt>Tables and indexes</dt>
                <dd className="text-right">
                  {(data.database.approximateBytes / 1048576).toFixed(2)} MiB
                </dd>
                <dt>Cleanup</dt>
                <dd className="text-right">
                  {!data.retention.enabled
                    ? "Disabled"
                    : data.retention.late
                      ? "Delayed or not yet run"
                      : "On schedule"}
                </dd>
                <dt>Last completed</dt>
                <dd className="text-right">
                  {data.retention.lastCompletedAt
                    ? dateText(data.retention.lastCompletedAt)
                    : "Not yet run"}
                </dd>
                <dt>Detailed history</dt>
                <dd className="text-right">
                  {data.retention.checkHours} hours
                </dd>
                <dt>Hourly summaries</dt>
                <dd className="text-right">
                  {data.retention.summaryDays} days
                </dd>
              </dl>
              <p className="text-sm text-muted-foreground mt-4">
                Storage is approximate and excludes database system files.
                Cleanup runs inside workers.
              </p>
            </section>
          </div>
        </>
      )}
    </>
  );
}
