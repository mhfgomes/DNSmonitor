import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  api,
  message,
  useResource,
  dateText,
  type Page,
  type Incident,
} from "../api";
import { Badge, Empty, ErrorBox, Pager, Values } from "./ui";

export function Incidents({ admin }: { admin: boolean }) {
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const resource = useResource<Page<Incident>>(
    `/incidents?limit=50&offset=${offset}${status ? `&status=${status}` : ""}`,
  );
  const acknowledge = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await api(`/incidents/${id}/acknowledge`, { method: "POST" });
      resource.refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Incidents</h1>
          <p>Follow DNS failures from the first alert to recovery.</p>
        </div>
      </header>
      <ErrorBox error={error || resource.error} />
      <section className="panel">
        <div className="table-toolbar">
          <div className="segmented">
            {[
              ["", "All incidents"],
              ["OPEN", "Open"],
              ["ACKNOWLEDGED", "Acknowledged"],
              ["RESOLVED", "Resolved"],
            ].map(([value, label]) => (
              <Button
                key={value}
                className={status === value ? "selected" : ""}
                aria-pressed={status === value}
                onClick={() => {
                  setStatus(value!);
                  setOffset(0);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        {!resource.data ? (
          <p className="loading">Loading incidents…</p>
        ) : !resource.data.items.length ? (
          <Empty title="No incidents here">
            Confirmed failures will appear here. Your monitors continue checking
            in the background.
          </Empty>
        ) : (
          <div className="incident-list">
            {resource.data.items.map((incident) => (
              <article className="incident" key={incident.id}>
                <div className="incident-top">
                  <div>
                    <a
                      className="monitor-name"
                      href={`#/monitors/${incident.monitor_id}`}
                    >
                      {incident.monitor_name}
                    </a>
                    <p>
                      {incident.reason === "VALUE_MISMATCH"
                        ? "DNS records differ from expected values"
                        : incident.reason === "NO_QUORUM"
                          ? "Resolvers could not agree on a valid answer"
                          : incident.reason.replaceAll("_", " ").toLowerCase()}
                    </p>
                  </div>
                  <Badge
                    status={
                      incident.closure_reason ? "CLOSED" : incident.status
                    }
                  />
                </div>
                <div className="incident-detail">
                  <div>
                    <span className="muted">Latest answer</span>
                    <Values values={incident.current_value} />
                  </div>
                  <div>
                    <span className="muted">Opened</span>
                    <time>{dateText(incident.opened_at)}</time>
                  </div>
                  <div>
                    <span className="muted">
                      {incident.closure_reason
                        ? "Closed after configuration change"
                        : incident.resolved_at
                          ? "Recovered"
                          : incident.acknowledged_at
                            ? "Acknowledged"
                            : "Recovery"}
                    </span>
                    <time>
                      {incident.resolved_at || incident.acknowledged_at
                        ? dateText(
                            incident.resolved_at ?? incident.acknowledged_at,
                          )
                        : "Waiting for successful checks"}
                    </time>
                  </div>
                  {admin && incident.status === "OPEN" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => void acknowledge(incident.id)}
                    >
                      {busy === incident.id ? "Saving…" : "Acknowledge"}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        <Pager
          offset={offset}
          count={resource.data?.items.length ?? 0}
          change={setOffset}
        />
      </section>
    </>
  );
}
