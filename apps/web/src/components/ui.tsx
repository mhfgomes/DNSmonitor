import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Badge as StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, type ReactNode } from "react";
import { X, Network } from "lucide-react";
import { valueText, type Value } from "../api";

export function Brand() {
  return (
    <a href="#/monitors" className="brand">
      <span className="brand-mark">
        <Network size={22} aria-hidden="true" />
      </span>
      <span>DNSmonitor</span>
    </a>
  );
}
export function Badge({ status }: { status: string }) {
  return (
    <StatusBadge variant="outline" className={`badge ${status.toLowerCase()}`}>
      <span className="status-dot" />
      {status.toLowerCase().replaceAll("_", " ")}
    </StatusBadge>
  );
}
export function ErrorBox({ error }: { error?: string }) {
  return error ? (
    <div className="error-box" role="alert">
      {error}
    </div>
  ) : null;
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Network size={30} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Values({
  values,
  empty = "No answer available",
}: {
  values?: Value[] | null;
  empty?: string;
}) {
  return values?.length ? (
    <div className="values">
      {values.map((value, index) => (
        <code key={index}>{valueText(value)}</code>
      ))}
    </div>
  ) : (
    <span className="muted">{empty}</span>
  );
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const previous = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(
    () => () => {
      const element = previous.current;
      if (element instanceof HTMLElement && element.isConnected)
        element.focus();
    },
    [],
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="app-dialog"
        showCloseButton={false}
        finalFocus={previous}
      >
        <DialogHeader className="dialog-heading flex-row items-center justify-between">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose
            render={
              <Button variant="ghost" size="icon" aria-label="Close dialog" />
            }
          >
            <X size={20} />
          </DialogClose>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Pager({
  offset,
  count,
  total,
  change,
}: {
  offset: number;
  count: number;
  total?: number;
  change: (value: number) => void;
}) {
  return (
    <div className="pager">
      <span>
        {count ? `${offset + 1}–${offset + count}` : "0"}
        {total !== undefined ? ` of ${total}` : ""}
      </span>
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => change(Math.max(0, offset - 50))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={total !== undefined ? offset + count >= total : count < 50}
          onClick={() => change(offset + 50)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
