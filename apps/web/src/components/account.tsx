import { useState, useEffect, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { api, message } from "../api";
import { ErrorBox, Field } from "./ui";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
export function AccountPage({
  email,
  changed,
}: {
  email: string;
  changed: () => void;
}) {
  const [version, setVersion] = useState<{
    version: string;
    revision: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void api<{ version: string; revision: string }>("/version", {
      signal: controller.signal,
    })
      .then(setVersion)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmation) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      setCurrent("");
      setNew("");
      setConfirmation("");
      changed();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Account</h1>
          <p>{email}</p>
        </div>
      </header>
      {version && (
        <p className="text-sm text-muted-foreground mb-6">
          DNSmonitor v{version.version}
          {version.revision !== "unknown"
            ? ` · Build ${version.revision.slice(0, 12)}`
            : " · Local build"}
        </p>
      )}
      <section className="panel p-6 max-w-xl">
        <h2 className="text-lg font-semibold flex gap-2 items-center mb-2">
          <LockKeyhole size={18} />
          Change password
        </h2>
        <p className="text-sm text-muted-foreground mb-6">
          Use at least 12 characters. Changing your password signs you out on
          every device.
        </p>
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <Field label="Current password">
            <Input
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password">
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={256}
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={256}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Changing password…" : "Change password"}
          </Button>
        </form>
      </section>
    </>
  );
}
