import * as auth from './auth.js';
import { Graph, pool } from './graph.js';
import * as I from './intune.js';
import { createDemoTenant } from './mock.js';
import { Analytics } from './analytics.js';

const VERSION = '1.1.0';
const TOOL = 'intune-app-decommission';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const fmtDate = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '');
const fmtTime = iso => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 3500);
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function csv(rows) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
}

// ---------- state ----------
const S = {
  demo: null,
  backend: null,
  claims: null,
  grantedScopes: '',
  graph: null,
  dry: true,
  autoDry: true,
  busy: false,
  catalog: null,
  catalogAt: null,
  query: null,
  results: [],
  unmatched: [],
  selected: new Set(),
  expanded: new Set(),
  appState: new Map(),
  groups: new Map(),
  ledger: new Map(),
  runs: [],
  gSelected: new Set(),
  usage: null,
  log: [],
  tab: 'apps',
};

const storeKey = () => `iad.ledger.${S.claims && S.claims.tid}`;
const canPersist = () => !S.demo && S.claims && S.claims.tid && S.claims.tid !== 'demo';

function loadLedger() {
  S.ledger = new Map();
  S.runs = [];
  if (!canPersist()) return;
  try {
    const data = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (!data) return;
    for (const e of data.entries || []) S.ledger.set(e.id, e);
    S.runs = data.runs || [];
  } catch { /* corrupt or blocked storage: start clean */ }
}

function saveLedger() {
  updateCounts();
  if (!canPersist()) return;
  const entries = [...S.ledger.values()]
    .filter(e => e.origin === 'live')
    .map(e => ({ ...e, sources: e.sources.filter(s => s.mode === 'LIVE'), simulated: undefined }));
  const runIds = new Set(entries.flatMap(e => e.sources.map(s => s.runId)));
  try {
    localStorage.setItem(storeKey(), JSON.stringify({
      tool: TOOL, version: VERSION, savedAt: new Date().toISOString(),
      runs: S.runs.filter(r => runIds.has(r.id)), entries,
    }));
  } catch (e) {
    toast('Could not save the ledger in this browser: ' + e.message, true);
  }
}

// ---------- boot ----------
async function init() {
  for (const sel of ['#matchMode', '#gMode']) {
    $(sel).innerHTML = Object.entries(I.MATCH_MODES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  }
  $('#gMode').value = 'wildcard';
  $('#rVerOp').innerHTML = Object.entries(I.VERSION_OPS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#redirectUri').textContent = location.origin + location.pathname;
  const cfg = auth.loadConfig();
  const f = $('#connectForm');
  f.clientId.value = cfg.clientId || '';
  f.tenantId.value = cfg.tenantId && cfg.tenantId !== 'organizations' ? cfg.tenantId : '';
  f.allowGroupDelete.checked = !!cfg.allowGroupDelete;
  f.policyScan.checked = !!cfg.policyScan;
  bind();

  // Served by server.ps1? Then the app registration in config.json signs in for us.
  const backend = await detectBackend();
  if (backend) {
    const label = backend.tenantLabel || backend.tenantId;
    return startSession(
      { name: backend.appDisplayName || 'App registration', upn: label, tid: backend.tenantId, appId: backend.applicationId },
      (backend.roles || []).join(' '),
      null,
      backend
    );
  }

  try {
    const session = await auth.handleRedirect();
    if (session) return startSession(session.claims, session.grantedScopes, null);
  } catch (e) {
    showConnect(e.message);
    return;
  }
  showConnect();
}

async function detectBackend() {
  if (location.protocol === 'file:') return null;
  try {
    const res = await fetch('api/session', { cache: 'no-store' });
    if (!res.ok) {
      if (res.headers.get('content-type')?.includes('json')) {
        const j = await res.json().catch(() => null);
        if (j && j.error) showConnect(`Local server: ${j.error.message}`);
      }
      return null;
    }
    const j = await res.json();
    return j && j.mode === 'app' && j.sessionToken ? j : null;
  } catch {
    return null;
  }
}

function tenantDomain() {
  if (S.demo) return 'contoso-demo.onmicrosoft.com';
  if (S.backend) return S.claims.upn;
  return S.claims.upn.split('@')[1] || 'your tenant';
}

function showConnect(error) {
  $('#connect').hidden = false;
  $('#workspace').hidden = true;
  $('#modeSwitch').hidden = true;
  const el = $('#connectError');
  el.hidden = !error;
  el.textContent = error || '';
}

function startSession(claims, grantedScopes, demo, backend) {
  S.demo = demo;
  S.backend = backend || null;
  S.claims = claims;
  S.grantedScopes = grantedScopes || '';
  S.graph = new Graph({
    getToken: auth.getAccessToken,
    mock: demo,
    backend: S.backend,
    isDryRun: () => S.dry,
    onWrite: logWrite,
  });
  loadLedger();
  $('#connect').hidden = true;
  $('#workspace').hidden = false;
  $('#modeSwitch').hidden = false;
  const banner = $('#demoBanner');
  const locked = liveLocked();
  banner.hidden = !demo && !locked;
  if (locked) banner.textContent = 'Dry run only — EnableRealDelete is false in config.json, so the local server refuses every delete. Set it to true and restart the server to allow live actions.';
  const liveBtn = $('#modeSwitch [data-mode=live]');
  liveBtn.disabled = locked;
  liveBtn.title = locked ? 'Disabled by EnableRealDelete=false in config.json' : '';
  if (S.backend) {
    $('#who').innerHTML = `<span title="Application ID ${esc(claims.appId)}"><b>${esc(claims.name)}</b> · app-only · ${esc(claims.upn)}</span>`;
  } else {
    $('#who').innerHTML = `<span><b>${esc(claims.name || 'Signed in')}</b> · ${esc(claims.upn)}</span>
      <button class="btn small ghost" id="signOut">${demo ? 'Leave demo' : 'Sign out'}</button>`;
    $('#signOut').onclick = () => (demo ? location.reload() : auth.logout());
  }
  setMode('dry', true);
  S.analytics = new Analytics($('#tab-analytics'), {
    graph: () => S.graph,
    visibleApps: () => (S.query ? visibleResults().filter(a => !isGone(a)) : []),
    ensureCatalog: () => ensureCatalog(false),
    groupsCache: S.groups,
    canScanPolicies,
    toast, download, csv, esc, plural, stamp,
    openModal, closeModal,
    onBusy: b => { S.busy = b; },
  });
  renderAll();
}

const liveLocked = () => !!(S.backend && !S.backend.enableRealDelete);
const canDeleteGroups = () => !!S.demo || /(^|\s)Group\.ReadWrite\.All(\s|$)/.test(S.grantedScopes);
const canScanPolicies = () => !!S.demo || /DeviceManagementConfiguration\.Read(Write)?\.All/.test(S.grantedScopes);

// ---------- mode ----------
function setMode(mode, silent) {
  S.dry = mode !== 'live';
  document.body.dataset.mode = S.dry ? 'dry' : 'live';
  $$('#modeSwitch button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  $('#liveBanner').hidden = S.dry;
  $('#liveTenant').textContent = S.demo ? 'the demo tenant' : tenantDomain();
  if (!silent) toast(S.dry ? 'Dry run: nothing will be changed.' : 'LIVE mode: actions will change your tenant.');
  renderActionbar();
}

function askLive() {
  if (liveLocked()) return toast('Live mode is disabled: EnableRealDelete is false in config.json.', true);
  const domain = tenantDomain();
  const word = domain.split('.')[0].toUpperCase();
  openModal(`
    <h2 id="modalTitle">Switch to LIVE mode?</h2>
    <p>In live mode, deleting apps, removing assignments and deleting groups are written to <b>${esc(domain)}</b>. Each action still asks for confirmation.</p>
    <label class="check"><input type="checkbox" name="autoDry" ${S.autoDry ? 'checked' : ''}> Return to Dry run automatically after each live action</label>
    <div class="typed">
      <label><span>Type <code>${esc(word)}</code> to enable live mode</span><input name="typed" autocomplete="off" spellcheck="false"></label>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Stay in Dry run</button>
      <button type="button" class="btn danger" data-go disabled>Enable live mode</button>
    </div>`, form => {
    const go = $('[data-go]', form);
    form.typed.oninput = () => { go.disabled = form.typed.value.trim().toUpperCase() !== word; };
    go.onclick = () => {
      S.autoDry = form.autoDry.checked;
      closeModal();
      setMode('live');
    };
  });
}

// ---------- modal ----------
function openModal(html, wire) {
  const dlg = $('#modal');
  // A fresh form each time, so listeners from a previous dialog never fire on this one.
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'modal';
  form.id = 'modalForm';
  $('#modalForm').replaceWith(form);
  form.innerHTML = html;
  form.onsubmit = e => e.preventDefault();
  $$('[data-close]', form).forEach(b => { b.onclick = closeModal; });
  dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
  if (wire) wire(form);
  const first = $('input:not([type=checkbox]), select', form);
  if (first) first.focus();
}
function closeModal() {
  if (S.busy) return;
  $('#modal').close();
}

// ---------- activity log ----------
function logWrite(entry) {
  S.log.push({ at: new Date().toISOString(), ...entry });
  updateCounts();
  if (S.tab === 'log') renderLog();
}

// ---------- events ----------
function bind() {
  $('#connectForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const cfg = {
      clientId: f.clientId.value.trim(),
      tenantId: f.tenantId.value.trim() || 'organizations',
      allowGroupDelete: f.allowGroupDelete.checked,
      policyScan: f.policyScan.checked,
    };
    auth.saveConfig(cfg);
    try { await auth.login(cfg); } catch (err) { showConnect(err.message); }
  });
  $('#demoBtn').onclick = () => {
    const demo = createDemoTenant();
    startSession(demo.claims, '', demo);
  };

  $('#modeSwitch').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || S.busy) return;
    if (b.dataset.mode === 'live' && S.dry) askLive();
    if (b.dataset.mode === 'dry' && !S.dry) setMode('dry');
  });
  $('#modal').addEventListener('cancel', e => { if (S.busy) e.preventDefault(); });

  $('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); search(); });
  $('#refreshCatalog').onclick = async () => { await ensureCatalog(true); if (S.query) search(); };

  for (const id of ['#rName', '#rVerOp', '#rVer', '#rAssigned']) {
    $(id).addEventListener('input', () => { renderApps(); renderActionbar(); });
  }
  $('#rReset').onclick = () => { resetResultFilters(); renderApps(); renderActionbar(); };
  $('#appResults').addEventListener('click', onAppsClick);
  $('#appResults').addEventListener('change', onAppsChange);

  for (const id of ['#gMode', '#gPattern', '#gStatus', '#gRun', '#gHideInUse', '#gHideSynced', '#gShowDry']) {
    $(id).addEventListener('input', renderGroups);
  }
  $('#groupResults').addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    const visible = filteredLedger().map(x => x.id);
    if (cb.dataset.gall != null) visible.forEach(id => (cb.checked ? S.gSelected.add(id) : S.gSelected.delete(id)));
    else if (cb.dataset.gsel) (cb.checked ? S.gSelected.add(cb.dataset.gsel) : S.gSelected.delete(cb.dataset.gsel));
    renderGroups();
  });
  $('#gSelectAll').onclick = () => { filteredLedger().forEach(e => S.gSelected.add(e.id)); renderGroups(); };
  $('#gSelectNone').onclick = () => { S.gSelected.clear(); renderGroups(); };
  $('#gDetails').onclick = () => guard(loadGroupDetails);
  $('#gScan').onclick = () => guard(runUsageScan);
  $('#gDelete').onclick = () => guard(openGroupDelete);
  $('#gKeep').onclick = () => markKept();
  $('#gForget').onclick = () => forgetGroups();
  $('#gExportCsv').onclick = exportLedgerCsv;
  $('#gExportJson').onclick = exportLedgerJson;
  $('#gImport').onchange = importLedger;

  $('#logExport').onclick = exportLog;
  $('#logClear').onclick = () => { S.log = []; renderLog(); updateCounts(); };
}

