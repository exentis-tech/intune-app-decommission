# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-26

### Added
- **Supersedence and dependency handling when deleting apps.** The Delete dialog reads each app's relationships, groups them (between deleted apps / kept app supersedes a deleted one / kept app depends on a deleted one / deleted app points at a kept one), removes the links with `updateRelationships`, then deletes. Dependencies of kept apps require an explicit opt-in. Failed unlinks skip the apps that needed them.
- JSON backup now records every relationship change (`before` / `after`).
- **Analytics tab**: by app (every assignment with intent, include/exclude, group type, users, devices, nested groups, all nested users, filter), by group (everything a group is assigned to, optional tenant-wide scan of apps and policies), group search by name / wildcard / ID, member drill-down through nested groups, copy and CSV export.
- Demo tenant with real supersedence chains, a dependency, and group membership (users, devices, nested groups).

### Security
- New write `POST /deviceAppManagement/mobileApps/{id}/updateRelationships`, gated by `EnableRealDelete` and checked server-side to only **remove** existing links (`OnlyRemovalAllowed` otherwise). Request bodies are written to the audit log.

## [1.0.0] - 2026-10-26

First public release.

### Added
- Bulk app search by many names at once: contains, exact, starts with, wildcard and regex, with exclusions and a list of names that matched nothing.
- Version column (from the app, or from its name when not set) and result filters by name, version (*is*, *contains*, *older than*, *up to*, *newer than*, *from*, *no version*) and assignments. Actions apply only to visible apps.
- Assignment details per app: intent, target type, group, assignment filter.
- Remove assignments by intent, target type and group-name pattern.
- Delete apps, skipping apps with dependency or supersedence relationships.
- Groups ledger: records every group taken off an app, with member counts, group type and sync status; keep / delete / forget; CSV and JSON export, JSON import.
- Usage check across apps, configuration profiles, settings catalog, compliance, administrative templates, platform scripts, remediations and app configuration policies.
- Group deletion that skips AD-synced, in-use, unchecked and dry-run-only groups.
- Dry run by default, typed confirmations, automatic return to dry run, JSON backups, activity log with CSV export.
- `server.ps1`: local backend reading `config.json` (app ID, client secret) with the client-credentials flow; read and write allowlists; `EnableRealDelete` master switch; session token; loopback-only; audit log in `logs/`; proxy support; Windows PowerShell 5.1 and PowerShell 7.
- Demo tenant, light and dark themes, unit tests and end-to-end server tests.
