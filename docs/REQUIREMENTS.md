# Requirements

## Workstation

| Item | Requirement | Notes |
|---|---|---|
| Operating system | Windows 10 / 11, Windows Server 2016 or later | macOS and Linux work with PowerShell 7 |
| PowerShell | Windows PowerShell **5.1** with .NET Framework **4.7.2+**, or PowerShell **7.2+** | No modules required. Tested with PowerShell 7.4 |
| Browser | Current Microsoft Edge, Google Chrome or Mozilla Firefox | The UI uses modern JavaScript modules |
| Local port | One free TCP port on loopback, `8088` by default | Set with `ListenPrefix` |
| Execution policy | Must allow the script to run | `Start-Decommission.cmd` uses `-ExecutionPolicy Bypass` for this process only |
| Disk | A few MB for the tool, plus the audit log in `logs/` | |

### Windows: listening on 127.0.0.1

`server.ps1` uses `System.Net.HttpListener` (http.sys). On some Windows builds a non-administrator can only listen on `http://localhost:<port>/`. If startup reports *access denied*, either:

- set `"ListenPrefix": "http://localhost:8088/"`, or
- reserve the address once from an elevated prompt (the server prints the exact command):

  ```cmd
  netsh http add urlacl url=http://127.0.0.1:8088/ user=DOMAIN\username
  ```

## Network

Outbound HTTPS (TCP 443) to:

| Host | Purpose |
|---|---|
| `login.microsoftonline.com` | Token requests (client-credentials flow) |
| `graph.microsoft.com` | Microsoft Graph v1.0 and beta |

Through a proxy: set `ProxyUrl`, and `UseDefaultProxyCredentials: true` if the proxy authenticates with your Windows account. For national clouds, set `AuthorityHost`, `GraphBaseUrl` and `GraphBetaBaseUrl` to that cloud's endpoints.

## Microsoft Entra ID

### App registration

- Single-tenant app registration.
- A **client secret** (or provide it at runtime through the `IAD_CLIENT_SECRET` environment variable).
- **Application** permissions on Microsoft Graph, with **admin consent**:

| Permission | Required? | Used for | Graph calls |
|---|---|---|---|
| `DeviceManagementApps.ReadWrite.All` | **Yes** | Apps, versions, assignments; remove assignments; delete apps | `GET /deviceAppManagement/mobileApps…`, `DELETE …/mobileApps/{id}`, `DELETE …/mobileApps/{id}/assignments/{id}` |
| `Group.ReadWrite.All` | To delete groups | Group details, member counts, delete groups | `GET /groups/{id}`, `GET /groups/{id}/members`, `DELETE /groups/{id}` |
| `Group.Read.All` | Alternative | Read-only groups; group deletion is disabled in the UI | |
| `DeviceManagementConfiguration.Read.All` | Recommended | Usage check across policies | `GET /deviceManagement/{deviceConfigurations, configurationPolicies, deviceCompliancePolicies, groupPolicyConfigurations, deviceManagementScripts, deviceHealthScripts}` |
| `Organization.Read.All` | Optional | Tenant domain shown in the UI | `GET /organization` |

The server prints the permissions in its token at every start and the UI disables what isn't granted.

### Roles

| Task | Role |
|---|---|
| Create the app registration and secret | Application Administrator / Cloud Application Administrator (or app owner) |
| Grant admin consent to Graph application permissions | Global Administrator or Privileged Role Administrator |
| Run the tool | Anyone who can read `config.json` — protect it like an admin credential |

Application permissions act tenant-wide and are **not** restricted by Intune RBAC roles or scope tags.

### Licensing

A tenant with Microsoft Intune. The *Remediations* part of the usage check needs the licences Microsoft requires for Remediations (e.g. Windows Enterprise E3/E5); without them that part is reported as skipped.