async function guard(fn) {
  if (S.busy) return;
  try {
    await fn();
  } catch (e) {
    S.busy = false;
    console.error(e);
    toast(e.message || String(e), true);
    if (/sign in again|Not signed in/i.test(e.message)) showConnect(e.message);
    if (e.code === 'SessionInvalid') toast('The local server was restarted. Reload the page.', true);
  }
}

function switchTab(tab) {
  S.tab = tab;
  $$('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  for (const t of ['apps', 'groups', 'analytics', 'log']) $(`#tab-${t}`).hidden = t !== tab;
  if (tab === 'analytics' && S.analytics) S.analytics.refreshSourceButton();
  renderAll();
}

function renderAll() {
  updateCounts();
  if (S.tab === 'apps') renderApps();
  if (S.tab === 'groups') renderGroups();
  if (S.tab === 'log') renderLog();
  renderActionbar();
}

function updateCounts() {
  $('#ledgerCount').textContent = [...S.ledger.values()].filter(e => e.status === 'pending' || e.status === 'failed').length;
  $('#logCount').textContent = S.log.length;
}

// ---------- catalog & search ----------
async function ensureCatalog(force) {
  if (S.catalog && !force) return S.catalog;
  const info = $('#catalogInfo');
  info.textContent = 'Loading app catalog from Intune…';
  S.catalog = await I.loadCatalog(S.graph, n => { info.textContent = `Loading app catalog… ${n} apps`; });
  S.catalogAt = new Date().toISOString();
  info.textContent = `Catalog: ${plural(S.catalog.length, 'app')} · loaded ${fmtTime(S.catalogAt)}`;
  return S.catalog;
}

async function search() {
  await guard(async () => {
    const f = $('#searchForm');
    const patterns = I.parsePatterns(f.patterns.value);
    if (!patterns.length) { toast('Enter at least one app name.'); f.patterns.focus(); return; }
    const mode = f.mode.value;
    try { patterns.forEach(p => I.makeMatcher(p, mode)); }
    catch (e) { toast('Invalid pattern: ' + e.message, true); return; }

    S.busy = true;
    $('#appResults').innerHTML = `<div class="panel empty">Searching…</div>`;
    const catalog = await ensureCatalog(false);
    let { matched, unmatched } = I.matchApps(catalog, patterns, mode, f.exclude.value);
    const info = $('#catalogInfo');
    if (matched.length) {
      info.textContent = `Reading assignments and versions of ${plural(matched.length, 'app')}…`;
      await I.loadAssignments(S.graph, matched, (d, t) => { info.textContent = `Reading assignments and versions ${d}/${t}…`; }, { withDetails: true });
      await I.resolveGroups(S.graph, I.groupIdsOf(matched), S.groups);
    }
    info.textContent = `Catalog: ${plural(catalog.length, 'app')} · loaded ${fmtTime(S.catalogAt)}`;
    if (f.assignedOnly.checked) matched = matched.filter(a => (a.assignments || []).length);
    matched.sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || '', undefined, { numeric: true }) ||
      I.compareVersions(I.appVersion(a).value || '0', I.appVersion(b).value || '0'));
    resetResultFilters();

    S.query = { patterns, mode };
    S.results = matched;
    S.unmatched = unmatched;
    S.selected = new Set(matched.map(a => a.id));
    S.expanded.clear();
    S.busy = false;
    renderApps();
    renderActionbar();
  });
}

// ---------- apps table ----------
function assignmentChips(app) {
  const as = app.assignments || [];
  if (app.assignmentsError) return `<span class="chip danger" title="${esc(app.assignmentsError)}">Assignments unreadable</span>`;
  if (!as.length) return '<span class="sub">No assignments</span>';
  const c = {};
  let excl = 0, users = 0, devices = 0;
  for (const a of as) {
    const t = I.targetOf(a);
    if (t.kind === 'exclude') { excl++; continue; }
    if (t.kind === 'allUsers') users++;
    if (t.kind === 'allDevices') devices++;
    c[a.intent] = (c[a.intent] || 0) + 1;
  }
  const out = Object.entries(c).map(([k, n]) => `<span class="chip ${esc(k)}">${esc(I.INTENT_LABEL[k] || k)} ${n}</span>`);
  if (excl) out.push(`<span class="chip">Excluded ${excl}</span>`);
  if (users) out.push('<span class="chip info">All users</span>');
  if (devices) out.push('<span class="chip info">All devices</span>');
  return `<div class="chips">${out.join('')}</div>`;
}

function targetText(a) {
  const t = I.targetOf(a);
  if (t.groupId) return I.groupName(t.groupId, S.groups);
  return I.TARGET_LABEL[t.kind] + (t.type ? ` (${t.type})` : '');
}

function resetResultFilters() {
  $('#rName').value = '';
  $('#rVerOp').value = 'any';
  $('#rVer').value = '';
  $('#rAssigned').value = '';
}

/** Results after the in-table filters (name, version, assignments). Actions only ever apply to these. */
function visibleResults() {
  const name = $('#rName').value.trim();
  let nameOk = () => true;
  if (name) nameOk = I.makeMatcher(name, /[*?]/.test(name) ? 'wildcard' : 'contains');
  const verOk = I.makeVersionFilter($('#rVerOp').value, $('#rVer').value);
  const assigned = $('#rAssigned').value;
  return S.results.filter(a =>
    nameOk(a.displayName) && verOk(a) &&
    (!assigned || (assigned === 'yes') === ((a.assignments || []).length > 0)));
}

function filtersActive() {
  return !!($('#rName').value.trim() || $('#rVerOp').value !== 'any' || $('#rAssigned').value);
}

