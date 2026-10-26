// Fake Entra token endpoint + Microsoft Graph for tests, backed by the demo tenant in js/mock.js.
import http from 'node:http';
import { createDemoTenant } from '../js/mock.js';

export const SECRET = 'test-secret';

export function startFakeGraph(port, roles = ['DeviceManagementApps.ReadWrite.All', 'Group.ReadWrite.All', 'DeviceManagementConfiguration.Read.All']) {
  const tenant = createDemoTenant();
  const calls = [];
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(obj == null ? '' : JSON.stringify(obj));
      };
      if (req.url.endsWith('/oauth2/v2.0/token')) {
        const p = new URLSearchParams(body);
        if (p.get('client_secret') !== SECRET) return send(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
        return send(200, { access_token: `h.${b64({ roles, app_displayname: 'Intune App Decommission' })}.s`, expires_in: 3599 });
      }
      if (!/^Bearer h\./.test(req.headers.authorization || '')) return send(401, { error: { code: 'InvalidAuthenticationToken' } });
      if (req.url.startsWith('/v1.0/organization')) {
        return send(200, { value: [{ displayName: 'Contoso', verifiedDomains: [{ name: 'contoso.onmicrosoft.com', isDefault: true }] }] });
      }
      const r = tenant.handle(req.method, 'https://graph.microsoft.com' + req.url, body ? JSON.parse(body) : undefined, req.headers);
      send(r.status, r.body, r.headers);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}
