import { useState } from "react";
import { useResource, dateText, type Page } from "../api";
import { ErrorBox, Pager } from "./ui";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./ui/table";
interface Hour {
  hour_at: string;
  config_revision: number;
  checks: number;
  completed: number;
  healthy: number;
  warning: number;
  critical: number;
  unknown_count: number;
  errors: number;
  abandoned: number;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
}
export function HourlyHistory({ id }: { id: string }) {
  const [offset, setOffset] = useState(0);
  const resource = useResource<Page<Hour>>(
    `/monitors/${id}/hourly?limit=50&offset=${offset}`,
  );
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Archived hourly history</h2>
          <p className="muted">
            Older checks grouped by hour and configuration. The newest archive
            hour may be partial. Counts are observations, not uptime
            percentages.
          </p>
        </div>
      </div>
      <ErrorBox error={resource.error} />
      {!resource.data ? (
        <p className="loading">Loading archived history…</p>
      ) : resource.data.items.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hour starting</TableHead>
              <TableHead>Revision</TableHead>
              <TableHead>Checks</TableHead>
              <TableHead>Healthy</TableHead>
              <TableHead>Warning</TableHead>
              <TableHead>Critical</TableHead>
              <TableHead>Unknown</TableHead>
              <TableHead>Error / abandoned</TableHead>
              <TableHead>Mean / max response</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {resource.data.items.map((hour) => (
              <TableRow key={`${hour.hour_at}/${hour.config_revision}`}>
                <TableCell>{dateText(hour.hour_at)}</TableCell>
                <TableCell>{hour.config_revision}</TableCell>
                <TableCell>{hour.checks}</TableCell>
                <TableCell>{hour.healthy}</TableCell>
                <TableCell>{hour.warning}</TableCell>
                <TableCell>{hour.critical}</TableCell>
                <TableCell>{hour.unknown_count}</TableCell>
                <TableCell>
                  {hour.errors} / {hour.abandoned}
                </TableCell>
                <TableCell>
                  {hour.averageLatencyMs === null
                    ? "No successful responses"
                    : `${Number(hour.averageLatencyMs).toFixed(1)} / ${Number(hour.maxLatencyMs).toFixed(1)} ms`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="quiet-empty">
          Summaries appear as detailed checks age out. Recent checks remain in
          the resolver history above.
        </p>
      )}
      <Pager
        offset={offset}
        count={resource.data?.items.length ?? 0}
        change={setOffset}
      />
    </section>
  );
}
