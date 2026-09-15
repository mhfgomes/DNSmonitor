import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useState, type FormEvent } from "react";
import { Bell, Mail, Webhook, Plus } from "lucide-react";
import {
  api,
  message,
  useResource,
  dateText,
  type Channel,
  type Rule,
  type Delivery,
  type Page,
  type Monitor,
} from "../api";
import { Badge, Empty, ErrorBox, Field, Modal, Pager } from "./ui";

function ChannelForm({
  close,
  saved,
}: {
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("WEBHOOK");
  const [url, setUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [secure, setSecure] = useState(false);
  const [requireTLS, setRequireTLS] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const config =
        type === "WEBHOOK"
          ? { type, url, ...(signingSecret ? { signingSecret } : {}) }
          : {
              type,
              host,
              port,
              secure,
              requireTLS,
              from,
              to: to
                .split(/[,\n]/)
                .map((value) => value.trim())
                .filter(Boolean),
              ...(username ? { username, password } : {}),
            };
      await api("/notification-channels", {
        method: "POST",
        body: { name, config },
      });
      saved();
      close();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add notification channel" close={close}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Channel name">
          <Input
            required
            autoFocus
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder="Operations email"
          />
        </Field>
        <Field label="Channel type">
          <NativeSelect
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option value="WEBHOOK">Webhook</option>
            <option value="SMTP">Email (SMTP)</option>
          </NativeSelect>
        </Field>
        {type === "WEBHOOK" ? (
          <>
            <Field label="Webhook URL">
              <Input
                required
                type="url"
                placeholder="https://alerts.example.com/dns"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <Field
              label="Signing secret"
              hint="Optional. Signs each payload so your receiver can verify its source."
            >
              <Input
                type="password"
                autoComplete="new-password"
                minLength={16}
                value={signingSecret}
                onChange={(event) => setSigningSecret(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <div className="form-grid">
              <Field label="SMTP host">
                <Input
                  required
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="smtp.example.com"
                />
              </Field>
              <Field label="SMTP port">
                <Input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => setPort(Number(event.target.value))}
                />
              </Field>
            </div>
            <div className="checkbox-row">
              <label>
                <Checkbox
                  checked={secure}
                  onCheckedChange={(checked) => setSecure(checked)}
                />
                Use implicit TLS
              </label>
              <label>
                <Checkbox
                  checked={requireTLS}
                  onCheckedChange={(checked) => setRequireTLS(checked)}
                />
                Require TLS
              </label>
            </div>
            <div className="form-grid">
              <Field
                label="SMTP username"
                hint="Leave empty for an unauthenticated local relay."
              >
                <Input
                  value={username}
                  autoComplete="off"
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field label="SMTP password">
                <Input
                  type="password"
                  required={!!username}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </div>
            <Field label="From address">
              <Input
                type="email"
                required
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                placeholder="dnsmonitor@example.com"
              />
            </Field>
            <Field
              label="Recipients"
              hint="Separate email addresses with commas. Up to 10 recipients."
            >
              <Textarea
                required
                value={to}
                onChange={(event) => setTo(event.target.value)}
                placeholder="ops@example.com"
              />
            </Field>
          </>
        )}
        <p className="hint">
          Settings are stored encrypted. Add an alert rule after creating this
          channel.
        </p>
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add channel"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const eventNames: Record<string, string> = {
  VALUE_CHANGED: "Record changes",
  INCIDENT_OPENED: "New incidents",
  INCIDENT_RESOLVED: "Recovery",
};
function RuleForm({
  channels,
  close,
  saved,
}: {
  channels: Channel[];
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState("");
  const [events, setEvents] = useState(Object.keys(eventNames));
  const [selected, setSelected] = useState<string[]>([]);
  const [scope, setScope] = useState("all");
  const [monitors, setMonitors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const available = useResource<Page<Monitor>>(
    `/monitors?limit=100&search=${encodeURIComponent(search)}`,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (values: string[], value: string) =>
    values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (
      !events.length ||
      !selected.length ||
      (scope === "selected" && !monitors.length)
    ) {
      setError(
        "Choose at least one event, a channel, and the monitors to include.",
      );
      return;
    }
    setBusy(true);
    try {
      await api("/alert-rules", {
        method: "POST",
        body: {
          name,
          config: {
            eventTypes: events,
            channelIds: selected,
            monitorIds: scope === "all" ? [] : monitors,
          },
        },
      });
      saved();
      close();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add alert rule" close={close}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Rule name">
          <Input
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Production DNS alerts"
          />
        </Field>
        <fieldset>
          <legend>Notify when</legend>
          <div className="checkbox-list">
            {Object.entries(eventNames).map(([value, label]) => (
              <label key={value}>
                <Checkbox
                  checked={events.includes(value)}
                  onCheckedChange={() => setEvents(toggle(events, value))}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Send to</legend>
          <div className="checkbox-list">
            {channels
              .filter((channel) => channel.enabled)
              .map((channel) => (
                <label key={channel.id}>
                  <Checkbox
                    checked={selected.includes(channel.id)}
                    onCheckedChange={() =>
                      setSelected(toggle(selected, channel.id))
                    }
                  />
                  {channel.name}
                  <span className="muted">
                    {channel.type === "SMTP" ? "Email" : "Webhook"}
                  </span>
                </label>
              ))}
          </div>
        </fieldset>
        <Field label="Apply to">
          <NativeSelect
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="all">All monitors</option>
            <option value="selected">Selected monitors</option>
          </NativeSelect>
        </Field>
        {scope === "selected" && (
          <>
            <Field label="Find monitors">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search monitors"
              />
            </Field>
            <ErrorBox error={available.error} />
            <div className="checkbox-list scroll-list">
              {available.data?.items.map((monitor) => (
                <label key={monitor.id}>
                  <Checkbox
                    checked={monitors.includes(monitor.id)}
                    onCheckedChange={() =>
                      setMonitors(toggle(monitors, monitor.id))
                    }
                  />
                  {monitor.name}
                </label>
              ))}
            </div>
            <p className="hint">
              {monitors.length} selected. Search to find monitors outside the
              current results.
            </p>
          </>
        )}
        <div className="form-actions">
          <Button variant="outline" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add rule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function NotificationsPage({ admin }: { admin: boolean }) {
  const channels = useResource<{ items: Channel[] }>("/notification-channels");
  const rules = useResource<{ items: Rule[] }>("/alert-rules");
  const [offset, setOffset] = useState(0);
  const deliveries = useResource<Page<Delivery>>(
    `/notification-deliveries?limit=50&offset=${offset}`,
  );
  const [modal, setModal] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const names = Object.fromEntries(
    (channels.data?.items ?? []).map((channel) => [channel.id, channel.name]),
  );
  const refresh = () => {
    channels.refresh();
    rules.refresh();
    deliveries.refresh();
  };
  const action = async (
    id: string,
    path: string,
    text: string,
    body?: unknown,
  ) => {
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await api(path, { method: body ? "PATCH" : "POST", body });
      setNotice(text);
      refresh();
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
          <h1>Notifications</h1>
          <p>Choose where alerts go and what triggers them.</p>
        </div>
        {admin && (
          <Button onClick={() => setModal("channel")}>
            <Plus size={17} />
            Add channel
          </Button>
        )}
      </header>
      <ErrorBox
        error={error || channels.error || rules.error || deliveries.error}
      />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <section className="panel">
        <div className="section-heading">
          <h2>Channels</h2>
          <span className="muted">Email and webhooks</span>
        </div>
        {!channels.data ? (
          <p className="loading">Loading channels…</p>
        ) : !channels.data.items.length ? (
          <Empty
            title="Give your alerts a destination"
            action={
              admin ? (
                <Button variant="outline" onClick={() => setModal("channel")}>
                  Add channel
                </Button>
              ) : undefined
            }
          >
            Connect an email service or webhook, then choose the events you want
            to receive.
          </Empty>
        ) : (
          <div className="channel-list">
            {channels.data.items.map((channel) => (
              <div className="channel-row" key={channel.id}>
                <span className="channel-icon">
                  {channel.type === "SMTP" ? (
                    <Mail size={20} />
                  ) : (
                    <Webhook size={20} />
                  )}
                </span>
                <div className="grow">
                  <strong>{channel.name}</strong>
                  <span className="subline">
                    {channel.type === "SMTP" ? "Email" : "Webhook"}
                  </span>
                </div>
                <Badge status={channel.enabled ? "ENABLED" : "DISABLED"} />
                {admin && (
                  <div className="button-group">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy || !channel.enabled}
                      onClick={() =>
                        void action(
                          channel.id,
                          `/notification-channels/${channel.id}/test`,
                          "Test notification sent.",
                        )
                      }
                    >
                      {busy === channel.id ? "Working…" : "Send test"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() =>
                        void action(
                          channel.id,
                          `/notification-channels/${channel.id}`,
                          channel.enabled
                            ? "Channel disabled. Pending deliveries cancelled."
                            : "Channel enabled.",
                          { enabled: !channel.enabled },
                        )
                      }
                    >
                      {channel.enabled ? "Disable" : "Enable"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Alert rules</h2>
            <p className="muted">
              Connect the events that matter to the right channels.
            </p>
          </div>
          {admin && (
            <Button
              variant="outline"
              size="sm"
              disabled={
                !channels.data?.items.some((channel) => channel.enabled)
              }
              onClick={() => setModal("rule")}
            >
              <Plus size={16} />
              Add rule
            </Button>
          )}
        </div>
        {rules.data?.items.length ? (
          <div className="rule-list">
            {rules.data.items.map((rule) => (
              <div className="rule-row" key={rule.id}>
                <Bell size={18} className="muted" />
                <div className="grow">
                  <strong>{rule.name}</strong>
                  <p>
                    {rule.config.eventTypes
                      .map((type) => eventNames[type])
                      .join(", ")}{" "}
                    <span className="muted">
                      for{" "}
                      {rule.config.monitorIds.length
                        ? `${rule.config.monitorIds.length} selected monitors`
                        : "all monitors"}
                    </span>
                  </p>
                  <div className="tags">
                    {rule.config.channelIds.map((id) => (
                      <span key={id}>{names[id] ?? "Channel unavailable"}</span>
                    ))}
                  </div>
                </div>
                <Badge status={rule.enabled ? "ENABLED" : "DISABLED"} />
                {admin && (
                  <Button
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() =>
                      void action(
                        rule.id,
                        `/alert-rules/${rule.id}`,
                        rule.enabled ? "Rule disabled." : "Rule enabled.",
                        { enabled: !rule.enabled },
                      )
                    }
                  >
                    {rule.enabled ? "Disable" : "Enable"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="quiet-empty">
            {channels.data?.items.length
              ? "Add a rule to start receiving notifications. Earlier events will not be replayed."
              : "Add a channel first, then create your first alert rule."}
          </p>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Delivery history</h2>
          <span className="muted">Automatic retries, up to 5 attempts</span>
        </div>
        {deliveries.data?.items.length ? (
          <div className="table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Sent / next attempt</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.data.items.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell>
                      {names[delivery.channel_id] ?? "Channel"}
                    </TableCell>
                    <TableCell>
                      <Badge status={delivery.status} />
                    </TableCell>
                    <TableCell>{delivery.attempts} / 5</TableCell>
                    <TableCell>
                      {dateText(delivery.sent_at ?? delivery.next_attempt_at)}
                    </TableCell>
                    <TableCell className="muted">
                      {delivery.last_error
                        ?.replaceAll("_", " ")
                        .toLowerCase() ?? "—"}
                    </TableCell>
                    <TableCell>
                      {admin && delivery.status === "FAILED" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!busy}
                          onClick={() =>
                            void action(
                              delivery.id,
                              `/notification-deliveries/${delivery.id}/retry`,
                              "Delivery queued for retry.",
                            )
                          }
                        >
                          Retry
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="quiet-empty">
            Deliveries appear here when a DNS event matches an alert rule.
          </p>
        )}
        <Pager
          offset={offset}
          count={deliveries.data?.items.length ?? 0}
          change={setOffset}
        />
      </section>
      {modal === "channel" && (
        <ChannelForm
          close={() => setModal("")}
          saved={() => {
            setNotice(
              "Channel added. Create a rule to start receiving alerts.",
            );
            refresh();
          }}
        />
      )}
      {modal === "rule" && (
        <RuleForm
          channels={channels.data?.items ?? []}
          close={() => setModal("")}
          saved={() => {
            setNotice("Alert rule added.");
            refresh();
          }}
        />
      )}
    </>
  );
}
