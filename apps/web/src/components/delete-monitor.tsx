import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { api, message, type Detail } from "../api";
import { Modal, ErrorBox, Field } from "./ui";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
export function DeleteMonitor({
  monitor: initialMonitor,
  close,
}: {
  monitor: Detail;
  close: () => void;
}) {
  const [monitor] = useState(initialMonitor);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/monitors/${monitor.id}`, {
        method: "DELETE",
        body: { revision: monitor.configRevision, confirmName: name },
      });
      window.location.hash = "/monitors";
      close();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Delete monitor" close={close}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <p className="form-intro">
          Permanently delete <strong>{monitor.name}</strong>, its checks,
          archived history, incidents and notification history. Pending alerts
          will be removed. Alert rules targeting only this monitor will also be
          removed. Notifications already being sent cannot be recalled.
        </p>
        <Field label="Monitor name to confirm">
          <Input
            autoFocus
            required
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="form-actions">
          <Button variant="outline" type="button" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={busy || name !== monitor.name}
          >
            <Trash2 size={16} />
            {busy ? "Deleting…" : "Delete permanently"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
