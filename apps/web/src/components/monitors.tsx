import { DeleteMonitor } from "./delete-monitor";
import { HourlyHistory } from "./hourly-history";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  Plus,
  Search,
  SlidersHorizontal,
  RefreshCw,
  Pause,
  Play,
} from "lucide-react";
import {
  api,
  useResource,
  message,
  dateText,
  intervalText,
  type Monitor,
  type Page,
  type Dashboard,
  type Detail,
  type DnsEvent,
} from "../api";
import { Badge, Empty, ErrorBox, Pager, Values } from "./ui";
import { CreateMonitor, EditTiming } from "./monitor-form";

export function EventList({ events }: { events: DnsEvent[] }) {
  return (
    <div className="events">
      {events.map((event) => (
        <div className="event" key={event.id}>
          <span
            className={`event-marker ${event.type === "INCIDENT_OPENED" ? "critical" : ""}`}
          />
          <div>
            <div className="event-title">
              {event.monitor_name && (
                <a href={`#/monitors/${event.monitor_id}`}>
                  {event.monitor_name}
                </a>
              )}
              <span>
                {(
                  {
                    BASELINE_ESTABLISHED: "Baseline learned",
                    CONFIGURATION_CHANGED: "Configuration changed",
                    VALUE_CHANGED: "Records changed",
                    INCIDENT_OPENED: "Incident opened",
                    INCIDENT_RESOLVED: "Recovered",
                  } as Record<string, string>
                )[event.type] ?? event.type}
              </span>
            </div>
            {event.type === "VALUE_CHANGED" && (
              <div className="value-change">
                <del>
                  <Values values={event.payload.oldValue} />
                </del>
                <Values values={event.payload.newValue} />
              </div>
            )}
          </div>
          <time>{dateText(event.created_at)}</time>
        </div>
      ))}
    </div>
  );
}

