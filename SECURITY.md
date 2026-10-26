# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead:
**Security** tab → **Report a vulnerability** on this repository.

Include the version, how to reproduce, and the impact you expect. You'll get an acknowledgement within a few days.

## If you leaked a client secret

If `config.json` or a client secret was committed, pasted in an issue, or shared:

1. **Delete the secret** in Entra ID → App registrations → your app → Certificates & secrets.
2. Create a new one and update `config.json`.
3. Review the app's sign-in logs (Entra ID → Sign-in logs → *Service principal sign-ins*) and the Intune / Entra audit logs.
4. Removing the file from Git history is not enough — the secret must be rotated.

How the tool protects its credential is described in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
