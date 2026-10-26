# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
