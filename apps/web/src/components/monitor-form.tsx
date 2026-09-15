import type { Detail } from "../api";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, message, type Config, type Monitor, type Value } from "../api";
import { ErrorBox, Field, Modal } from "./ui";

export const defaults = {
  intervalSeconds: 300,
  timeoutMs: 3000,
  failureThreshold: 2,
  recoveryThreshold: 1,
  changeThreshold: 2,
};
type Timing = typeof defaults;
export function TimingFields({
  value,
  change,
  watch,
}: {
  value: Timing;
  change: (value: Timing) => void;
  watch: boolean;
}) {
  return (
    <div className="form-grid timings">
      {(
        [
          ["intervalSeconds", "Check interval", "seconds", 604800],
          ["timeoutMs", "Resolver timeout", "milliseconds", 60000],
          [
            "failureThreshold",
            "Failures before alert",
            "consecutive checks",
            1000,
          ],
          [
            "recoveryThreshold",
            "Checks to recover",
            "consecutive checks",
            1000,
          ],
          ...(watch
            ? [
                [
                  "changeThreshold",
                  "Confirm a change",
                  "identical observations",
                  1000,
                ],
              ]
            : []),
        ] as [keyof Timing, string, string, number][]
      ).map(([key, label, hint, max]) => (
        <Field key={key} label={label} hint={hint}>
          <Input
            type="number"
            required
            min={1}
            max={max}
            value={value[key]}
            onChange={(event) =>
              change({ ...value, [key]: Number(event.target.value) })
            }
          />
        </Field>
      ))}
    </div>
  );
}

