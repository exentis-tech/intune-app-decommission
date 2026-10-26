# Setup

1. [Register the app in Entra ID](#1-register-the-app-in-entra-id)
2. [Download the tool](#2-download-the-tool)
3. [Create config.json](#3-create-configjson)
4. [Start the server](#4-start-the-server)
5. [First run: dry run](#5-first-run-dry-run)
6. [Going live](#6-going-live)
7. [Troubleshooting](#troubleshooting)

Prerequisites are listed in [REQUIREMENTS.md](REQUIREMENTS.md).

## 1. Register the app in Entra ID

1. Open the **Microsoft Entra admin center** → **Identity** → **Applications** → **App registrations** → **New registration**.
2. **Name:** `Intune App Decommission` · **Supported account types:** *Accounts in this organizational directory only*. Leave **Redirect URI** empty. Click **Register**.
3. On the **Overview** page copy:
   - **Application (client) ID** → `ApplicationId`
   - **Directory (tenant) ID** → `TenantId`
4. **Certificates & secrets** → **Client secrets** → **New client secret**. Pick a short lifetime (e.g. 90 days) and copy the **Value** (not the Secret ID) → `ClientSecret`. It is only shown once.
5. **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**, add:
   - `DeviceManagementApps.ReadWrite.All`
   - `Group.ReadWrite.All` (or `Group.Read.All` if you won't delete groups)
   - `DeviceManagementConfiguration.Read.All` (recommended, for the usage check)
   - `Organization.Read.All` (optional, shows the tenant name)
6. Remove the default delegated `User.Read` if you like — it isn't used.
7. Click **Grant admin consent for <tenant>** and confirm. Every permission must show a green *Granted* status.

> **Least privilege:** start with `Group.Read.All`. You can inspect, remove assignments, delete apps and build the groups ledger. Switch to `Group.ReadWrite.All` only when you're ready to delete groups.

## 2. Download the tool

```powershell
git clone https://github.com/exentis-tech/intune-app-decommission.git C:\Tools\intune-app-decommission
```

Or download the ZIP from GitHub and extract it. If Windows marks the files as downloaded from the internet, unblock them:

```powershell
Get-ChildItem C:\Tools\intune-app-decommission -Recurse | Unblock-File
```

## 3. Create config.json

```powershell
cd C:\Tools\intune-app-decommission
Copy-Item config.example.json config.json
notepad config.json
```

```json
{
  "TenantId": "contoso.onmicrosoft.com",
  "ApplicationId": "00000000-0000-0000-0000-000000000000",
  "ClientSecret": "paste-the-secret-value",
  "GraphBaseUrl": "https://graph.microsoft.com/v1.0",
  "GraphBetaBaseUrl": "https://graph.microsoft.com/beta",
  "ListenPrefix": "http://127.0.0.1:8088/",
  "AllowedOrigin": "",
  "EnableRealDelete": false,
  "RequestTimeoutSeconds": 60,
  "ProxyUrl": "",
  "UseDefaultProxyCredentials": false
}
```

Protect the file — it holds a credential with tenant-wide rights:

```powershell
icacls config.json /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

**Keep the secret out of the file (optional):** remove `ClientSecret` and set it for the session instead:

```powershell
$env:IAD_CLIENT_SECRET = Read-Host 'Client secret' -MaskInput   # PowerShell 7
.\server.ps1
```

**Several tenants:** keep one file per tenant and pass it explicitly:

```powershell
.\server.ps1 -ConfigPath D:\secure\tenant-b.json
```

## 4. Start the server

Double-click **`Start-Decommission.cmd`**, or from a terminal:

```powershell
pwsh ./server.ps1                                     # PowerShell 7
powershell -ExecutionPolicy Bypass -File .\server.ps1  # Windows PowerShell 5.1
```

| Parameter | Meaning |
|---|---|
| `-ConfigPath <file>` | Use another config file (default: `config.json` next to the script) |
| `-NoBrowser` | Don't open the browser automatically |

Check the startup output:

- **Signed in as** — your app registration's name.
- **Permissions** — the application permissions in the token. Lines starting with **Missing** tell you what to add.
- **Real deletes** — `disabled` until you set `EnableRealDelete` to `true`.

Leave the window open while you work; **Ctrl+C** stops the server. Restarting issues a new session token, so reload the browser page afterwards.

## 5. First run: dry run

With `"EnableRealDelete": false` the *Live* switch is greyed out and the server refuses every delete, so you can explore safely:

1. Paste the app names you want to retire and **Search**.
2. Use the result filters (name, version, assignments) to keep the builds you still need out of the selection.
3. **Export inventory CSV** — a record of what exists before you change anything.
4. Run **Remove assignments…** or **Delete apps…** — both are simulated.
5. Open **Groups ledger**, click **Check usage across tenant**, and review which groups would be deleted.

See the [User guide](USER-GUIDE.md) for every screen.

## 6. Going live

1. Stop the server, set `"EnableRealDelete": true`, start it again.
2. In the UI, switch to **Live** and type the first part of your tenant domain.
3. Each live action asks you to type `REMOVE` or `DELETE` and offers a JSON backup of the affected apps and assignments.
4. After each live action the UI goes back to Dry run (can be turned off in the Live dialog).
5. Every live delete is written to `logs/audit-<date>.jsonl`.

When you're done, set `EnableRealDelete` back to `false`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Config file not found` | Copy `config.example.json` to `config.json`, or pass `-ConfigPath`. |
| `config.json: 'ClientSecret' is not set` | The value is empty or still a placeholder (`YOUR_…`, `PASTE_…`). |
| `Token request failed (401) … AADSTS7000215` | Wrong secret — use the secret **Value**, not its ID. |
| `AADSTS7000222` | The secret has expired. Create a new one. |
| `AADSTS700016` | `ApplicationId` not found in that tenant — check `TenantId` and `ApplicationId`. |
| `Missing: DeviceManagementApps.ReadWrite.All` | Permission not added as **Application** permission, or admin consent not granted. Tokens are cached for up to an hour after consent; restart the server. |
| `Could not listen on http://127.0.0.1:8088/ … denied` | See *Listening on 127.0.0.1* in [REQUIREMENTS.md](REQUIREMENTS.md). |
| `Could not listen … in use` | Another instance is running or the port is taken. Change `ListenPrefix`. |
| UI shows *The local server was restarted. Reload the page.* | The session token changed. Reload the browser tab. |
| `RealDeleteDisabled` | Expected while `EnableRealDelete` is `false`. |
| `NotAllowed: Deleting … is not allowed by this tool` | The server only performs three kinds of delete (app, app assignment, group). |
| Group deletion button is disabled | The token has `Group.Read.All`, not `Group.ReadWrite.All`. |
| *Usage check: Remediations (403 no permission)* | `DeviceManagementConfiguration.Read.All` missing, or Remediations not licensed in the tenant. |
| Delete app fails with *dependency or supersedence* | Remove the relationship in the Intune portal first. The tool flags these apps. |
| Group delete fails on an AD group | AD-synced groups are managed on-premises; delete them in Active Directory. |
| Slow on very large tenants | Graph throttling is handled automatically (`Retry-After`); scans of thousands of apps take a few minutes. |
| Corporate proxy | Set `ProxyUrl`, and `UseDefaultProxyCredentials: true` for an authenticating proxy. |
| `Running scripts is disabled on this system` | Use `Start-Decommission.cmd`, or `powershell -ExecutionPolicy Bypass -File .\server.ps1`. |