function versionCell(app) {
  const v = I.appVersion(app);
  if (!v.value) return '<span class="sub">–</span>';
  return v.source === 'name'
    ? `<span class="ver" title="Not set on the app; read from its name">${esc(v.value)}<span class="sub"> *</span></span>`
    : `<span class="ver">${esc(v.value)}</span>`;
}

function renderApps() {
  const box = $('#appResults');
  const fbox = $('#resultFilters');
  fbox.hidden = !(S.query && S.results.length);
  const op = $('#rVerOp').value;
  $('#rVer').disabled = op === 'any' || op === 'none';
  if (!S.query) {
    box.innerHTML = `<div class="panel empty">Paste the app names you want to retire above. Wildcards and regular expressions work too — e.g. <code>Notepad++ 7.*</code> or <code>\\(Retired\\)$</code>.</div>`;
    return;
  }
  const all = S.results;
  const apps = visibleResults();
  const hiddenSel = all.filter(a => S.selected.has(a.id) && !apps.includes(a) && !isGone(a)).length;
  $('#rInfo').innerHTML = filtersActive()
    ? `Showing <b>${apps.length}</b> of ${all.length} apps.${hiddenSel ? ` ${plural(hiddenSel, 'selected app')} hidden by these filters ${hiddenSel === 1 ? 'is' : 'are'} not included in actions.` : ''}`
    : 'Narrow down the results, then select what to act on. Actions only apply to apps you can see.';
  const unmatched = S.unmatched.length
    ? `<div class="notice warn">No app matched: ${S.unmatched.map(p => `<code>${esc(p)}</code>`).join(' ')}</div>` : '';
  if (!all.length) {
    box.innerHTML = unmatched + '<div class="panel empty">No apps match these names.</div>';
    return;
  }
  if (!apps.length) {
    box.innerHTML = unmatched + '<div class="panel empty">No results match the filters.</div>';
    return;
  }
  const live = apps.filter(a => !isGone(a));
  const allSel = live.length && live.every(a => S.selected.has(a.id));
  const totalAs = apps.reduce((n, a) => n + (a.assignments || []).length, 0);
  const groups = I.groupIdsOf(apps).length;

  const rows = apps.map(app => {
    const gone = isGone(app);
    const st = S.appState.get(app.id);
    const flags = gone ? [] : I.appFlags(app).map(f => `<span class="chip ${f.level}">${esc(f.text)}</span>`);
    if (st) flags.unshift(`<span class="chip ${st.mode === 'DRY' ? 'dry' : st.fail ? 'danger' : 'ok'}" title="${esc(st.detail || '')}">${esc(st.label)}</span>`);
    const nGroups = new Set((app.assignments || []).map(a => I.targetOf(a).groupId).filter(Boolean)).size;
    const open = S.expanded.has(app.id);
    const detail = open ? `<tr class="detail"><td colspan="7"><div class="assign-list">${
      (app.assignments || []).length
        ? app.assignments.map(a => {
            const t = I.targetOf(a);
            return `<div><span><span class="chip ${esc(a.intent)}">${esc(I.INTENT_LABEL[a.intent] || a.intent)}</span></span>
              <span class="sub">${esc(I.TARGET_LABEL[t.kind])}</span>
              <span>${esc(targetText(a))}${t.groupId ? ` <span class="mono">${esc(t.groupId)}</span>` : ''}</span>
              <span class="sub">${t.filterId ? `Filter (${esc(t.filterType)})` : ''}</span></div>`;
          }).join('')
        : '<div class="sub">No assignments.</div>'
    }</div></td></tr>` : '';
    return `<tr class="${S.selected.has(app.id) ? 'selected' : ''} ${gone ? 'done' : ''}">
      <td class="sel"><input type="checkbox" data-sel="${esc(app.id)}" ${S.selected.has(app.id) ? 'checked' : ''} ${gone ? 'disabled' : ''} aria-label="Select ${esc(app.displayName)}"></td>
      <td><button type="button" class="expander" data-expand="${esc(app.id)}" aria-expanded="${open}">${open ? '▾' : '▸'}</button>
        <span class="name">${esc(app.displayName)}</span>
        <div class="sub">${esc(I.appTypeLabel(app))}${app.publisher ? ' · ' + esc(app.publisher) : ''}</div></td>
      <td>${versionCell(app)}</td>
      <td>${assignmentChips(app)}</td>
      <td class="num">${nGroups || '–'}</td>
      <td><div class="chips">${flags.join('')}</div></td>
      <td class="sub">${esc(fmtDate(app.lastModifiedDateTime))}</td>
    </tr>${detail}`;
  }).join('');

  box.innerHTML = `${unmatched}
    <div class="result-head">
      <h2>${filtersActive() ? `${apps.length} of ${plural(all.length, 'app')}` : `${plural(all.length, 'app')} found`} <span class="muted">· ${plural(totalAs, 'assignment')} · ${plural(groups, 'group')}</span></h2>
      <div class="row">
        <button type="button" class="btn small ghost" data-act="expandAll">Expand all</button>
        <button type="button" class="btn small ghost" data-act="collapseAll">Collapse all</button>
        <button type="button" class="btn small" data-act="exportInventory">Export inventory CSV</button>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="sel"><input type="checkbox" data-all ${allSel ? 'checked' : ''} aria-label="Select all"></th>
        <th>App</th><th>Version</th><th>Assignments</th><th class="num">Groups</th><th>Flags</th><th>Modified</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

const isGone = app => { const s = S.appState.get(app.id); return !!(s && s.gone); };

function onAppsClick(e) {
  const ex = e.target.closest('[data-expand]');
  if (ex) {
    const id = ex.dataset.expand;
    S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
    return renderApps();
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'expandAll') { visibleResults().forEach(a => S.expanded.add(a.id)); renderApps(); }
  if (act.dataset.act === 'collapseAll') { S.expanded.clear(); renderApps(); }
  if (act.dataset.act === 'exportInventory') exportInventory();
}

function onAppsChange(e) {
  const cb = e.target;
  if (cb.dataset.all != null) {
    visibleResults().filter(a => !isGone(a)).forEach(a => (cb.checked ? S.selected.add(a.id) : S.selected.delete(a.id)));
  } else if (cb.dataset.sel) {
    cb.checked ? S.selected.add(cb.dataset.sel) : S.selected.delete(cb.dataset.sel);
  }
  renderApps();
  renderActionbar();
}

function selectedApps() {
  return visibleResults().filter(a => S.selected.has(a.id) && !isGone(a));
}

function renderActionbar() {
  const bar = $('#actionbar');
  const apps = S.tab === 'apps' ? selectedApps() : [];
  if (!apps.length || $('#workspace').hidden) { bar.hidden = true; return; }
  const nAs = apps.reduce((n, a) => n + (a.assignments || []).length, 0);
  const nG = I.groupIdsOf(apps).length;
  bar.hidden = false;
  bar.innerHTML = `<span class="summary"><b>${plural(apps.length, 'app')}</b> selected · ${plural(nAs, 'assignment')} · ${plural(nG, 'group')}</span>
    <button type="button" class="btn" data-bar="inspect">Review groups</button>
    <button type="button" class="btn primary" data-bar="remove">Remove assignments…</button>
    <button type="button" class="btn danger" data-bar="delete">Delete apps…</button>
    <button type="button" class="btn ghost" data-bar="clear">Clear</button>`;
  bar.onclick = e => {
    const b = e.target.closest('[data-bar]');
    if (!b) return;
    if (b.dataset.bar === 'clear') { S.selected.clear(); renderApps(); renderActionbar(); }
    if (b.dataset.bar === 'remove') guard(openRemove);
    if (b.dataset.bar === 'delete') guard(openDeleteApps);
    if (b.dataset.bar === 'inspect') guard(openInspect);
  };
}

// ---------- shared modal pieces ----------
function modeTag() {
  return S.dry ? '<span class="chip dry mode-tag">DRY RUN</span>' : '<span class="chip live mode-tag">LIVE</span>';
}

function confirmBlock(word) {
  if (S.dry) {
    return '<div class="notice info">Dry run: every step is simulated and written to the activity log. Nothing changes in the tenant.</div>';
  }
  return `<label class="check"><input type="checkbox" name="backup" checked> Download a JSON backup of the affected apps and assignments first</label>
    <div class="typed"><label><span>Type <code>${word}</code> to confirm</span><input name="typed" autocomplete="off" spellcheck="false"></label></div>`;
}

function wireConfirm(form, word, isReady) {
  const go = $('[data-go]', form);
  const update = () => {
    const typedOk = S.dry || (form.typed && form.typed.value.trim().toUpperCase() === word);
    go.disabled = !typedOk || !isReady();
  };
  form.addEventListener('input', update);
  update();
  return update;
}

function newRun(label, count) {
  const at = new Date().toISOString();
  const run = { id: 'r' + Date.now().toString(36), at, mode: S.dry ? 'DRY' : 'LIVE', label: `${fmtTime(at)} · ${label} · ${plural(count, 'app')}${S.dry ? ' (dry run)' : ''}` };
  S.runs.push(run);
  return run;
}

function backupApps(apps, action, plan) {
  const data = {
    tool: TOOL, version: VERSION, action, createdAt: new Date().toISOString(),
    tenant: { id: S.claims.tid, user: S.claims.upn },
    apps: apps.map(a => ({
      id: a.id, displayName: a.displayName, version: I.appVersion(a).value, type: a['@odata.type'], publisher: a.publisher,
      assignments: (a.assignments || []).map(as => ({ ...as, groupName: I.targetOf(as).groupId ? I.groupName(I.targetOf(as).groupId, S.groups) : null })),
    })),
  };
  if (plan && plan.updates && plan.updates.length) {
    // To restore a link: POST /deviceAppManagement/mobileApps/{ownerId}/updateRelationships
    // with { relationships: [...before] } (Graph beta).
    data.relationshipChanges = plan.updates.map(u => ({
      ownerId: u.ownerId, ownerName: u.ownerName, ownerVersion: u.ownerVersion, ownerKept: u.kept,
      before: [...u.keep, ...u.remove].map(I.relationshipBody),
      after: u.keep.map(I.relationshipBody),
      removed: u.remove.map(r => ({ targetId: r.targetId, targetName: r.targetDisplayName, targetVersion: r.targetDisplayVersion, ...I.relationshipBody(r) })),
    }));
  }
  download(`backup-${action}-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

/** Swap the modal into a progress view. Returns helpers to report progress and finish. */
function progressView(title, total) {
  const form = $('#modalForm');
  form.innerHTML = `<h2 id="modalTitle">${esc(title)} ${modeTag()}</h2>
    <div class="progress"><i></i></div>
    <div class="sub" data-p>0 / ${total}</div>
    <div class="runlog" data-log></div>
    <div class="modal-actions" data-actions></div>`;
  let n = 0;
  const log = $('[data-log]', form);
  return {
    step(line, cls) {
      n++;
      $('.progress > i', form).style.width = `${Math.round((n / Math.max(total, 1)) * 100)}%`;
      $('[data-p]', form).textContent = `${n} / ${total}`;
      if (line) {
        const d = document.createElement('div');
        if (cls) d.className = cls;
        d.textContent = line;
        log.append(d);
        log.scrollTop = log.scrollHeight;
      }
    },
    finish(summaryHtml, buttons) {
      $('[data-p]', form).outerHTML = summaryHtml;
      $('[data-actions]', form).innerHTML = buttons;
      $$('[data-close]', form).forEach(b => { b.onclick = closeModal; });
      return form;
    },
  };
}

function afterLiveRun() {
  if (!S.dry && S.autoDry) setMode('dry', true), toast('Back in Dry run.');
  if (S.usage) S.usage.stale = true;
}

// ---------- ledger ----------
function recordGroup(groupId, app, assignment, action, run) {
  let e = S.ledger.get(groupId);
  const dry = run.mode === 'DRY';
  if (!e) {
    e = { id: groupId, name: I.groupName(groupId, S.groups), origin: dry ? 'dry' : 'live', status: 'pending', sources: [], recordedAt: new Date().toISOString() };
    S.ledger.set(groupId, e);
  }
  if (!dry && e.origin === 'dry') e.origin = 'live';
  if (!dry && e.status === 'kept') e.status = 'pending'; // a new live removal reopens the decision
  const info = S.groups.get(groupId);
  if (info) { e.info = groupInfoSlim(info); if (info.displayName) e.name = info.displayName; }
  e.sources.push({
    appId: app.id, appName: app.displayName, intent: assignment.intent, kind: I.targetOf(assignment).kind,
    action, runId: run.id, mode: run.mode, at: new Date().toISOString(),
  });
}

function groupInfoSlim(g) {
  return {
    missing: !!g.missing, groupTypes: g.groupTypes || [], securityEnabled: g.securityEnabled, mailEnabled: g.mailEnabled,
    membershipRule: g.membershipRule || null, onPremisesSyncEnabled: !!g.onPremisesSyncEnabled,
    isAssignableToRole: !!g.isAssignableToRole, memberCount: g.memberCount ?? null,
  };
}

// ---------- inspect (read-only) ----------
async function openInspect() {
  const apps = selectedApps();
  const ids = I.groupIdsOf(apps);
  await I.resolveGroups(S.graph, ids, S.groups, { withCounts: true });
  const rows = ids.map(id => {
    const g = S.groups.get(id) || {};
    const users = apps.flatMap(a => (a.assignments || []).filter(as => I.targetOf(as).groupId === id).map(as => `${a.displayName} (${I.INTENT_LABEL[as.intent] || as.intent}${I.targetOf(as).kind === 'exclude' ? ', excluded' : ''})`));
    return `<tr><td><span class="name">${esc(I.groupName(id, S.groups))}</span><div class="chips">${I.groupKind(g).map(k => `<span class="chip">${esc(k)}</span>`).join('')}</div></td>
      <td class="num">${g.memberCount ?? '–'}</td><td class="sub">${users.map(esc).join('<br>')}</td></tr>`;
  }).join('');
  openModal(`<h2 id="modalTitle">Groups assigned to ${plural(apps.length, 'selected app')}</h2>
    <p class="sub">Read-only view. Nothing is changed or recorded until you remove assignments or delete apps.</p>
    ${ids.length ? `<div class="table-wrap"><table><thead><tr><th>Group</th><th class="num">Members</th><th>Assigned to</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">These apps have no group assignments.</div>'}
    <div class="modal-actions"><button type="button" class="btn" data-close>Close</button></div>`);
}

// ---------- remove assignments ----------
function assignmentPredicate(form) {
  const intents = new Set($$('input[name=intent]:checked', form).map(i => i.value));
  const kinds = new Set($$('input[name=kind]:checked', form).map(i => i.value));
  const pattern = form.gpattern.value.trim();
  let match = null;
  if (pattern) {
    try { match = I.makeMatcher(pattern, form.gmode.value); } catch { return { error: 'Invalid group name pattern' }; }
  }
  return {
    fn: a => {
      const t = I.targetOf(a);
      if (!intents.has(a.intent)) return false;
      if (match) return !!t.groupId && kinds.has(t.kind) && match(I.groupName(t.groupId, S.groups));
      return t.kind === 'other' ? true : kinds.has(t.kind);
    },
  };
}

function openRemove() {
  const apps = selectedApps();
  const intents = I.INTENTS.map(k => `<label class="check"><input type="checkbox" name="intent" value="${k}" checked> ${esc(I.INTENT_LABEL[k])}</label>`).join('');
  const kinds = ['include', 'exclude', 'allUsers', 'allDevices'].map(k => `<label class="check"><input type="checkbox" name="kind" value="${k}" checked> ${esc(I.TARGET_LABEL[k])}s</label>`.replace('All userss', 'All users').replace('All devicess', 'All devices')).join('');
  openModal(`
    <h2 id="modalTitle">Remove assignments ${modeTag()}</h2>
    <p class="sub">The apps stay in Intune. Every group taken off an app is recorded in the Groups ledger so you can decide later whether to delete it.</p>
    <div class="opt-grid">
      <fieldset><legend>Intents</legend>${intents}</fieldset>
      <fieldset><legend>Targets</legend>${kinds}</fieldset>
    </div>
    <fieldset><legend>Only groups whose name matches (optional)</legend>
      <div class="inline"><select name="gmode">${Object.entries(I.MATCH_MODES).map(([k, v]) => `<option value="${k}" ${k === 'wildcard' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <input name="gpattern" placeholder="e.g. SG-APP-*"></div>
      <p class="hint">When a name condition is set, only matching group assignments are removed; All users / All devices are left alone.</p>
    </fieldset>
    <div class="preview" data-preview></div>
    ${confirmBlock('REMOVE')}
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="button" class="btn primary" data-go>${S.dry ? 'Simulate removal' : 'Remove assignments'}</button>
    </div>`, form => {
    let plan = [];
    const preview = () => {
      const p = assignmentPredicate(form);
      const box = $('[data-preview]', form);
      if (p.error) { plan = []; box.innerHTML = `<span class="error">${esc(p.error)}</span>`; return; }
      plan = apps.map(app => ({ app, items: (app.assignments || []).filter(p.fn) })).filter(x => x.items.length);
      const n = plan.reduce((s, x) => s + x.items.length, 0);
      const total = apps.reduce((s, a) => s + (a.assignments || []).length, 0);
      const groups = new Set(plan.flatMap(x => x.items.map(a => I.targetOf(a).groupId).filter(Boolean)));
      const untouched = apps.length - plan.length;
      box.innerHTML = `Will remove <b>${n}</b> of ${total} assignments on <b>${plural(plan.length, 'app')}</b>. <b>${plural(groups.size, 'group')}</b> will be recorded in the ledger.${untouched ? `<div class="sub">${plural(untouched, 'app')} ${untouched === 1 ? 'has' : 'have'} nothing matching and will be skipped.</div>` : ''}`;
    };
    form.addEventListener('input', preview);
    preview();
    wireConfirm(form, 'REMOVE', () => plan.length > 0);
    $('[data-go]', form).onclick = () => guard(() => runRemove(plan, form.backup && form.backup.checked));
  });
}

async function runRemove(plan, backup) {
  const apps = plan.map(x => x.app);
  if (backup) backupApps(apps, 'remove-assignments');
  const run = newRun('Remove assignments', apps.length);
  const dry = run.mode === 'DRY';
  const total = plan.reduce((s, x) => s + x.items.length, 0);
  S.busy = true;
  const ui = progressView('Removing assignments', total);
  let ok = 0, fail = 0;
  const groups = new Set();
  await pool(plan, 4, async ({ app, items }) => {
    let appFail = 0;
    for (const a of items) {
      const label = `${app.displayName} → ${I.INTENT_LABEL[a.intent] || a.intent}: ${targetText(a)}`;
      try {
        await S.graph.mutate('DELETE', `/deviceAppManagement/mobileApps/${app.id}/assignments/${encodeURIComponent(a.id)}`,
          { action: 'Remove assignment', target: label, targetId: app.id, runId: run.id });
        const gid = I.targetOf(a).groupId;
        if (gid) { recordGroup(gid, app, a, 'Assignment removed', run); groups.add(gid); }
        ok++;
        ui.step(`${dry ? '[dry] ' : ''}removed  ${label}`, 's');
      } catch (e) {
        fail++; appFail++;
        ui.step(`FAILED   ${label} — ${e.message}`, 'f');
      }
    }
    S.appState.set(app.id, {
      mode: run.mode, fail: appFail > 0,
      label: dry ? 'Would remove assignments' : appFail ? 'Partly removed' : 'Assignments removed',
      detail: appFail ? `${appFail} assignment(s) failed` : '',
    });
  });
  if (!dry) await I.loadAssignments(S.graph, apps);
  S.busy = false;
  saveLedger();
  afterLiveRun();
  renderApps();
  renderActionbar();
  finishRun(ui, run, [
    [ok, dry ? 'would be removed' : 'removed'],
    [fail, 'failed'],
    [groups.size, 'groups recorded'],
  ], groups.size);
}

async function finishRun(ui, run, stats, groupCount) {
  const recorded = [...S.ledger.values()].filter(e => e.sources.some(s => s.runId === run.id) && (!e.info || e.info.memberCount == null));
  if (recorded.length) {
    try { await loadGroupDetails(recorded); } catch (e) { toast('Could not load group details: ' + e.message, true); }
  }
  const form = ui.finish(
    `<div class="stats">${stats.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${esc(l)}</span></div>`).join('')}</div>
     ${run.mode === 'DRY' ? '<div class="notice info">Dry run finished. Switch to Live and run again to apply.</div>' : ''}`,
    `<button type="button" class="btn ghost" data-close>Close</button>
     ${groupCount ? `<button type="button" class="btn primary" data-review>Review ${plural(groupCount, 'group')} now</button>` : ''}`
  );
  const r = $('[data-review]', form);
  if (r) r.onclick = () => {
    closeModal();
    $('#gRun').innerHTML = runOptions();
    $('#gRun').value = run.id;
    $('#gStatus').value = 'open';
    if (run.mode === 'DRY') $('#gShowDry').checked = true;
    switchTab('groups');
  };
}

// ---------- delete apps ----------
const relCache = { rels: new Map() };

async function relationshipsFor(ids) {
  const need = ids.filter(id => !relCache.rels.has(id));
  if (need.length) {
    const got = await I.loadRelationships(S.graph, need);
    for (const [k, v] of got) relCache.rels.set(k, v);
  }
  return new Map(ids.map(id => [id, relCache.rels.get(id)]));
}

const LINK_TEXT = {
  internal: 'Between apps you are deleting',
  supersededBy: 'Kept apps that supersede an app you are deleting',
  dependedOnBy: 'Kept apps that DEPEND on an app you are deleting',
  outbound: 'Apps you are deleting that supersede or depend on kept apps',
};
const LINK_HELP = {
  internal: 'Removed. Both ends are being deleted.',
  supersededBy: 'The supersedence entry is removed from the kept (newer) app. Devices keep what they have installed; the old version just stops being referenced.',
  dependedOnBy: 'Risk: the kept app would no longer install this prerequisite. Only remove if the kept app no longer needs it, or replace the dependency first.',
  outbound: 'Removed together with the app being deleted. The kept app is not changed.',
};

function linkLine(l) {
  const verb = l.kind === 'dependency' ? 'depends on' : 'supersedes';
  const v = x => (x ? ` <span class="sub">${esc(x)}</span>` : '');
  return `<li><b>${esc(l.ownerName)}</b>${v(l.ownerVersion)} ${verb} <b>${esc(l.otherName)}</b>${v(l.otherVersion)}${l.detail ? ` <span class="chip">${esc(l.detail)}</span>` : ''}</li>`;
}

async function openDeleteApps() {
  const apps = selectedApps();
  const synced = apps.filter(a => I.appFlags(a).some(f => f.key === 'synced'));
  relCache.rels.clear();
  openModal(`<h2 id="modalTitle">Delete ${plural(apps.length, 'app')} ${modeTag()}</h2><div class="preview" data-load>Checking supersedence and dependency relationships…</div>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button></div>`);
  S.busy = true;
  let rels;
  try {
    rels = await relationshipsFor(apps.map(a => a.id));
  } finally { S.busy = false; }
  if (!$('#modal').open) return;
  const linked = apps.filter(a => { const r = rels.get(a.id); return !Array.isArray(r) || r.length > 0; });
  const basePlan = linked.length ? await I.planUnlink(apps, rels, relationshipsFor) : { links: [], updates: [], errors: [] };
  const riskyTargets = new Set(basePlan.links.filter(l => l.category === 'dependedOnBy').map(l => l.other));
  const errorIds = new Set(basePlan.errors.map(e => e.app.id));

  const groupsHtml = ['internal', 'supersededBy', 'dependedOnBy', 'outbound'].map(cat => {
    const ls = basePlan.links.filter(l => l.category === cat);
    if (!ls.length) return '';
    return `<details ${cat === 'dependedOnBy' ? 'open' : ''} class="${cat === 'dependedOnBy' ? 'risk' : ''}"><summary>${LINK_TEXT[cat]} <b>${ls.length}</b></summary>
      <p class="sub">${LINK_HELP[cat]}</p><ul class="list-compact">${ls.map(linkLine).join('')}</ul></details>`;
  }).join('');

  openModal(`
    <h2 id="modalTitle">Delete ${plural(apps.length, 'app')} ${modeTag()}</h2>
    <p class="sub">Deleting an app removes the package and all its assignments from Intune. The groups it was assigned to are recorded in the Groups ledger, so you can decide about them next.</p>
    ${linked.length ? `<div class="notice warn rel-box">
      <p class="rel-msg"><b>${plural(linked.length, 'app')}</b> ${linked.length === 1 ? 'has' : 'have'} supersedence or dependency relationships (${plural(basePlan.links.length, 'link')}). Intune refuses to delete an app until its links are removed.</p>
      <div class="radio-col">
        <label class="check"><input type="radio" name="relMode" value="unlink" checked> Remove the links first, then delete <span class="muted">(recommended for old versions)</span></label>
        <label class="check"><input type="radio" name="relMode" value="skip"> Skip these ${plural(linked.length, 'app')}, delete the rest</label>
      </div>
      <div class="rel-groups">${groupsHtml}</div>
      ${riskyTargets.size ? `<label class="check risk-opt"><input type="checkbox" name="dropDeps"> Also remove dependencies from kept apps (otherwise the ${plural(riskyTargets.size, 'prerequisite app')} they need ${riskyTargets.size === 1 ? 'is' : 'are'} skipped)</label>` : ''}
      ${basePlan.errors.length ? `<div class="notice danger">Couldn't read relationships of ${plural(basePlan.errors.length, 'app')}; ${basePlan.errors.length === 1 ? 'it' : 'they'} will be skipped: ${basePlan.errors.map(e => esc(e.app.displayName)).join(', ')}</div>` : ''}
    </div>` : ''}
    ${synced.length ? `<div class="notice info">${plural(synced.length, 'app')} ${synced.length === 1 ? 'is' : 'are'} synced from a store (VPP / Managed Google Play). Remove ${synced.length === 1 ? 'it' : 'them'} from the store side too, or ${synced.length === 1 ? 'it' : 'they'} may come back.</div>` : ''}
    <div class="preview" data-preview></div>
    ${confirmBlock('DELETE')}
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="button" class="btn danger" data-go>${S.dry ? 'Simulate deletion' : 'Delete apps'}</button>
    </div>`, form => {
    let targets = [];
    let plan = null;
    let seq = 0;
    const preview = async () => {
      const my = ++seq;
      const mode = form.relMode ? form.querySelector('[name=relMode]:checked').value : 'skip';
      const dropDeps = !!(form.dropDeps && form.dropDeps.checked);
      if (form.dropDeps) form.dropDeps.disabled = mode !== 'unlink';
      const linkedIds = new Set(linked.map(a => a.id));
      targets = apps.filter(a => {
        if (errorIds.has(a.id)) return false;
        if (mode === 'skip') return !linkedIds.has(a.id);
        return dropDeps || !riskyTargets.has(a.id);
      });
      plan = mode === 'unlink' && targets.some(a => linkedIds.has(a.id))
        ? await I.planUnlink(targets, rels, relationshipsFor)
        : { links: [], updates: [], errors: [] };
      if (my !== seq) return;
      // An app whose own links (or a kept owner's links) can't be read stays out.
      const badOwners = new Set(plan.errors.map(e => e.app.id));
      targets = targets.filter(a => !badOwners.has(a.id) && !plan.links.some(l => (l.other === a.id || l.owner === a.id) && badOwners.has(l.owner)));
      const as = targets.reduce((n, a) => n + (a.assignments || []).length, 0);
      const groups = I.groupIdsOf(targets).length;
      const keptChanged = plan.updates.filter(u => u.kept);
      $('[data-preview]', form).innerHTML =
        (plan.updates.length ? `First remove <b>${plural(plan.links.length, 'link')}</b> on ${plural(plan.updates.length, 'app')}${keptChanged.length ? ` (<b>${keptChanged.length}</b> of them kept: ${keptChanged.slice(0, 4).map(u => esc(u.ownerName + (u.ownerVersion ? ' ' + u.ownerVersion : ''))).join(', ')}${keptChanged.length > 4 ? '…' : ''})` : ''}, then ` : '')
        + `${plan.updates.length ? 'delete' : 'Will delete'} <b>${plural(targets.length, 'app')}</b> with ${plural(as, 'assignment')}. <b>${plural(groups, 'group')}</b> will be recorded in the ledger.`
        + (apps.length > targets.length ? `<div class="sub">${plural(apps.length - targets.length, 'app')} skipped.</div>` : '');
      updateGo();
    };
    form.addEventListener('change', preview);
    const updateGo = wireConfirm(form, 'DELETE', () => targets.length > 0);
    preview();
    $('[data-go]', form).onclick = () => guard(() => runDeleteApps(targets, form.backup && form.backup.checked, plan));
  });
}

async function runDeleteApps(apps, backup, plan = { links: [], updates: [] }) {
  if (backup) backupApps(apps, 'delete-apps', plan);
  const run = newRun('Delete apps', apps.length);
  const dry = run.mode === 'DRY';
  S.busy = true;
  const ui = progressView(plan.updates.length ? 'Removing links, then deleting apps' : 'Deleting apps', plan.updates.length + apps.length);
  let ok = 0, fail = 0, unlinked = 0;
  const groups = new Set();
  const blocked = new Map(); // appId -> reason (an unlink it needed failed)

  // Phase 1: rewrite the relationships of every owner app.
  await pool(plan.updates, 3, async u => {
    const removed = u.remove.map(r => r.targetDisplayName + (r.targetDisplayVersion ? ' ' + r.targetDisplayVersion : ''));
    const label = `${u.ownerName}${u.ownerVersion ? ' ' + u.ownerVersion : ''}${u.kept ? ' (kept)' : ''}`;
    try {
      await S.graph.mutate('POST', `/deviceAppManagement/mobileApps/${u.ownerId}/updateRelationships`,
        { action: u.kept ? 'Remove links (kept app)' : 'Remove links', target: label, targetId: u.ownerId, runId: run.id,
          detail: `removed: ${removed.join(', ')}${u.keep.length ? ` · kept ${u.keep.length}` : ''}` },
        { relationships: u.keep.map(I.relationshipBody) });
      unlinked += u.remove.length;
      if (!dry) {
        const cached = relCache.rels.get(u.ownerId);
        if (Array.isArray(cached)) relCache.rels.set(u.ownerId, cached.filter(r => r.targetType !== 'child' || u.keep.some(k => k.targetId === r.targetId)));
      }
      ui.step(`${dry ? '[dry] ' : ''}unlinked ${label} → ${removed.join(', ')}`, 's');
    } catch (e) {
      ui.step(`FAILED   unlink ${label} — ${e.message}`, 'f');
      for (const r of u.remove) blocked.set(r.targetId, `Removing the link from ${u.ownerName} failed`);
      if (!u.kept) blocked.set(u.ownerId, 'Removing its links failed');
    }
  });

  // Phase 2: delete.
  await pool(apps, 4, async app => {
    if (blocked.has(app.id)) {
      fail++;
      S.appState.set(app.id, { mode: run.mode, fail: true, label: 'Skipped', detail: blocked.get(app.id) });
      ui.step(`SKIPPED  ${app.displayName} — ${blocked.get(app.id)}`, 'f');
      return;
    }
    try {
      const r = await S.graph.mutate('DELETE', `/deviceAppManagement/mobileApps/${app.id}`,
        { action: 'Delete app', target: app.displayName + (I.appVersion(app).value ? ' ' + I.appVersion(app).value : ''), targetId: app.id, runId: run.id,
          detail: `${(app.assignments || []).length} assignment(s)` });
      for (const a of app.assignments || []) {
        const gid = I.targetOf(a).groupId;
        if (gid) { recordGroup(gid, app, a, 'App deleted', run); groups.add(gid); }
      }
      ok++;
      S.appState.set(app.id, dry
        ? { mode: 'DRY', label: 'Would delete' }
        : { mode: 'LIVE', label: r.gone ? 'Already deleted' : 'Deleted', gone: true });
      ui.step(`${dry ? '[dry] ' : ''}deleted  ${app.displayName}${I.appVersion(app).value ? ' ' + I.appVersion(app).value : ''}`, 's');
    } catch (e) {
      fail++;
      S.appState.set(app.id, { mode: run.mode, fail: true, label: 'Delete failed', detail: e.message });
      ui.step(`FAILED   ${app.displayName} — ${e.message}`, 'f');
    }
  });
  if (!dry) {
    const gone = new Set(apps.filter(a => isGone(a)).map(a => a.id));
    if (S.catalog) S.catalog = S.catalog.filter(a => !gone.has(a.id));
    gone.forEach(id => S.selected.delete(id));
    // Re-read relationships of the remaining results so their flags are current.
    if (plan.updates.length) {
      const left = S.results.filter(a => !isGone(a));
      try {
        const fresh = await I.loadRelationships(S.graph, left.map(a => a.id));
        for (const a of left) I.applyRelationshipCounts(a, fresh.get(a.id));
      } catch { /* flags stay as they were */ }
    }
  }
  S.busy = false;
  saveLedger();
  afterLiveRun();
  renderApps();
  renderActionbar();
  const stats = [];
  if (plan.updates.length) stats.push([unlinked, dry ? 'links would be removed' : 'links removed']);
  stats.push([ok, dry ? 'would be deleted' : 'deleted'], [fail, 'failed / skipped'], [groups.size, 'groups recorded']);
  finishRun(ui, run, stats, groups.size);
}

// ---------- groups ledger ----------
function runOptions() {
  const used = new Set([...S.ledger.values()].flatMap(e => e.sources.map(s => s.runId)));
  return '<option value="">All runs</option>' + S.runs.filter(r => used.has(r.id)).slice().reverse()
    .map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');
}

/** References that keep a group "in use", ignoring the app assignments a dry run only pretended to remove. */
function usageRefs(e) {
  if (!S.usage || !S.usage.refs.has(e.id)) return null;
  const dryApps = new Set(e.sources.filter(s => s.mode === 'DRY').map(s => s.appId));
  return S.usage.refs.get(e.id).filter(r => !(r.type === 'App' && dryApps.has(r.objectId)));
}

function filteredLedger() {
  let match = () => true;
  const p = $('#gPattern').value.trim();
  if (p) { try { match = I.makeMatcher(p, $('#gMode').value); } catch { match = () => false; } }
  const status = $('#gStatus').value;
  const run = $('#gRun').value;
  const hideInUse = $('#gHideInUse').checked;
  const hideSynced = $('#gHideSynced').checked;
  const showDry = $('#gShowDry').checked;
  return [...S.ledger.values()].filter(e => {
    if (!showDry && e.origin === 'dry') return false;
    if (status === 'open' && !(e.status === 'pending' || e.status === 'failed')) return false;
    if (status !== 'open' && status !== 'all' && e.status !== status) return false;
    if (run && !e.sources.some(s => s.runId === run)) return false;
    if (hideSynced && e.info && e.info.onPremisesSyncEnabled) return false;
    if (hideInUse) { const r = usageRefs(e); if (r && r.length) return false; }
    return match(e.name);
  }).sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
}

function statusChip(e) {
  const map = {
    pending: ['', 'Pending'], kept: ['info', 'Kept'], deleted: ['ok', 'Deleted'], failed: ['danger', 'Failed'],
  };
  const [cls, label] = map[e.status] || ['', e.status];
  let out = `<span class="chip ${cls}" title="${esc(e.error || '')}">${label}</span>`;
  if (e.simulatedDelete && e.status === 'pending') out += ' <span class="chip dry">Would delete</span>';
  return out;
}

function renderGroups() {
  const runSel = $('#gRun');
  const cur = runSel.value;
  runSel.innerHTML = runOptions();
  runSel.value = [...runSel.options].some(o => o.value === cur) ? cur : '';

  const scan = $('#scanInfo');
  if (S.usage) {
    scan.innerHTML = `Usage checked ${esc(fmtTime(S.usage.scannedAt))}${S.usage.stale ? ' — <b>out of date after later changes, check again</b>' : ''}.
      ${S.usage.skipped.length ? 'Not covered: ' + S.usage.skipped.map(esc).join('; ') + '.' : ''} Conditional Access, app protection and enrollment profiles are not checked.`;
  } else {
    scan.textContent = canScanPolicies()
      ? 'Usage not checked yet. "Check usage across tenant" looks for each group in app, configuration, compliance, script and remediation assignments.'
      : 'Usage not checked yet. Policy usage needs DeviceManagementConfiguration.Read.All; only app assignments will be checked.';
  }
  $('#gDelete').disabled = !canDeleteGroups();
  $('#gDelete').title = canDeleteGroups() ? '' : 'Sign in with "Allow deleting groups" to enable';

  const list = filteredLedger();
  const box = $('#groupResults');
  if (!S.ledger.size) {
    box.innerHTML = '<div class="panel empty">No groups recorded yet. Remove assignments or delete apps on the first tab, and their groups appear here.</div>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="panel empty">No groups match the current filters.</div>';
    return;
  }
  const allSel = list.every(e => S.gSelected.has(e.id));
  const nSel = [...S.gSelected].filter(id => S.ledger.has(id)).length;
  const rows = list.map(e => {
    const info = e.info || {};
    const kinds = e.info ? I.groupKind(info) : [];
    const refs = usageRefs(e);
    const usage = refs == null
      ? '<span class="sub">Not checked</span>'
      : refs.length
        ? `<span class="chip warn" title="${esc(refs.map(r => `${r.type}: ${r.name}`).join('\n'))}">In use · ${refs.length}</span><div class="sub">${refs.slice(0, 2).map(r => esc(`${r.type}: ${r.name}`)).join('<br>')}${refs.length > 2 ? `<br>+${refs.length - 2} more` : ''}</div>`
        : '<span class="chip ok">Unused</span>';
    const apps = [...new Map(e.sources.map(s => [s.appId + s.intent + s.kind, s])).values()];
    return `<tr class="${S.gSelected.has(e.id) ? 'selected' : ''} ${e.status === 'deleted' ? 'done' : ''}">
      <td class="sel"><input type="checkbox" data-gsel="${esc(e.id)}" ${S.gSelected.has(e.id) ? 'checked' : ''} aria-label="Select ${esc(e.name)}"></td>
      <td><span class="name">${esc(e.name)}</span> ${e.origin === 'dry' ? '<span class="chip dry" title="Recorded by a dry run; the assignment still exists">dry run</span>' : ''}
        <div class="mono">${esc(e.id)}</div>
        <div class="chips">${kinds.map(k => `<span class="chip ${k === 'Synced from AD' || k === 'Role-assignable' ? 'warn' : ''}">${esc(k)}</span>`).join('')}</div></td>
      <td class="sub">${apps.slice(0, 3).map(s => `${esc(s.appName)} <span class="chip ${esc(s.intent)}">${esc(I.INTENT_LABEL[s.intent] || s.intent)}${s.kind === 'exclude' ? ' · excl.' : ''}</span>`).join('<br>')}${apps.length > 3 ? `<br>+${apps.length - 3} more` : ''}
        <div>${esc(apps[0] ? apps[apps.length - 1].action : '')}</div></td>
      <td class="num">${info.memberCount ?? '–'}</td>
      <td>${usage}</td>
      <td>${statusChip(e)}</td>
      <td class="sub">${esc(fmtDate(e.recordedAt))}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="result-head"><h2>${plural(list.length, 'group')} shown <span class="muted">· ${nSel} selected</span></h2></div>
    <div class="table-wrap"><table>
      <thead><tr><th class="sel"><input type="checkbox" data-gall ${allSel ? 'checked' : ''} aria-label="Select all shown"></th>
        <th>Group</th><th>Recorded from</th><th class="num">Members</th><th>Still used by</th><th>Status</th><th>Recorded</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function selectedEntries() {
  return [...S.gSelected].map(id => S.ledger.get(id)).filter(Boolean);
}

async function loadGroupDetails(entries) {
  const list = entries || (S.gSelected.size ? selectedEntries() : filteredLedger());
  if (!list.length) return entries ? undefined : toast('No groups to load.');
  S.busy = true;
  const scan = $('#scanInfo');
  const prev = scan.innerHTML;
  scan.textContent = `Loading details for ${plural(list.length, 'group')}…`;
  list.forEach(e => S.groups.delete(e.id)); // always refresh
  await I.resolveGroups(S.graph, list.map(e => e.id), S.groups, { withCounts: true });
  for (const e of list) {
    const g = S.groups.get(e.id);
    if (!g) continue;
    e.info = groupInfoSlim(g);
    if (g.displayName) e.name = g.displayName;
    if (g.missing && e.status === 'pending' && e.origin === 'live') { e.status = 'deleted'; e.error = 'Not found in Entra ID'; }
  }
  S.busy = false;
  scan.innerHTML = prev;
  saveLedger();
  renderGroups();
}

async function runUsageScan() {
  const ids = [...S.ledger.keys()];
  if (!ids.length) return toast('The ledger is empty.');
  S.busy = true;
  const scan = $('#scanInfo');
  const catalog = await ensureCatalog(true);
  S.usage = await I.scanUsage(S.graph, ids, catalog, {
    includePolicies: canScanPolicies(),
    onStatus: t => { scan.textContent = t; },
  });
  S.busy = false;
  renderGroups();
  toast('Usage check complete.');
}

async function openGroupDelete() {
  if (!canDeleteGroups()) return toast('Group deletion needs Group.ReadWrite.All. Sign in again with "Allow deleting groups".', true);
  const sel = selectedEntries();
  if (!sel.length) return toast('Select groups in the ledger first.');
  await loadGroupDetails(sel.filter(e => !e.info || e.info.memberCount == null));

  const classify = (e, opt) => {
    const info = e.info || {};
    if (e.status === 'deleted') return 'Already deleted';
    if (info.onPremisesSyncEnabled) return 'Synced from on-premises AD — delete it there';
    if (!S.dry && e.origin === 'dry') return 'Recorded by a dry run — its assignment still exists';
    const refs = usageRefs(e);
    if (refs == null && opt.requireScan) return 'Usage not checked';
    if (refs && refs.length && !opt.includeInUse) return `Still used by ${plural(refs.length, 'object')}`;
    return null;
  };

  openModal(`
    <h2 id="modalTitle">Delete groups ${modeTag()}</h2>
    <div data-body></div>
    <fieldset><legend>Safety filters</legend>
      <label class="check"><input type="checkbox" name="requireScan" checked> Skip groups whose usage hasn't been checked</label>
      <label class="check"><input type="checkbox" name="includeInUse"> Also delete groups that are still in use elsewhere</label>
    </fieldset>
    ${S.dry ? '<div class="notice info">Dry run: deletions are simulated and written to the activity log.</div>'
      : '<div class="typed"><label><span>Type <code>DELETE</code> to confirm</span><input name="typed" autocomplete="off" spellcheck="false"></label></div>'}
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      ${S.usage == null ? '<button type="button" class="btn" data-scan>Check usage first</button>' : ''}
      <button type="button" class="btn danger" data-go>${S.dry ? 'Simulate deletion' : 'Delete groups'}</button>
    </div>`, form => {
    let targets = [];
    const draw = () => {
      const opt = { requireScan: form.requireScan.checked, includeInUse: form.includeInUse.checked };
      const skipped = [];
      targets = [];
      for (const e of sel) {
        const why = classify(e, opt);
        why ? skipped.push([e, why]) : targets.push(e);
      }
      const members = targets.reduce((n, e) => n + ((e.info && e.info.memberCount) || 0), 0);
      const m365 = targets.filter(e => e.info && (e.info.groupTypes || []).includes('Unified')).length;
      const roles = targets.filter(e => e.info && e.info.isAssignableToRole).length;
      $('[data-body]', form).innerHTML = `
        <div class="preview">Will delete <b>${plural(targets.length, 'group')}</b> (${plural(members, 'member')} in total).</div>
        ${targets.length ? `<ul class="list-compact">${targets.map(e => `<li>${esc(e.name)}</li>`).join('')}</ul>` : ''}
        ${m365 ? `<div class="notice warn">${plural(m365, 'Microsoft 365 group')}: deleting also removes the group's mailbox, files and Team. Restorable for 30 days.</div>` : ''}
        ${roles ? `<div class="notice warn">${plural(roles, 'role-assignable group')} selected.</div>` : ''}
        ${skipped.length ? `<details><summary>${plural(skipped.length, 'group')} skipped</summary><ul class="list-compact">${skipped.map(([e, why]) => `<li>${esc(e.name)} — ${esc(why)}</li>`).join('')}</ul></details>` : ''}`;
    };
    form.addEventListener('input', draw);
    draw();
    wireConfirm(form, 'DELETE', () => targets.length > 0);
    const sc = $('[data-scan]', form);
    if (sc) sc.onclick = () => guard(async () => { closeModal(); await runUsageScan(); await openGroupDelete(); });
    $('[data-go]', form).onclick = () => guard(() => runDeleteGroups(targets));
  });
}

async function runDeleteGroups(entries) {
  const dry = S.dry;
  S.busy = true;
  const ui = progressView('Deleting groups', entries.length);
  let ok = 0, fail = 0;
  const runId = 'g' + Date.now().toString(36);
  await pool(entries, 4, async e => {
    try {
      const r = await S.graph.mutate('DELETE', `/groups/${e.id}`,
        { action: 'Delete group', target: e.name, targetId: e.id, runId,
          detail: e.info && e.info.memberCount != null ? `${e.info.memberCount} member(s)` : '' });
      ok++;
      if (r.dry) {
        e.simulatedDelete = true;
      } else {
        e.status = 'deleted';
        e.deletedAt = new Date().toISOString();
        e.error = r.gone ? 'Already gone' : undefined;
        S.groups.delete(e.id);
      }
      S.gSelected.delete(e.id);
      ui.step(`${dry ? '[dry] ' : ''}deleted  ${e.name}`, 's');
    } catch (err) {
      fail++;
      if (!dry) { e.status = 'failed'; e.error = err.message; }
      ui.step(`FAILED   ${e.name} — ${err.message}`, 'f');
    }
  });
  S.busy = false;
  saveLedger();
  afterLiveRun();
  renderGroups();
  const form = ui.finish(
    `<div class="stats"><div class="stat"><b>${ok}</b><span>${dry ? 'would be deleted' : 'deleted'}</span></div><div class="stat"><b>${fail}</b><span>failed</span></div></div>`,
    '<button type="button" class="btn primary" data-close>Done</button>'
  );
  form.onsubmit = e => e.preventDefault();
}

function markKept() {
  const sel = selectedEntries();
  if (!sel.length) return toast('Select groups first.');
  sel.forEach(e => { if (e.status !== 'deleted') { e.status = 'kept'; e.decidedAt = new Date().toISOString(); } });
  S.gSelected.clear();
  saveLedger();
  renderGroups();
  toast(`${plural(sel.length, 'group')} marked as kept.`);
}

function forgetGroups() {
  const sel = selectedEntries();
  if (!sel.length) return toast('Select groups first.');
  openModal(`<h2 id="modalTitle">Remove ${plural(sel.length, 'group')} from the ledger?</h2>
    <p>This only forgets them in this tool. Nothing changes in Entra ID.</p>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn primary" data-go>Remove from ledger</button></div>`, form => {
    $('[data-go]', form).onclick = () => {
      sel.forEach(e => { S.ledger.delete(e.id); S.gSelected.delete(e.id); });
      saveLedger();
      closeModal();
      renderGroups();
    };
  });
}

// ---------- exports / import ----------
function exportInventory() {
  const rows = [['App', 'AppId', 'Version', 'VersionSource', 'Type', 'Publisher', 'Intent', 'Target', 'GroupName', 'GroupId', 'FilterId', 'FilterType', 'LastModified']];
  for (const app of visibleResults()) {
    const v = I.appVersion(app);
    const base = [app.displayName, app.id, v.value, v.source || '', I.appTypeLabel(app), app.publisher];
    if (!(app.assignments || []).length) rows.push([...base, '', '', '', '', '', '', app.lastModifiedDateTime]);
    for (const a of app.assignments || []) {
      const t = I.targetOf(a);
      rows.push([...base, a.intent, I.TARGET_LABEL[t.kind], t.groupId ? I.groupName(t.groupId, S.groups) : '', t.groupId || '', t.filterId || '', t.filterType, app.lastModifiedDateTime]);
    }
  }
  download(`app-inventory-${stamp()}.csv`, csv(rows), 'text/csv');
}

function exportLedgerCsv() {
  const list = filteredLedger();
  const rows = [['GroupName', 'GroupId', 'Status', 'RecordedBy', 'Type', 'Members', 'StillUsedBy', 'SourceApps', 'RecordedAt', 'DeletedAt']];
  for (const e of list) {
    const refs = usageRefs(e);
    rows.push([
      e.name, e.id, e.status, e.origin === 'dry' ? 'dry run' : 'live', e.info ? I.groupKind(e.info).join(' / ') : '',
      e.info ? e.info.memberCount ?? '' : '', refs == null ? 'not checked' : refs.map(r => `${r.type}: ${r.name}`).join(' | '),
      [...new Set(e.sources.map(s => `${s.appName} (${s.intent}${s.kind === 'exclude' ? ', excluded' : ''})`))].join(' | '),
      e.recordedAt, e.deletedAt || '',
    ]);
  }
  download(`groups-ledger-${stamp()}.csv`, csv(rows), 'text/csv');
}

function exportLedgerJson() {
  const data = {
    tool: TOOL, version: VERSION, exportedAt: new Date().toISOString(),
    tenant: { id: S.claims.tid, user: S.claims.upn },
    runs: S.runs, entries: [...S.ledger.values()],
  };
  download(`groups-ledger-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

async function importLedger(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.tool !== TOOL || !Array.isArray(data.entries)) throw new Error('Not a ledger export from this tool.');
    if (data.tenant && data.tenant.id && S.claims.tid && data.tenant.id !== S.claims.tid && !S.demo) {
      throw new Error('This ledger belongs to a different tenant.');
    }
    const rank = { pending: 0, failed: 1, kept: 2, deleted: 3 };
    let added = 0;
    for (const e of data.entries) {
      if (!e || !e.id || !Array.isArray(e.sources)) continue;
      const cur = S.ledger.get(e.id);
      if (!cur) { S.ledger.set(e.id, e); added++; continue; }
      const seen = new Set(cur.sources.map(s => s.runId + s.appId + s.intent));
      cur.sources.push(...e.sources.filter(s => !seen.has(s.runId + s.appId + s.intent)));
      if ((rank[e.status] || 0) > (rank[cur.status] || 0)) cur.status = e.status;
    }
    for (const r of data.runs || []) if (!S.runs.some(x => x.id === r.id)) S.runs.push(r);
    saveLedger();
    renderGroups();
    toast(`Imported ${plural(added, 'new group')}.`);
  } catch (e) {
    toast('Import failed: ' + e.message, true);
  }
}

// ---------- log ----------
function renderLog() {
  const box = $('#logResults');
  if (!S.log.length) {
    box.innerHTML = '<div class="panel empty">No writes yet in this session.</div>';
    return;
  }
  const rows = S.log.slice().reverse().map(l => `<tr>
    <td class="sub">${esc(fmtTime(l.at))}</td>
    <td><span class="chip ${l.mode === 'DRY' ? 'dry' : 'live'}">${l.mode}</span></td>
    <td>${esc(l.action)}</td>
    <td>${esc(l.target)}<div class="mono">${esc(l.method)} ${esc(l.path)}</div></td>
    <td><span class="chip ${l.result === 'failed' ? 'danger' : l.result === 'simulated' ? '' : 'ok'}">${esc(l.result)}</span>${l.detail ? `<div class="sub">${esc(l.detail)}</div>` : ''}</td>
  </tr>`).join('');
  box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Mode</th><th>Action</th><th>Target</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function exportLog() {
  const rows = [['Time', 'Mode', 'Action', 'Target', 'TargetId', 'Method', 'Path', 'Result', 'Detail']];
  for (const l of S.log) rows.push([l.at, l.mode, l.action, l.target, l.targetId, l.method, l.path, l.result, l.detail || '']);
  download(`activity-log-${stamp()}.csv`, csv(rows), 'text/csv');
}

init();