export function Monitors({ admin }: { admin: boolean }) {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("");
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const list = useResource<Page<Monitor>>(
    `/monitors?limit=50&offset=${offset}&search=${encodeURIComponent(search)}${mode ? `&mode=${mode}` : ""}`,
  );
  const dashboard = useResource<Dashboard>("/dashboard");
  const create = (
    <Button onClick={() => setAdding(true)}>
      <Plus size={17} />
      Add monitor
    </Button>
  );
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Monitors</h1>
          <p>Keep track of your DNS, one record at a time.</p>
        </div>
        {admin && create}
      </header>
      <ErrorBox error={list.error || dashboard.error} />
      <div className="health-summary">
        <div>
          <strong>{dashboard.data?.total ?? "—"}</strong>
          <span>monitors</span>
        </div>
        {["HEALTHY", "WARNING", "CRITICAL", "UNKNOWN", "PAUSED"].map(
          (status) => (
            <div key={status}>
              <span className={`status-dot ${status.toLowerCase()}`} />
              <strong>{dashboard.data?.states[status] ?? 0}</strong>
              <span>{status.toLowerCase()}</span>
            </div>
          ),
        )}
        <span className="worker-state">
          {dashboard.data?.workers.online ?? 0} worker
          {Number(dashboard.data?.workers.online) === 1 ? "" : "s"} online
        </span>
      </div>
      <div className="monitor-workspace">
        <section className="panel monitor-table">
          <div className="table-toolbar">
            <label className="search">
              <Search size={17} />
              <Input
                className="pl-9"
                aria-label="Search monitors"
                placeholder="Search name or hostname…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <div className="segmented" aria-label="Monitor mode">
              {[
                ["", "All modes"],
                ["WATCH", "Watch"],
                ["EXPECTED", "Expected"],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  className={mode === value ? "selected" : ""}
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value!);
                    setOffset(0);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh monitors"
              onClick={() => {
                list.refresh();
                dashboard.refresh();
              }}
            >
              <RefreshCw size={17} />
            </Button>
          </div>
          {!list.data ? (
            <p className="loading">Loading monitors…</p>
          ) : !list.data.items.length ? (
            <Empty
              title={
                search || mode
                  ? "No matching monitors"
                  : "Your first DNS monitor starts here"
              }
              action={!search && !mode && admin ? create : undefined}
            >
              {search || mode
                ? "Try a different search or mode."
                : "Watch a record for changes or make sure it matches the values you expect."}
            </Empty>
          ) : (
            <div className="table-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Monitor</TableHead>
                    <TableHead>Record</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Check interval</TableHead>
                    <TableHead>Last checked</TableHead>
                    <TableHead>
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.items.map((monitor) => (
                    <TableRow key={monitor.id}>
                      <TableCell>
                        <a
                          className="monitor-name"
                          href={`#/monitors/${monitor.id}`}
                        >
                          {monitor.name}
                        </a>
                        <span className="subline dns-name">
                          {monitor.config.hostname}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="record-type">
                          {monitor.config.recordType}
                        </span>
                      </TableCell>
                      <TableCell>
                        {monitor.config.mode === "WATCH" ? "Watch" : "Expected"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          status={
                            monitor.enabled ? monitor.state.status : "PAUSED"
                          }
                        />
                      </TableCell>
                      <TableCell>
                        {intervalText(monitor.config.intervalSeconds)}
                      </TableCell>
                      <TableCell className="muted">
                        {dateText(monitor.state.lastCheckedAt)}
                      </TableCell>
                      <TableCell>
                        <a
                          className="icon-button"
                          aria-label={`Open ${monitor.name}`}
                          href={`#/monitors/${monitor.id}`}
                        >
                          <ArrowUpRight size={16} />
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Pager
            offset={offset}
            count={list.data?.items.length ?? 0}
            total={list.data?.total}
            change={setOffset}
          />
        </section>
        <section className="panel recent">
          <div className="section-heading">
            <h2>Recent DNS activity</h2>
            <span className="muted">Latest 10 events</span>
          </div>
          {dashboard.data?.recentEvents.length ? (
            <EventList events={dashboard.data.recentEvents} />
          ) : (
            <p className="quiet-empty">
              Confirmed changes and incidents will appear here after checks
              begin.
            </p>
          )}
        </section>
      </div>
      {adding && (
        <CreateMonitor
          close={() => setAdding(false)}
          saved={(id) => {
            window.location.hash = `/monitors/${id}`;
          }}
        />
      )}
    </>
  );
}

export function MonitorDetails({ id, admin }: { id: string; admin: boolean }) {
  const resource = useResource<Detail>(`/monitors/${id}`);
  const monitor = resource.data;
  const [editing, setEditing] = useState(false);
  const [editMonitor, setEditMonitor] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string>();
  const action = async (value: string) => {
    setBusy(value);
    setError("");
    setNotice("");
    try {
      await api(`/monitors/${id}/${value}`, { method: "POST" });
      setNotice(
        value === "check"
          ? "Check requested."
          : value === "pause"
            ? "Monitor paused."
            : "Monitor resumed.",
      );
      resource.refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy("");
    }
  };
  if (!monitor)
    return (
      <>
        <a className="back-link" href="#/monitors">
          <ArrowLeft size={16} />
          Monitors
        </a>
        <ErrorBox error={resource.error} />
        <p className="loading">
          {resource.loading ? "Loading monitor…" : "Monitor unavailable."}
        </p>
      </>
    );
  const completed = monitor.checks.filter(
    (check) => check.status === "COMPLETED",
  );
  const check =
    completed.find((check) => check.id === selected) ?? completed[0];
  return (
    <>
      <a className="back-link" href="#/monitors">
        <ArrowLeft size={16} />
        Monitors
      </a>
      <header className="page-heading">
        <div>
          <div className="title-with-type">
            <span className="record-type">{monitor.config.recordType}</span>
            <h1>{monitor.name}</h1>
          </div>
          <p className="dns-name">{monitor.config.hostname}</p>
        </div>
        {admin && (
          <div className="button-group">
            <Button variant="outline" onClick={() => setEditMonitor(true)}>
              <SlidersHorizontal size={16} />
              Edit monitor
            </Button>
            <Button
              variant="outline"
              disabled={!!busy || !monitor.enabled || !!monitor.leaseExpiresAt}
              onClick={() => void action("check")}
            >
              <RefreshCw size={16} />
              {busy === "check" ? "Requesting…" : "Check now"}
            </Button>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => void action(monitor.enabled ? "pause" : "resume")}
            >
              {monitor.enabled ? <Pause size={16} /> : <Play size={16} />}
              {monitor.enabled ? "Pause" : "Resume"}
            </Button>
          </div>
        )}
      </header>
      <ErrorBox error={error || resource.error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="monitor-meta">
        <Badge status={monitor.enabled ? monitor.state.status : "PAUSED"} />
        <span>
          {monitor.config.mode === "WATCH"
            ? "Watching for changes"
            : "Checking expected records"}
        </span>
        <span>
          <Clock3 size={15} />
          Every {intervalText(monitor.config.intervalSeconds)}
        </span>
        <span className="muted">
          Last checked {dateText(monitor.state.lastCheckedAt)}
        </span>
      </div>
      <div className="value-panels">
        <section className="panel value-panel">
          <h2>Current answer</h2>
          <Values
            values={monitor.currentValue}
            empty={
              monitor.state.lastCheckedAt
                ? "No agreed answer in the latest check"
                : "Waiting for the first check"
            }
          />
        </section>
        <section className="panel value-panel">
          <h2>
            {monitor.config.mode === "WATCH"
              ? "Accepted baseline"
              : "Expected answer"}
          </h2>
          <Values
            values={
              monitor.config.mode === "WATCH"
                ? monitor.state.baseline
                : monitor.config.expected
            }
            empty="Learning a stable baseline"
          />
          <p className="hint">
            {monitor.config.mode === "WATCH"
              ? `${monitor.config.changeThreshold} identical observations confirm a change.`
              : monitor.config.match === "CONTAINS"
                ? "Additional records are allowed."
                : "The complete record set must match."}
          </p>
        </section>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>Resolver answers</h2>
          <span className="muted">
            {check
              ? dateText(check.started_at)
              : monitor.state.lastCheckedAt
                ? "No retained check details"
                : "Awaiting first check"}
          </span>
        </div>
        {check?.resolver_results?.length ? (
          <div className="table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resolver</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Answer</TableHead>
                  <TableHead>Response time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {check.resolver_results.map((result) => (
                  <TableRow key={result.resolverId}>
                    <TableCell>
                      <span
                        className={`resolver-square ${result.status === "SUCCESS" ? "healthy" : "critical"}`}
                      />
                      {result.resolverId}
                    </TableCell>
                    <TableCell>
                      <Badge status={result.status} />
                    </TableCell>
                    <TableCell>
                      <Values values={result.answers} />
                    </TableCell>
                    <TableCell>{result.latencyMs} ms</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="quiet-empty">
            {monitor.state.lastCheckedAt
              ? "Detailed resolver answers have expired. Archived hourly history is available below. New checks will show fresh results here."
              : "Results appear after the first scheduled check. You can also request a check now."}
          </p>
        )}
        {!!completed.length && (
          <div className="check-history">
            <span>Recent checks</span>
            <div>
              {[...completed].reverse().map((item) => (
                <Button
                  aria-label={`View check ${dateText(item.started_at)}`}
                  title={dateText(item.started_at)}
                  key={item.id}
                  onClick={() => setSelected(item.id)}
                  className={`check-block ${item.observation?.status?.toLowerCase() ?? "unknown"} ${check?.id === item.id ? "active" : ""}`}
                />
              ))}
            </div>
            <span className="muted">Select a check to inspect its answers</span>
          </div>
        )}
      </section>
      <section className="panel timing-panel">
        <div>
          <h2>Timing and confirmation</h2>
          <p>
            {monitor.config.failureThreshold} failed check
            {monitor.config.failureThreshold === 1 ? "" : "s"} to alert.{" "}
            {monitor.config.recoveryThreshold} successful check
            {monitor.config.recoveryThreshold === 1 ? "" : "s"} to recover.
            Resolver timeout: {monitor.config.timeoutMs} ms.
          </p>
        </div>
        {admin && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            <SlidersHorizontal size={16} />
            Edit timing
          </Button>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Event history</h2>
          <span className="muted">Latest 20 events</span>
        </div>
        {monitor.events.length ? (
          <EventList events={monitor.events} />
        ) : (
          <p className="quiet-empty">No confirmed changes or incidents yet.</p>
        )}
      </section>
      <HourlyHistory id={id} />
      {admin && (
        <div className="mb-6 flex justify-end">
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            Delete monitor
          </Button>
        </div>
      )}
      {editMonitor && (
        <CreateMonitor
          monitor={monitor}
          close={() => setEditMonitor(false)}
          saved={() => {
            resource.refresh();
            setSelected(undefined);
            setNotice("Monitor updated.");
          }}
        />
      )}
      {deleting && (
        <DeleteMonitor monitor={monitor} close={() => setDeleting(false)} />
      )}
      {editing && (
        <EditTiming
          monitor={monitor}
          close={() => setEditing(false)}
          saved={() => {
            setNotice("Timing updated.");
            resource.refresh();
          }}
        />
      )}
    </>
  );
}