export function EditTiming({
  monitor,
  close,
  saved,
}: {
  monitor: Monitor;
  close: () => void;
  saved: () => void;
}) {
  const [timing, setTiming] = useState<Timing>({
    intervalSeconds: monitor.config.intervalSeconds,
    timeoutMs: monitor.config.timeoutMs,
    failureThreshold: monitor.config.failureThreshold,
    recoveryThreshold: monitor.config.recoveryThreshold,
    changeThreshold: monitor.config.changeThreshold,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/monitors/${monitor.id}`, { method: "PATCH", body: timing });
      saved();
      close();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Edit timing" close={close}>
      <form onSubmit={submit}>
        <p className="form-intro">
          These settings apply to {monitor.name}. Saving starts a fresh
          confirmation streak.
        </p>
        <ErrorBox error={error} />
        <TimingFields
          value={timing}
          change={setTiming}
          watch={monitor.config.mode === "WATCH"}
        />
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const publicResolvers = [
  { id: "Cloudflare", server: "1.1.1.1" },
  { id: "Google", server: "8.8.8.8" },
  { id: "Quad9", server: "9.9.9.9" },
];
export function CreateMonitor({
  close,
  saved,
  monitor: initialMonitor,
}: {
  monitor?: Detail;
  close: () => void;
  saved: (id: string) => void;
}) {
  const [monitor] = useState(initialMonitor);
  const [name, setName] = useState(monitor?.name ?? "");
  const [hostname, setHostname] = useState(monitor?.config.hostname ?? "");
  const [type, setType] = useState<Config["recordType"]>(
    monitor?.config.recordType ?? "A",
  );
  const [mode, setMode] = useState<Config["mode"]>(
    monitor?.config.mode ?? "WATCH",
  );
  const [expected, setExpected] = useState(
    (monitor?.config.expected ?? [])
      .map((value) =>
        typeof value === "string" ? value : `${value.priority} ${value.host}`,
      )
      .join("\n"),
  );
  const [match, setMatch] = useState<string>(monitor?.config.match ?? "EXACT");
  const [timing, setTiming] = useState<Timing>(
    monitor
      ? {
          intervalSeconds: monitor.config.intervalSeconds,
          timeoutMs: monitor.config.timeoutMs,
          failureThreshold: monitor.config.failureThreshold,
          recoveryThreshold: monitor.config.recoveryThreshold,
          changeThreshold: monitor.config.changeThreshold,
        }
      : defaults,
  );
  const [selected, setSelected] = useState(
    monitor ? [] : publicResolvers.map((item) => item.id),
  );
  const [custom, setCustom] = useState<
    { id: string; server: string; port: number; protocol: string }[]
  >(monitor?.resolvers.map((r) => ({ ...r, port: r.port ?? 53 })) ?? []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const resolvers = [
        ...publicResolvers
          .filter((item) => selected.includes(item.id))
          .map((item) => ({ ...item, protocol: "UDP" })),
        ...custom,
      ];
      if (!resolvers.length) throw new Error("Select at least one resolver.");
      let values: Value[] | undefined;
      if (mode === "EXPECTED") {
        values = expected
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            if (type !== "MX") return type === "TXT" ? line : line.trim();
            const parts = /^(\d+)\s+(\S+)$/.exec(line.trim());
            if (!parts)
              throw new Error(
                "Enter MX records as priority and hostname, for example: 10 mail.example.com",
              );
            return { priority: Number(parts[1]), host: parts[2]! };
          });
        if (!values.length)
          throw new Error("Enter at least one expected record.");
      }
      setBusy(true);
      const result = await api<{ id: string }>(
        monitor ? `/monitors/${monitor.id}` : "/monitors",
        {
          method: monitor ? "PUT" : "POST",
          body: {
            ...(monitor ? { revision: monitor.configRevision } : {}),
            name: name.trim() || hostname,
            config: {
              hostname: hostname.trim(),
              recordType: type,
              mode,
              ...timing,
              resolverIds: resolvers.map((item) => item.id),
              ...(mode === "EXPECTED" ? { expected: values, match } : {}),
            },
            resolvers,
          },
        },
      );
      saved(result.id);
      close();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  const examples = {
    A: "192.0.2.10",
    AAAA: "2001:db8::1",
    CNAME: "target.example.com",
    MX: "10 mail.example.com",
    TXT: "v=spf1 include:example.com -all",
  };
  return (
    <Modal title={monitor ? "Edit monitor" : "Add monitor"} close={close}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {monitor && (
          <p className="form-intro">
            Changing the DNS target, mode, expected records or resolvers resets
            evaluation, closes any open incident and cancels obsolete alerts.
            WATCH learns a new baseline. Name-only changes preserve state.
          </p>
        )}
        <div className="form-grid">
          <Field label="Hostname">
            <Input
              autoFocus
              required
              placeholder="api.example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
            />
          </Field>
          <Field label="Record type">
            <NativeSelect
              value={type}
              onChange={(event) =>
                setType(event.target.value as Config["recordType"])
              }
            >
              {["A", "AAAA", "CNAME", "MX", "TXT"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Field
          label="Display name"
          hint="Optional. The hostname is used when left empty."
        >
          <Input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder="Production API"
          />
        </Field>
        <fieldset>
          <legend>What should this monitor do?</legend>
          <RadioGroup
            className="mode-options grid-cols-1 sm:grid-cols-2 gap-3"
            aria-label="Monitor mode"
            value={mode}
            onValueChange={(value) => setMode(value as Config["mode"])}
          >
            {(["WATCH", "EXPECTED"] as const).map((value) => (
              <label
                className={
                  mode === value ? "mode-option selected" : "mode-option"
                }
                key={value}
              >
                <RadioGroupItem value={value} className="mt-1" />
                <div className="mode-copy">
                  <strong>
                    {value === "WATCH"
                      ? "Watch for changes"
                      : "Match expected values"}
                  </strong>
                  <p>
                    {value === "WATCH"
                      ? "Learn a baseline and notify when records change."
                      : "Open an incident when records differ from your expectation."}
                  </p>
                </div>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        {mode === "EXPECTED" && (
          <>
            <Field
              label="Expected records"
              hint={
                type === "MX"
                  ? "One record per line: priority followed by hostname."
                  : "One record per line. TXT case and whitespace are preserved."
              }
            >
              <Textarea
                required
                rows={3}
                value={expected}
                placeholder={examples[type]}
                onChange={(event) => setExpected(event.target.value)}
              />
            </Field>
            <Field label="Matching policy">
              <NativeSelect
                value={match}
                onChange={(event) => setMatch(event.target.value)}
              >
                <option value="EXACT">Exactly these records</option>
                <option value="CONTAINS">Must include these records</option>
              </NativeSelect>
            </Field>
          </>
        )}
        <fieldset>
          <legend>Resolvers</legend>
          <div className="resolver-options">
            {publicResolvers.map((item) => (
              <label key={item.id}>
                <Checkbox
                  checked={selected.includes(item.id)}
                  onCheckedChange={() =>
                    setSelected((values) =>
                      values.includes(item.id)
                        ? values.filter((id) => id !== item.id)
                        : [...values, item.id],
                    )
                  }
                />
                <span>
                  {item.id}
                  <small>{item.server}</small>
                </span>
              </label>
            ))}
          </div>
          {custom.map((item, index) => (
            <div className="custom-resolver" key={index}>
              <Field label="Resolver name">
                <Input
                  required
                  value={item.id}
                  onChange={(event) =>
                    setCustom((items) =>
                      items.map((value, i) =>
                        i === index
                          ? { ...value, id: event.target.value }
                          : value,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="IP address">
                <Input
                  required
                  placeholder="10.0.0.53"
                  value={item.server}
                  onChange={(event) =>
                    setCustom((items) =>
                      items.map((value, i) =>
                        i === index
                          ? { ...value, server: event.target.value }
                          : value,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  value={item.port}
                  onChange={(event) =>
                    setCustom((items) =>
                      items.map((value, i) =>
                        i === index
                          ? { ...value, port: Number(event.target.value) }
                          : value,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Protocol">
                <NativeSelect
                  value={item.protocol}
                  onChange={(event) =>
                    setCustom((items) =>
                      items.map((value, i) =>
                        i === index
                          ? { ...value, protocol: event.target.value }
                          : value,
                      ),
                    )
                  }
                >
                  <option>UDP</option>
                  <option>TCP</option>
                </NativeSelect>
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${item.id}`}
                onClick={() =>
                  setCustom((items) => items.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            disabled={custom.length + selected.length >= 16}
            onClick={() =>
              setCustom((items) => [
                ...items,
                {
                  id: `Custom ${items.length + 1}`,
                  server: "",
                  port: 53,
                  protocol: "UDP",
                },
              ])
            }
          >
            <Plus size={15} />
            Add custom resolver
          </Button>
          <p className="hint">
            A strict majority must agree. With two resolvers, both must agree.
          </p>
        </fieldset>
        <fieldset>
          <legend>Timing and confirmation</legend>
          <TimingFields
            value={timing}
            change={setTiming}
            watch={mode === "WATCH"}
          />
        </fieldset>
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : monitor ? "Save monitor" : "Add monitor"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
