# Contributing

Thanks for helping! Bug reports, ideas and pull requests are welcome.

## Ground rules

- **Never** include a tenant ID, client secret, `config.json`, real app or group names, or audit logs in issues or pull requests. Use the demo tenant or redact.
- Keep the tool dependency-free: one PowerShell script, plain HTML/CSS/JavaScript, no build step.
- Safety first. Any new write operation must go through `Graph.mutate()` (dry-run gate) in the UI **and** be added explicitly to the server's write allowlist, with tests.
- `server.ps1` must keep working on Windows PowerShell 5.1: no `??`, ternaries, `-AsHashtable` or other PowerShell 7-only syntax.

## Development

```bash
# UI with the built-in demo tenant (no Microsoft tenant needed)
python3 -m http.server 8080        # then open http://localhost:8080 → "Try the demo tenant"

# Unit tests (matching, versions, assignments)
npm test

# End-to-end tests of server.ps1 against a fake Graph (needs pwsh, or PWSH=powershell on Windows)
npm run test:server
```

## Project layout

| Path | What it is |
|---|---|
| `server.ps1` | Local backend: config, app-only token, Graph proxy, allowlists, audit log |
| `js/app.js` | UI workflows and rendering |
| `js/intune.js` | Matching, versions, assignments, groups, usage scan |
| `js/graph.js` | Graph client: retries, paging, `$batch`, dry-run gate |
| `js/auth.js` | Optional delegated sign-in (PKCE) |
| `js/mock.js` | Demo tenant, also used by the tests |
| `tests/` | Unit and end-to-end tests |
| `docs/` | Documentation and screenshots |

## Pull requests

1. Fork, create a branch, make your change.
2. Run `npm test` and `npm run test:server`.
3. Update the docs and `CHANGELOG.md` if behaviour changes.
4. Open the PR and describe what you tested (demo tenant, test tenant, PowerShell version).
