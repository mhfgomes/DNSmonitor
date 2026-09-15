# Browser account setup and password changes

A fresh installation can create its first administrator in the browser. It requires a deployment-controlled installation token, so the first visitor cannot claim a publicly reachable server. Setup is available only while the users table is empty. It cannot overwrite an existing account or act as password recovery.

## Docker Compose

Generate a token locally:

```sh
openssl rand -hex 24
```

Put the result in `SETUP_TOKEN` in your private `.env`, then start or recreate the app with `docker compose up -d --wait`. Open the application and enter the installation token, administrator email and password. Passwords must contain 12–256 characters. After setup, sign in normally. Remove `SETUP_TOKEN` from the deployment and recreate the app; the account remains in MariaDB.

An empty or unset token disables browser setup. Direct deployments also accept `SETUP_TOKEN_FILE`; configure either the value or file, not both. Tokens must contain 32–256 characters. Use HTTPS for a public deployment, with the matching `PUBLIC_URL` and secure cookies.

## Swarm

Create the external secret from a private file, then apply the optional overlay:

```sh
docker secret create dnsmonitor_setup_token /path/to/private/setup-token
# Keep the same image, URL and replica environment used by your installation.
docker stack deploy -c deploy/swarm/stack.yaml -c deploy/swarm/setup.yaml dnsmonitor
```

The app mounts the secret as `/run/secrets/setup-token`, readable only by its runtime user. After setup, deploy just `stack.yaml` to remove the mount, then remove the unused secret. `SETUP_TOKEN_SECRET` can select a versioned secret name. Keep your normal registry authentication option when deploying private images.

## Kubernetes / Helm

Include a `setup-token` key in the existing application Secret on first installation, along with the documented database and encryption keys. The key is optional for existing installations. For example, add `--from-file=setup-token=/path/to/private/setup-token` to the Secret creation command in the deployment guide. Helm reads it through an optional Secret key reference in the app environment.

If you add the token after pods have started, restart the app Deployment to load it. After setup, remove just that key from your Secret and restart the app again. Preserve the database password and encryption key. Do not place the token in Helm values or Git.

## Change your password

Sign in, open **Account**, and enter your current password, new password and confirmation. Administrators and viewers can change their own passwords. A successful change revokes every session, including the current one, and returns you to sign-in. No other account is modified.

If you have lost your password, a deployment operator can still use the existing CLI admin reset procedure in [API setup](API.md). Browser setup stays closed when any account exists, including if no administrator remains. There is no email-reset service in this release.

## API and concurrency

- `GET /api/v1/auth/setup`: public setup status (`required`, `enabled`); never returns the token.
- `POST /api/v1/auth/setup`: `{email,password,token}`; creates one administrator and returns 201, or 409 when an account already exists. Requires the installation token and honors the normal Origin check. Persistent per-IP attempt limits apply.
- `POST /api/v1/auth/password`: `{currentPassword,newPassword}`; authenticated and CSRF protected, with per-user/IP attempt limits and bounded hashing concurrency. Returns 204 and clears the session cookie after revoking all sessions. Incorrect current passwords return 400 without signing out the caller.

Setup and CLI administrator provisioning share a database advisory lock, so simultaneous API replicas cannot create multiple initial administrators. Account writes and audit records are transactional. Password changes recheck both the credential hash and session under a user-row lock, preventing a concurrent reset or revoked session from overwriting a newer password. Existing password hashing, login limits and session protections remain in effect.

No database schema change is needed. Manually emptying the users table can reopen setup if the token is still configured; remove the token after installation and keep deployment configuration private.
