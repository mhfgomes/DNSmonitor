import { AccountPage } from "./components/account";
import { OperationsPage } from "./components/operations";
import { ThemeProvider, ThemeControl } from "./theme";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bell,
  LogOut,
  ShieldAlert,
  Radio,
  HeartPulse,
  UserRound,
} from "lucide-react";
import { api, message, setCsrf, type Identity } from "./api";
import { Brand, ErrorBox, Field } from "./components/ui";
import { Monitors, MonitorDetails } from "./components/monitors";
import { NotificationsPage } from "./components/notifications";
import { Incidents } from "./components/incidents";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";

function Login({
  signedIn,
  notice,
}: {
  signedIn: (identity: Identity) => void;
  notice: string;
}) {
  const [setup, setSetup] = useState<{ required: boolean; enabled: boolean }>();
  const [token, setToken] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [created, setCreated] = useState(false);
  useEffect(() => {
    void api<{ required: boolean; enabled: boolean }>("/auth/setup")
      .then(setSetup)
      .catch(() =>
        setError("Could not check installation status. Refresh to try again."),
      );
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (setup?.required) {
        if (password !== confirmation)
          throw new Error("Passwords do not match");
        await api("/auth/setup", {
          method: "POST",
          body: { email, password, token },
        });
        setSetup({ required: false, enabled: false });
        setPassword("");
        setToken("");
        setConfirmation("");
        setCreated(true);
        return;
      }
      const identity = await api<Identity>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setPassword("");
      signedIn(identity);
    } catch (error) {
      if (setup?.required)
        void api<{ required: boolean; enabled: boolean }>("/auth/setup")
          .then(setSetup)
          .catch(() => undefined);
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-brand">
        <Brand />
        <ThemeControl />
      </div>
      <main className="login-layout">
        <div className="login-story">
          <div className="dns-diagram" aria-hidden="true">
            <span>Cloudflare</span>
            <span>Google</span>
            <span>Quad9</span>
            <i />
            <strong>One clear view of your DNS.</strong>
          </div>
          <h1>
            Know when your
            <br />
            DNS changes.
          </h1>
          <p>
            Watch your records. Compare answers. Keep unexpected changes in
            sight.
          </p>
        </div>
        <section className="login-form">
          <h2>
            {setup?.required ? "Create your administrator" : "Welcome back"}
          </h2>
          <p>
            {setup?.required
              ? "Set up the first account for this installation."
              : "Sign in to your DNSmonitor workspace."}
          </p>
          {(created || notice) && (
            <p role="status">
              {created ? "Administrator created. Sign in to continue." : notice}
            </p>
          )}
          {setup?.required && !setup.enabled && (
            <p role="status">
              Browser setup is not enabled. Configure an installation token in
              your deployment to continue.
            </p>
          )}
          <form onSubmit={submit}>
            <ErrorBox error={error} />
            <Field label="Email address">
              <Input
                autoFocus
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete={
                  setup?.required ? "new-password" : "current-password"
                }
                minLength={setup?.required ? 12 : undefined}
                required
                maxLength={256}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {setup?.required && (
              <>
                <Field label="Confirm password">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={256}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </Field>
                <Field label="Installation token">
                  <Input
                    type="password"
                    autoComplete="off"
                    required
                    maxLength={256}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </Field>
                <p className="text-sm text-muted-foreground mb-4">
                  Use at least 12 characters for your password. The installation
                  token is supplied by the person deploying this server.
                </p>
              </>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={busy || !setup || (setup.required && !setup.enabled)}
            >
              {busy
                ? "Please wait…"
                : setup?.required
                  ? "Create administrator"
                  : "Sign in"}
            </Button>
          </form>
          <details className="setup-help">
            <summary>First installation or need an account?</summary>
            <p>
              An administrator can create or reset your account with the admin
              command. See the account setup instructions in{" "}
              <code>docs/API.md</code> in your installation.
            </p>
          </details>
        </section>
      </main>
      <footer className="login-footer">
        Self-hosted DNS monitoring. Your records, your infrastructure.
      </footer>
    </div>
  );
}

function App() {
  const [notice, setNotice] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(
    window.location.hash.slice(1) || "/monitors",
  );
  const signIn = (identity: Identity) => {
    setNotice("");
    setCsrf(identity.csrfToken);
    setIdentity(identity);
    setError("");
  };
  useEffect(() => {
    const change = () => setRoute(window.location.hash.slice(1) || "/monitors");
    const expired = () => {
      setIdentity(null);
      setCsrf("");
    };
    window.addEventListener("hashchange", change);
    window.addEventListener("session-expired", expired);
    void api<Identity>("/auth/session")
      .then(signIn)
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => {
      window.removeEventListener("hashchange", change);
      window.removeEventListener("session-expired", expired);
    };
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route]);
  if (loading)
    return (
      <div className="boot">
        <Brand />
        <p>Connecting to your workspace…</p>
      </div>
    );
  if (!identity) return <Login signedIn={signIn} notice={notice} />;
  const admin = identity.role === "ADMIN";
  const detail = /^\/monitors\/([a-f0-9-]+)$/.exec(route);
  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
      setIdentity(null);
      setCsrf("");
    } catch (error) {
      setError(message(error));
    }
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">
          <Radio size={14} />
          <span>Your workspace</span>
        </div>
        <nav aria-label="Main navigation">
          {[
            { path: "/monitors", label: "Monitors", Icon: Activity },
            { path: "/incidents", label: "Incidents", Icon: ShieldAlert },
            { path: "/notifications", label: "Notifications", Icon: Bell },
            { path: "/system", label: "System health", Icon: HeartPulse },
            { path: "/account", label: "Account", Icon: UserRound },
          ].map(({ path, label, Icon }) => (
            <a
              href={`#${path}`}
              key={path}
              className={route.startsWith(path) ? "active" : ""}
              aria-current={route.startsWith(path) ? "page" : undefined}
            >
              <Icon size={18} />
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="account-email" title={identity.email}>
            {identity.email}
          </span>
          <span className="account-role">{identity.role.toLowerCase()}</span>
          <Button variant="ghost" onClick={() => void logout()}>
            <LogOut size={16} />
            Sign out
          </Button>
        </div>
      </aside>
      <main className="main-content">
        <div className="topline">
          <span>DNS monitoring</span>
          <div className="flex items-center gap-4">
            <span className="hidden sm:inline">Updates every 10 seconds</span>
            <ThemeControl />
          </div>
        </div>
        <ErrorBox error={error} />
        {detail ? (
          <MonitorDetails key={detail[1]} id={detail[1]!} admin={admin} />
        ) : route === "/account" ? (
          <AccountPage
            email={identity.email}
            changed={() => {
              setIdentity(null);
              setCsrf("");
              setNotice("Password changed. Sign in with your new password.");
            }}
          />
        ) : route === "/system" ? (
          <OperationsPage />
        ) : route === "/incidents" ? (
          <Incidents admin={admin} />
        ) : route === "/notifications" ? (
          <NotificationsPage admin={admin} />
        ) : (
          <Monitors admin={admin} />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
