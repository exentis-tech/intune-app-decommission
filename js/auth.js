// Minimal OAuth 2.0 authorization-code + PKCE client for Microsoft Entra ID.
// No third-party dependencies. Tokens live in sessionStorage and die with the tab.
//
// The app registration must use the "Single-page application" platform with this
// page's URL as redirect URI (see README).

const AUTH_KEY = 'iad.auth';
const PENDING_KEY = 'iad.auth.pending';
const CONFIG_KEY = 'iad.config';

export const GRAPH = 'https://graph.microsoft.com';

export function buildScopes(opts) {
  const s = ['openid', 'profile', 'offline_access', `${GRAPH}/DeviceManagementApps.ReadWrite.All`];
  s.push(opts.allowGroupDelete ? `${GRAPH}/Group.ReadWrite.All` : `${GRAPH}/Group.Read.All`);
  if (opts.policyScan) s.push(`${GRAPH}/DeviceManagementConfiguration.Read.All`);
  return s.join(' ');
}

export function loadConfig() {
  try {
    return Object.assign(
      { clientId: '', tenantId: 'organizations', allowGroupDelete: true, policyScan: true },
      JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')
    );
  } catch {
    return { clientId: '', tenantId: 'organizations', allowGroupDelete: true, policyScan: true };
  }
}

export function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* storage blocked */ }
}

function redirectUri() {
  return location.origin + location.pathname;
}

function b64url(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(n = 48) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return new Uint8Array(buf);
}

function decodeJwt(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(part).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function authority(tenantId) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId || 'organizations')}/oauth2/v2.0`;
}

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
}

function writeSession(s) {
  if (s) sessionStorage.setItem(AUTH_KEY, JSON.stringify(s));
  else sessionStorage.removeItem(AUTH_KEY);
}

export async function login(cfg) {
  if (!window.isSecureContext) throw new Error('Sign-in needs HTTPS or http://localhost.');
  const verifier = randomString(64);
  const challenge = b64url(await sha256(verifier));
  const state = randomString(24);
  const scope = buildScopes(cfg);
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, scope, cfg }));
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  location.assign(`${authority(cfg.tenantId)}/authorize?${p}`);
}

// Call once on page load. Returns the session (or null) and throws on auth errors.
export async function handleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (!code && !err) return readSession();

  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
  sessionStorage.removeItem(PENDING_KEY);
  history.replaceState(null, '', redirectUri());

  if (err) {
    throw new Error(`${err}: ${url.searchParams.get('error_description') || ''}`.trim());
  }
  if (!pending || pending.state !== url.searchParams.get('state')) {
    throw new Error('Sign-in response did not match this browser session. Please sign in again.');
  }
  const body = new URLSearchParams({
    client_id: pending.cfg.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
    scope: pending.scope,
  });
  const tok = await tokenRequest(pending.cfg.tenantId, body);
  const session = toSession(tok, pending.cfg, pending.scope);
  writeSession(session);
  return session;
}

async function tokenRequest(tenantId, body) {
  const res = await fetch(`${authority(tenantId)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `Token request failed (${res.status})`);
  return json;
}

function toSession(tok, cfg, scope, prev) {
  const claims = tok.id_token ? decodeJwt(tok.id_token) : (prev ? prev.claims : {});
  const access = decodeJwt(tok.access_token);
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || (prev && prev.refreshToken),
    expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
    scope,
    grantedScopes: access.scp || '',
    cfg,
    claims: {
      name: claims.name || access.name || '',
      upn: claims.preferred_username || access.upn || access.unique_name || '',
      tid: claims.tid || access.tid || '',
    },
  };
}

export async function getAccessToken() {
  const s = readSession();
  if (!s) throw new Error('Not signed in.');
  if (s.expiresAt - Date.now() > 120000) return s.accessToken;
  if (!s.refreshToken) throw new Error('Session expired. Please sign in again.');
  const body = new URLSearchParams({
    client_id: s.cfg.clientId,
    grant_type: 'refresh_token',
    refresh_token: s.refreshToken,
    scope: s.scope,
  });
  try {
    const tok = await tokenRequest(s.cfg.tenantId, body);
    const next = toSession(tok, s.cfg, s.scope, s);
    writeSession(next);
    return next.accessToken;
  } catch (e) {
    writeSession(null);
    throw new Error('Session expired. Please sign in again. (' + e.message + ')');
  }
}

export function currentSession() {
  return readSession();
}

export function logout() {
  const s = readSession();
  writeSession(null);
  if (s) {
    const p = new URLSearchParams({ post_logout_redirect_uri: redirectUri() });
    location.assign(`${authority(s.cfg.tenantId)}/logout?${p}`);
  } else {
    location.reload();
  }
}
