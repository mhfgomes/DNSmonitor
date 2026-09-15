import { useCallback, useEffect, useState } from "react";

let csrfToken = "";
export function setCsrf(token: string) {
  csrfToken = token;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    signal: options.signal,
    headers: {
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...(!["GET", "HEAD"].includes(method) && csrfToken
        ? { "x-csrf-token": csrfToken }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== "/auth/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      body.fields?.length
        ? `Check these fields: ${body.fields.join(", ")}.`
        : (body.error ?? "Request failed. Please try again."),
      response.status,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
export function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    setLoading(true);
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(result);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(message(error));
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, revision]);
  return { data, error, loading, refresh };
}
export function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export interface Identity {
  email: string;
  role: string;
  csrfToken: string;
}
export type Value = string | { priority: number; host: string };
export interface Config {
  hostname: string;
  recordType: "A" | "AAAA" | "CNAME" | "MX" | "TXT";
  mode: "WATCH" | "EXPECTED";
  expected?: Value[];
  match?: "EXACT" | "CONTAINS";
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  changeThreshold: number;
  resolverIds: string[];
}
export interface Monitor {
  id: string;
  name: string;
  enabled: boolean;
  config: Config;
  state: {
    status: string;
    baseline?: Value[];
    failures: number;
    successes: number;
    incidentOpen: boolean;
    lastCheckedAt?: string;
  };
  nextCheckAt: string;
  leaseExpiresAt?: string;
}
export interface Check {
  id: string;
  started_at: string;
  status: string;
  resolver_results:
    | {
        resolverId: string;
        status: string;
        answers: Value[];
        latencyMs: number;
      }[]
    | null;
  observation: {
    status?: string;
    value?: Value[];
    degraded: boolean;
    reason: string;
  } | null;
}
export interface DnsEvent {
  id: string;
  monitor_id: string;
  monitor_name?: string;
  type: string;
  created_at: string;
  payload: { oldValue?: Value[]; newValue?: Value[] };
}
export interface Incident {
  closure_reason?: string | null;
  id: string;
  monitor_id: string;
  monitor_name: string;
  status: string;
  reason: string;
  opened_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
  initial_value: Value[] | null;
  current_value: Value[] | null;
}
export interface Detail extends Monitor {
  configRevision: number;
  resolvers: { id: string; server: string; protocol: string; port?: number }[];
  currentValue: Value[] | null;
  checks: Check[];
  events: DnsEvent[];
  incidents: Incident[];
}
export interface Page<T> {
  items: T[];
  total?: number;
  limit: number;
  offset: number;
}
export interface Channel {
  id: string;
  name: string;
  type: "SMTP" | "WEBHOOK";
  enabled: boolean | number;
}
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  config: { eventTypes: string[]; channelIds: string[]; monitorIds: string[] };
}
export interface Delivery {
  id: string;
  channel_id: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  sent_at: string | null;
  last_error: string | null;
}
export interface Dashboard {
  total: number;
  states: Record<string, number>;
  workers: { online: number; total: number };
  recentEvents: DnsEvent[];
}
export function valueText(value: Value): string {
  return typeof value === "string" ? value : `${value.priority} ${value.host}`;
}
export function dateText(value?: string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Not checked yet";
}
export function intervalText(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
}
