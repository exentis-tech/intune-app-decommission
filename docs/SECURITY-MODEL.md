# Security model

The tool holds a credential with tenant-wide rights over Intune apps and Entra ID groups. This page explains how it is contained.

## Architecture

```
┌──────────────┐  same origin, X-IAD-Session  ┌───────────────────────────┐  Bearer (app-only)  ┌─────────────────┐
│  Browser UI  │ ───────────────────────────► │ server.ps1 (127.0.0.1)    │ ──────────────────► │ Microsoft Graph │
│  index.html  │ ◄─────────────────────────── │ · config.json             │ ◄────────────────── │                 │
│  js/*.js     │                              │ · token cache (memory)    │                     └─────────────────┘
└──────────────┘                              │ · allowlists, write gate  │  client credentials ┌─────────────────┐
                                              │ · logs/audit-*.jsonl      │ ──────────────────► │ Entra ID token  │
                                              └───────────────────────────┘                     └─────────────────┘
```

- `server.ps1` reads `config.json`, requests an app-only token (`client_credentials`, scope `https://graph.microsoft.com/.default`) and keeps it in memory, refreshing it before it expires.
- The browser never receives the client secret or the Graph token. It calls `/graph/beta/...` and `/graph/v1.0/...` on the local server, which validates and forwards each request.
- The UI is plain HTML, CSS and JavaScript with no third-party code, served with a strict Content Security Policy.

## Controls enforced by the server

These hold even if someone edits the UI or calls the local API directly.

| Control | Detail |
|---|---|
| Loopback only | `ListenPrefix` must be `127.0.0.1`, `localhost` or `::1`; anything else stops the server at startup. |
| Host check | Requests with an unexpected `Host` header are rejected (DNS-rebinding protection). |
| Origin check | Requests carrying a foreign `Origin` are rejected. `AllowedOrigin: "*"` is ignored; only an exact origin can be allowed. |
| Session token | A random 256-bit token is created at each start. Every `/graph/*` call must send it in `X-IAD-Session`. Other websites can't read it (same-origin policy, no CORS). |
| Read allowlist | `GET` only under `/deviceAppManagement`, `/deviceManagement`, `/groups`, `/organization`. Users, mail, files, etc. are refused. |
| `$batch` | Allowed only when every sub-request is a `GET` inside the read allowlist. |
| Write allowlist | Exactly three operations: `DELETE /deviceAppManagement/mobileApps/{id}`, `DELETE /deviceAppManagement/mobileApps/{id}/assignments/{id}`, `DELETE /groups/{id}`. `POST`, `PATCH`, `PUT` and every other `DELETE` are refused. |
| Master switch | `EnableRealDelete: false` refuses all deletes. |
| Audit log | Every delete attempt — success, failure or blocked — is appended to `logs/audit-<date>.jsonl`. |
| Static files | Only `index.html`, `css/*.css`, `js/*.js` and `docs/*.png|svg` are served; `config.json`, scripts and logs never are. Paths are resolved and checked against the tool folder. |
| Response headers | `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. |

## Controls in the UI

- Dry run by default; Live requires typing the tenant name; automatic return to Dry run after each live action.
- Typed confirmation (`REMOVE` / `DELETE`) and optional JSON backup before every live action.
- Groups are only recorded, never deleted as a side effect of deleting apps or removing assignments.
- Group deletion skips AD-synced groups, groups still in use, groups not yet checked, and groups recorded only in a dry run.
- Actions only apply to apps visible after filtering.
- CSV exports neutralise spreadsheet formulas.

## Your responsibilities

- **Protect `config.json`.** Store it on an admin workstation, restrict its ACL, never commit or share it (`.gitignore` already excludes it). Prefer `IAD_CLIENT_SECRET` over storing the secret on disk.
- **Short secret lifetime**, and rotate it immediately if it may have leaked.
- **Least privilege.** Use `Group.Read.All` until you actually need to delete groups. Remove permissions you no longer need.
- **Application permissions bypass Intune RBAC and scope tags.** Anyone who can run the tool with your `config.json` can act on every app and group in the tenant. Consider a dedicated app registration per operator and Conditional Access for workload identities where licensed.
- **Stop the server** when you're done, and set `EnableRealDelete` back to `false`.
- **Review the audit log** and keep it with your change records.

## Optional delegated mode

If the static files are hosted without `server.ps1`, the UI offers interactive sign-in (authorization code + PKCE) with a *Single-page application* registration and **delegated** permissions. Tokens then live in the browser tab's `sessionStorage`, are limited by the signed-in admin's own roles, and no secret exists. The server-side allowlists don't apply in that mode; the UI controls do.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
