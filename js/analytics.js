// Analytics: read-only forensics on apps and groups.
//  * By app   - every assignment of the analysed apps: intent, include/exclude, target, group size.
//  * By group - every group behind them (or found by name) and everything it is assigned to.
//  * Members  - drill into any group: users, devices and nested groups, down to transitive users.
// Nothing here writes to the tenant.

import * as I from './intune.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const odata = v => String(v).replace(/'/g, "''");
const KIND_LABEL = { include: 'Include', exclude: 'Exclude', allUsers: 'All users', allDevices: 'All devices', other: 'Other' };
const INTENTS = ['required', 'available', 'uninstall', 'availableWithoutEnrollment'];

export class Analytics {
  /**
   * @param {HTMLElement} root
   * @param {object} ctx  { graph(), visibleApps(), ensureCatalog(), groupsCache, canScanPolicies(), toast, download, csv, esc, plural, stamp, openModal, closeModal, onBusy }
   */
  constructor(root, ctx) {
    this.root = root;
    this.c = ctx;
    this.view = 'app';
    this.apps = [];        // analysed apps (with assignments)
    this.groupIds = [];    // groups in scope
    this.counts = new Map(); // groupId -> { users, devices, groups, transitiveUsers }
    this.usage = null;     // scanUsage result for groups in scope
    this.versions = new Map(); // appId -> version, for apps found by the scan
    this.source = null;    // 'apps' | 'groups'
    this.filter = { text: '', intents: new Set(INTENTS), kinds: new Set(['include', 'exclude', 'allUsers', 'allDevices', 'other']) };
    this.render();
    root.addEventListener('click', e => this.onClick(e));
    root.addEventListener('input', e => this.onInput(e));
    root.addEventListener('submit', e => { e.preventDefault(); this.findGroups(); });
  }

  // ---------------------------------------------------------------- data

  async analyzeApps() {
    const apps = this.c.visibleApps();
    if (!apps.length) return this.c.toast('Search for apps on the first tab first.');
    this.source = 'apps';
    this.apps = apps;
    this.usage = null;
    this.groupIds = I.groupIdsOf(apps);
    this.view = 'app';
    await this.loadGroupInfo();
    this.render();
  }

  async findGroups() {
    const form = this.root.querySelector('[data-gsearch]');
    const lines = String(form.q.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return this.c.toast('Type at least one group name, wildcard or object ID.');
    const g = this.c.graph();
    this.busy('Finding groups…');
    const reqs = lines.map((l, i) => {
      if (GUID.test(l)) return { id: String(i), url: `/groups/${l}?$select=id,displayName` };
      const plain = l.replace(/^\*+/, '');
      const prefix = plain.split(/[*?]/)[0];
      if (l.startsWith('*') || !prefix) {
        const term = prefix || plain.replace(/[*?]/g, ' ').trim().split(/\s+/)[0] || l.replace(/[*?]/g, '');
        return { id: String(i), url: `/groups?$search=${encodeURIComponent(`"displayName:${term}"`)}&$select=id,displayName&$top=999`, headers: { ConsistencyLevel: 'eventual' } };
      }
      return { id: String(i), url: `/groups?$filter=${encodeURIComponent(`startswith(displayName,'${odata(prefix)}')`)}&$select=id,displayName&$top=999` };
    });
    const res = await g.batch(reqs);
    const found = new Map();
    const missing = [];
    for (let i = 0; i < lines.length; i++) {
      const r = res.get(String(i));
      let list = [];
      if (r && r.status === 200) {
        list = r.body.value ? [...r.body.value] : [r.body];
        if (r.body['@odata.nextLink']) list.push(...(await g.getAll(r.body['@odata.nextLink'], { headers: { ConsistencyLevel: 'eventual' } })));
      }
      const l = lines[i];
      const match = GUID.test(l) ? () => true : I.makeMatcher(/[*?]/.test(l) ? l : l + '*', 'wildcard');
      list = list.filter(x => match(x.displayName || ''));
      if (!list.length) missing.push(l);
      for (const x of list) found.set(x.id, x);
    }
    for (const x of found.values()) {
      const prev = this.c.groupsCache.get(x.id);
      if (!prev || prev.missing) this.c.groupsCache.set(x.id, { ...x, missing: false });
    }
    this.source = 'groups';
    this.apps = [];
    this.groupIds = [...found.keys()];
    this.missing = missing;
    this.view = 'group';
    if (!this.groupIds.length) { this.done(); this.render(); return this.c.toast('No group matched.'); }
    await this.loadGroupInfo();
    await this.scanUsage(true);
    this.render();
  }

  async loadGroupInfo() {
    const g = this.c.graph();
    const ids = this.groupIds.filter(id => !this.counts.has(id));
    this.busy(`Reading ${this.c.plural(this.groupIds.length, 'group')}…`);
    await I.resolveGroups(g, this.groupIds, this.c.groupsCache, {});
    const reqs = [];
    for (const id of ids) {
      for (const t of ['user', 'device', 'group']) reqs.push({ id: `${t}|${id}`, url: `/groups/${id}/members/microsoft.graph.${t}?$count=true&$top=1&$select=id`, headers: { ConsistencyLevel: 'eventual' } });
      reqs.push({ id: `tu|${id}`, url: `/groups/${id}/transitiveMembers/microsoft.graph.user?$count=true&$top=1&$select=id`, headers: { ConsistencyLevel: 'eventual' } });
    }
    const res = await g.batch(reqs, { onProgress: (d, t) => this.busy(`Counting members ${d}/${t}…`) });
    const n = k => { const r = res.get(k); return r && r.status === 200 ? r.body['@odata.count'] ?? null : null; };
    for (const id of ids) this.counts.set(id, { users: n(`user|${id}`), devices: n(`device|${id}`), groups: n(`group|${id}`), transitiveUsers: n(`tu|${id}`) });
    this.done();
  }

  async scanUsage(silent) {
    if (!this.groupIds.length) return;
    const catalog = await this.c.ensureCatalog();
    this.busy('Scanning every app and policy assignment…');
    this.usage = await I.scanUsage(this.c.graph(), this.groupIds, catalog, {
      includePolicies: this.c.canScanPolicies(),
      onStatus: t => this.busy(t),
    });
    // Versions of the apps found (same-name builds are otherwise indistinguishable).
    const ids = [...new Set([...this.usage.refs.values()].flat().filter(r => r.type === 'App' && !this.versions.has(r.objectId)).map(r => r.objectId))];
    if (ids.length) {
      const res = await this.c.graph().batch(ids.map(id => ({ id, url: `/deviceAppManagement/mobileApps/${id}` })), { onProgress: (d, t) => this.busy(`Reading app versions ${d}/${t}…`) });
      for (const id of ids) { const r = res.get(id); this.versions.set(id, r && r.status === 200 ? I.appVersion(r.body).value : ''); }
    }
    this.done();
    if (!silent) this.c.toast('Tenant-wide usage loaded.');
  }

  busy(text) { this.c.onBusy(true); const el = this.root.querySelector('[data-astatus]'); if (el) { el.textContent = text; el.hidden = false; } }
  done() { this.c.onBusy(false); const el = this.root.querySelector('[data-astatus]'); if (el) el.hidden = true; }

  // ---------------------------------------------------------------- rows

  /** Flattened assignment rows of the analysed apps. */
  appRows() {
    const rows = [];
    for (const app of this.apps) {
      const v = I.appVersion(app).value;
      const list = app.assignments || [];
      if (!list.length) rows.push({ app, version: v, intent: '', kind: '', target: 'No assignments', groupId: null, filter: '' });
      for (const a of list) {
        const t = I.targetOf(a);
        rows.push({
          app, version: v, intent: a.intent, kind: t.kind, groupId: t.groupId || null,
          target: t.groupId ? I.groupName(t.groupId, this.c.groupsCache) : KIND_LABEL[t.kind],
          filter: t.filterId ? `${t.filterType} filter` : '',
        });
      }
    }
    return rows;
  }

  /** Per group: every app (and policy) assignment pointing at it. */
  groupRows() {
    const map = new Map(this.groupIds.map(id => [id, []]));
    const seen = new Set();
    const add = (id, ref) => {
      const key = `${id}|${ref.type}|${ref.objectId}|${ref.intent || ''}|${ref.kind}`;
      if (!map.has(id) || seen.has(key)) return;
      seen.add(key);
      map.get(id).push(ref);
    };
    for (const app of this.apps) for (const a of app.assignments || []) {
      const t = I.targetOf(a);
      if (t.groupId) add(t.groupId, { type: 'App', name: app.displayName, version: I.appVersion(app).value, objectId: app.id, kind: t.kind, intent: a.intent, analysed: true });
    }
    if (this.usage) {
      for (const [id, refs] of this.usage.refs) for (const r of refs) {
        const app = r.type === 'App' ? this.apps.find(x => x.id === r.objectId) : null;
        add(id, { ...r, version: app ? I.appVersion(app).value : this.versions.get(r.objectId) || '', analysed: !!app });
      }
    }
    return [...map.entries()].map(([id, refs]) => ({ id, refs, info: this.c.groupsCache.get(id) || { id }, counts: this.counts.get(id) || {} }));
  }

  passes(row) {
    const f = this.filter;
    if (row.intent && !f.intents.has(row.intent)) return false;
    if (row.kind && !f.kinds.has(row.kind)) return false;
    return true;
  }

  textMatch(...vals) {
    const q = this.filter.text.trim().toLowerCase();
    return !q || vals.some(v => String(v || '').toLowerCase().includes(q));
  }

  // ---------------------------------------------------------------- render

  render() {
    const e = this.c.esc;
    const P = this.c.plural;
    const has = this.source != null;
    const groupsN = this.groupIds.length;
    this.root.innerHTML = `
      <div class="panel analytics-head">
        <div class="a-sources">
          <div>
            <h3>Analyse apps</h3>
            <p class="sub">Uses the apps currently shown on <b>1 · Find apps</b> (after its filters).</p>
            <button type="button" class="btn primary" data-a="apps">Analyse ${P(this.c.visibleApps().length, 'app')}</button>
          </div>
          <form data-gsearch class="a-gsearch">
            <h3>Find groups</h3>
            <label class="sub plain" for="aq">Names, wildcards (<code>SG-APP-*</code>, <code>*AnyDesk*</code>) or object IDs — one per line. A plain name matches groups starting with it.</label>
            <textarea id="aq" name="q" rows="2" spellcheck="false" placeholder="SG-APP-7Zip*&#10;*AnyDesk*"></textarea>
            <button type="submit" class="btn">Find groups and their assignments</button>
          </form>
        </div>
        <p class="hint" data-astatus hidden></p>
      </div>
      ${has ? this.renderResults() : `<div class="panel empty">Pick a source above. Analytics is read-only: it shows, for each app, which groups it is required / available / uninstalled for (included or excluded), and what every group contains.</div>`}`;
  }

  renderResults() {
    const e = this.c.esc;
    const P = this.c.plural;
    const intents = INTENTS.map(k => `<label class="check"><input type="checkbox" data-fi="${k}" ${this.filter.intents.has(k) ? 'checked' : ''}> ${e(I.INTENT_LABEL[k])}</label>`).join('');
    const kinds = ['include', 'exclude', 'allUsers', 'allDevices'].map(k => `<label class="check"><input type="checkbox" data-fk="${k}" ${this.filter.kinds.has(k) ? 'checked' : ''}> ${e(KIND_LABEL[k])}</label>`).join('');
    const scan = this.usage
      ? `Tenant-wide usage scanned${this.usage.skipped.length ? ` (not covered: ${e(this.usage.skipped.join('; '))})` : ''}.`
      : `Showing assignments from the analysed apps only. <button type="button" class="btn small" data-a="scan">Also find every other app and policy using these ${P(this.groupIds.length, 'group')}</button>`;
    const missing = this.missing && this.missing.length && this.source === 'groups' ? `<div class="notice warn">No group matched: ${this.missing.map(m => `<code>${e(m)}</code>`).join(' ')}</div>` : '';
    return `${missing}
      <div class="a-toolbar">
        <div class="seg" role="tablist">
          ${this.source === 'apps' ? `<button type="button" data-view="app" class="${this.view === 'app' ? 'on' : ''}">By app <b>${this.apps.length}</b></button>` : ''}
          <button type="button" data-view="group" class="${this.view === 'group' ? 'on' : ''}">By group <b>${this.groupIds.length}</b></button>
        </div>
        <input type="search" data-ftext placeholder="Filter by app, group…" value="${e(this.filter.text)}">
        <span class="grow"></span>
        <button type="button" class="btn" data-a="export">Export CSV</button>
      </div>
      <div class="a-filters"><span class="sub">Intent</span>${intents}<span class="sep"></span><span class="sub">Target</span>${kinds}</div>
      <p class="hint">${scan}</p>
      <div data-abody>${this.view === 'app' ? this.renderByApp() : this.renderByGroup()}</div>`;
  }

  countCells(id) {
    const c = this.counts.get(id) || {};
    const v = x => (x == null ? '–' : x);
    return `<td class="num">${v(c.users)}</td><td class="num">${v(c.devices)}</td><td class="num">${v(c.groups)}</td><td class="num">${v(c.transitiveUsers)}</td>`;
  }

  groupCell(id, name) {
    const e = this.c.esc;
    const info = this.c.groupsCache.get(id);
    const kinds = info ? I.groupKind(info) : [];
    return `<button type="button" class="linkish" data-members="${e(id)}">${e(name)}</button>
      <div class="chips">${kinds.map(k => `<span class="chip ${k === 'Deleted / not found' ? 'danger' : k === 'Synced from AD' || k === 'Dynamic' ? 'warn' : ''}">${e(k)}</span>`).join('')}</div>`;
  }

  renderByApp() {
    const e = this.c.esc;
    const rows = this.appRows().filter(r => (r.groupId || r.kind || r.target === 'No assignments') && (r.intent === '' || this.passes(r)) && this.textMatch(r.app.displayName, r.version, r.target));
    if (!rows.length) return '<div class="panel empty">No assignments match the filters.</div>';
    let last = null;
    const body = rows.map(r => {
      const head = r.app !== last;
      last = r.app;
      const n = (r.app.assignments || []).length;
      return `${head ? `<tr class="app-row"><td colspan="9"><span class="name">${e(r.app.displayName)}</span> ${r.version ? `<span class="ver">${e(r.version)}</span>` : ''} <span class="sub">· ${e(I.appTypeLabel(r.app))} · ${this.c.plural(n, 'assignment')}</span></td></tr>` : ''}
        <tr>
          <td>${r.intent ? `<span class="chip ${e(r.intent)}">${e(I.INTENT_LABEL[r.intent] || r.intent)}</span>` : ''}</td>
          <td>${r.kind ? `<span class="chip ${r.kind === 'exclude' ? 'danger' : r.kind === 'include' ? 'ok' : 'info'}">${e(KIND_LABEL[r.kind])}</span>` : ''}</td>
          <td>${r.groupId ? this.groupCell(r.groupId, r.target) : `<span class="sub">${e(r.target)}</span>`}</td>
          ${r.groupId ? this.countCells(r.groupId) : '<td></td><td></td><td></td><td></td>'}
          <td class="sub">${e(r.filter)}</td>
          <td class="mono">${r.groupId ? e(r.groupId) : ''}</td>
        </tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="a-table">
      <thead><tr><th>Intent</th><th>Target</th><th>Group</th><th class="num">Users</th><th class="num">Devices</th><th class="num">Nested groups</th><th class="num" title="All users, including those in nested groups">All users (nested)</th><th>Filter</th><th>Group ID</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  renderByGroup() {
    const e = this.c.esc;
    const groups = this.groupRows()
      .map(g => ({ ...g, refs: g.refs.filter(r => this.passes(r)) }))
      .filter(g => this.textMatch(g.info.displayName, ...g.refs.map(r => r.name)))
      .sort((a, b) => String(a.info.displayName || '').localeCompare(String(b.info.displayName || ''), undefined, { numeric: true }));
    if (!groups.length) return '<div class="panel empty">No groups match the filters.</div>';
    const body = groups.map(g => {
      const refs = g.refs.sort((a, b) => (a.type === 'App' ? 0 : 1) - (b.type === 'App' ? 0 : 1) || a.name.localeCompare(b.name));
      const list = refs.length ? refs.map(r => `<div class="ref ${r.analysed ? 'analysed' : ''}">
          <span class="chip ${r.kind === 'exclude' ? 'danger' : 'ok'}">${e(KIND_LABEL[r.kind] || r.kind)}</span>
          ${r.intent ? `<span class="chip ${e(r.intent)}">${e(I.INTENT_LABEL[r.intent] || r.intent)}</span>` : `<span class="chip info">${e(r.type)}</span>`}
          <span>${e(r.name)}${r.version ? ` <span class="ver">${e(r.version)}</span>` : ''}</span></div>`).join('')
        : '<span class="sub">No assignment matches the filters</span>';
      return `<tr>
        <td>${this.groupCell(g.id, g.info.missing ? '(deleted group)' : g.info.displayName || g.id)}<div class="mono">${e(g.id)}</div></td>
        ${this.countCells(g.id)}
        <td class="num">${refs.length}</td>
        <td><div class="refs">${list}</div></td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="a-table">
      <thead><tr><th>Group</th><th class="num">Users</th><th class="num">Devices</th><th class="num">Nested groups</th><th class="num">All users (nested)</th><th class="num">Assignments</th><th>Assigned to</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- members drill-down

  async openMembers(id, trail = []) {
    const e = this.c.esc;
    const P = this.c.plural;
    const g = this.c.graph();
    const info = this.c.groupsCache.get(id) || { id, displayName: id };
    const path = [...trail, { id, name: info.displayName || id }];
    this.c.openModal(`<h2 id="modalTitle">${e(info.displayName || id)}</h2><div class="preview">Loading members…</div>
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Close</button></div>`);
    let members;
    try {
      members = await g.getAll(`/groups/${id}/members?$select=id,displayName,userPrincipalName,mail,accountEnabled,deviceId,operatingSystem&$top=999`);
    } catch (err) {
      this.c.openModal(`<h2 id="modalTitle">${e(info.displayName || id)}</h2><div class="notice danger">Could not read members: ${e(err.message)}</div>
        <div class="modal-actions"><button type="button" class="btn ghost" data-close>Close</button></div>`);
      return;
    }
    const type = m => (m['@odata.type'] || '').replace('#microsoft.graph.', '');
    const by = t => members.filter(m => type(m) === t);
    const users = by('user'), devices = by('device'), groups = by('group');
    const other = members.filter(m => !['user', 'device', 'group'].includes(type(m)));
    const state = { tab: groups.length ? 'group' : users.length ? 'user' : 'device', transitive: null, q: '' };
    const kinds = I.groupKind(info);

    const table = () => {
      let list = state.tab === 'all-users' ? state.transitive || [] : state.tab === 'other' ? other : by(state.tab);
      const q = state.q.toLowerCase();
      if (q) list = list.filter(m => [m.displayName, m.userPrincipalName, m.mail, m.id].some(v => String(v || '').toLowerCase().includes(q)));
      if (!list.length) return '<div class="empty">Nothing here.</div>';
      const shown = list.slice(0, 1000);
      const head = state.tab === 'device' ? '<th>Name</th><th>OS</th><th>Entra device ID</th><th>Object ID</th>'
        : state.tab === 'group' ? '<th>Name</th><th></th><th>Object ID</th>'
        : '<th>Name</th><th>UPN</th><th>Mail</th><th>Enabled</th><th>Object ID</th>';
      const row = m => state.tab === 'device'
        ? `<td>${e(m.displayName)}</td><td>${e(m.operatingSystem || '')}</td><td class="mono">${e(m.deviceId || '')}</td><td class="mono">${e(m.id)}</td>`
        : state.tab === 'group'
          ? `<td>${e(m.displayName)}</td><td><button type="button" class="btn small" data-drill="${e(m.id)}">Open ›</button></td><td class="mono">${e(m.id)}</td>`
          : `<td>${e(m.displayName)}</td><td>${e(m.userPrincipalName || '')}</td><td>${e(m.mail || '')}</td><td>${m.accountEnabled === false ? '<span class="chip">Disabled</span>' : ''}</td><td class="mono">${e(m.id)}</td>`;
      return `<div class="table-wrap members-table"><table><thead><tr>${head}</tr></thead><tbody>${shown.map(m => `<tr>${row(m)}</tr>`).join('')}</tbody></table></div>
        ${list.length > shown.length ? `<p class="sub">Showing 1000 of ${list.length}; copy and export include all.</p>` : ''}`;
    };
    const currentList = () => {
      let list = state.tab === 'all-users' ? state.transitive || [] : state.tab === 'other' ? other : by(state.tab);
      const q = state.q.toLowerCase();
      if (q) list = list.filter(m => [m.displayName, m.userPrincipalName, m.mail, m.id].some(v => String(v || '').toLowerCase().includes(q)));
      return list;
    };
    const tabs = [['group', 'Nested groups', groups.length], ['user', 'Users', users.length], ['device', 'Devices', devices.length], ['all-users', 'All users incl. nested', state.transitive ? state.transitive.length : '…']];
    if (other.length) tabs.push(['other', 'Other', other.length]);

    const draw = form => {
      form.querySelector('[data-mtabs]').innerHTML = tabs.map(([k, l, n]) => `<button type="button" data-mtab="${k}" class="${state.tab === k ? 'on' : ''}">${e(l)} <b>${n}</b></button>`).join('');
      form.querySelector('[data-mlist]').innerHTML = table();
    };
    this.c.openModal(`
      <h2 id="modalTitle">${e(info.displayName || id)}</h2>
      <div class="crumbs" ${path.length < 2 ? 'hidden' : ''}>${path.map((p, i) => i < path.length - 1 ? `<button type="button" class="linkish" data-crumb="${i}">${e(p.name)}</button> ›` : `<b>${e(p.name)}</b>`).join(' ')}</div>
      <div class="chips">${kinds.map(k => `<span class="chip">${e(k)}</span>`).join('')}${info.membershipRule ? `<span class="chip warn" title="${e(info.membershipRule)}">Rule: ${e(info.membershipRule)}</span>` : ''}</div>
      <p class="sub">${P(members.length, 'direct member')}: ${P(users.length, 'user')}, ${P(devices.length, 'device')}, ${P(groups.length, 'nested group')}${other.length ? `, ${other.length} other` : ''}.</p>
      <div class="seg" data-mtabs></div>
      <div class="a-toolbar"><input type="search" data-mq placeholder="Filter members…"><span class="grow"></span>
        <button type="button" class="btn small" data-mcopy="upn">Copy UPNs</button>
        <button type="button" class="btn small" data-mcopy="name">Copy names</button>
        <button type="button" class="btn small" data-mcopy="id">Copy object IDs</button>
        <button type="button" class="btn small" data-mexport>Export CSV</button></div>
      <div data-mlist></div>
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Close</button></div>`, form => {
      form.closest('dialog').classList.add('wide');
      draw(form);
      form.addEventListener('input', ev => { if (ev.target.matches('[data-mq]')) { state.q = ev.target.value; form.querySelector('[data-mlist]').innerHTML = table(); } });
      form.addEventListener('click', async ev => {
        const t = ev.target;
        const tab = t.closest('[data-mtab]');
        if (tab) {
          state.tab = tab.dataset.mtab;
          if (state.tab === 'all-users' && !state.transitive) {
            form.querySelector('[data-mlist]').innerHTML = '<div class="empty">Loading every user in this group and its nested groups…</div>';
            try {
              state.transitive = await g.getAll(`/groups/${id}/transitiveMembers/microsoft.graph.user?$select=id,displayName,userPrincipalName,mail,accountEnabled&$top=999`);
            } catch (err) { state.transitive = []; this.c.toast(`Could not read nested users: ${err.message}`, true); }
            tabs.find(x => x[0] === 'all-users')[2] = state.transitive.length;
          }
          return draw(form);
        }
        const drill = t.closest('[data-drill]');
        if (drill) {
          const m = groups.find(x => x.id === drill.dataset.drill);
          if (m && !this.c.groupsCache.has(m.id)) this.c.groupsCache.set(m.id, { ...m, missing: false });
          return this.openMembers(drill.dataset.drill, path);
        }
        const crumb = t.closest('[data-crumb]');
        if (crumb) { const i = Number(crumb.dataset.crumb); return this.openMembers(path[i].id, path.slice(0, i)); }
        const copy = t.closest('[data-mcopy]');
        if (copy) {
          const list = currentList();
          const key = copy.dataset.mcopy;
          const vals = [...new Set(list.map(m => (key === 'upn' ? m.userPrincipalName || m.mail : key === 'name' ? m.displayName : m.id)).filter(Boolean))];
          if (!vals.length) return this.c.toast('Nothing to copy here.');
          try { await navigator.clipboard.writeText(vals.join('\n')); this.c.toast(`Copied ${vals.length} value${vals.length === 1 ? '' : 's'}.`); }
          catch { this.c.toast('Copy failed — your browser blocked the clipboard.', true); }
          return;
        }
        if (t.closest('[data-mexport]')) {
          const list = currentList();
          const rows = [['Group', 'GroupId', 'Path', 'MemberType', 'DisplayName', 'UPN', 'Mail', 'Enabled', 'OS', 'EntraDeviceId', 'ObjectId']];
          for (const m of list) rows.push([info.displayName, id, path.map(p => p.name).join(' > '), type(m) || 'user', m.displayName, m.userPrincipalName || '', m.mail || '', m.accountEnabled === false ? 'false' : 'true', m.operatingSystem || '', m.deviceId || '', m.id]);
          this.c.download(`members-${(info.displayName || id).replace(/[^\w.-]+/g, '_')}-${state.tab}-${this.c.stamp()}.csv`, this.c.csv(rows), 'text/csv');
        }
      });
    });
  }

  // ---------------------------------------------------------------- export

  exportCsv() {
    const rows = [];
    if (this.view === 'app') {
      rows.push(['App', 'Version', 'AppId', 'Intent', 'Target', 'Group', 'GroupId', 'GroupType', 'Users', 'Devices', 'NestedGroups', 'AllUsersNested', 'Filter']);
      for (const r of this.appRows()) {
        if (r.intent && !this.passes(r)) continue;
        if (!this.textMatch(r.app.displayName, r.version, r.target)) continue;
        const c = (r.groupId && this.counts.get(r.groupId)) || {};
        const info = r.groupId && this.c.groupsCache.get(r.groupId);
        rows.push([r.app.displayName, r.version, r.app.id, r.intent ? I.INTENT_LABEL[r.intent] || r.intent : '', r.kind ? KIND_LABEL[r.kind] : '', r.target, r.groupId || '',
          info ? I.groupKind(info).join(' / ') : '', c.users ?? '', c.devices ?? '', c.groups ?? '', c.transitiveUsers ?? '', r.filter]);
      }
    } else {
      rows.push(['Group', 'GroupId', 'GroupType', 'Users', 'Devices', 'NestedGroups', 'AllUsersNested', 'AssignedToType', 'AssignedTo', 'Version', 'Intent', 'Target']);
      for (const g of this.groupRows()) {
        if (!this.textMatch(g.info.displayName, ...g.refs.map(r => r.name))) continue;
        const base = [g.info.displayName || '', g.id, I.groupKind(g.info).join(' / '), g.counts.users ?? '', g.counts.devices ?? '', g.counts.groups ?? '', g.counts.transitiveUsers ?? ''];
        const refs = g.refs.filter(r => this.passes(r));
        if (!refs.length) rows.push([...base, '', '', '', '', '']);
        for (const r of refs) rows.push([...base, r.type, r.name, r.version || '', r.intent ? I.INTENT_LABEL[r.intent] || r.intent : '', KIND_LABEL[r.kind] || r.kind]);
      }
    }
    this.c.download(`analytics-by-${this.view}-${this.c.stamp()}.csv`, this.c.csv(rows), 'text/csv');
  }

  // ---------------------------------------------------------------- events

  async onClick(e) {
    const t = e.target;
    const run = async fn => { try { await fn(); } catch (err) { this.done(); this.c.toast(err.message || String(err), true); } };
    const a = t.closest('[data-a]');
    if (a) {
      if (a.dataset.a === 'apps') return run(() => this.analyzeApps());
      if (a.dataset.a === 'scan') return run(async () => { await this.scanUsage(); this.render(); });
      if (a.dataset.a === 'export') return this.exportCsv();
    }
    const v = t.closest('[data-view]');
    if (v) { this.view = v.dataset.view; return this.render(); }
    const m = t.closest('[data-members]');
    if (m) return run(() => this.openMembers(m.dataset.members));
  }

  onInput(e) {
    const t = e.target;
    if (t.matches('[data-ftext]')) {
      this.filter.text = t.value;
      this.root.querySelector('[data-abody]').innerHTML = this.view === 'app' ? this.renderByApp() : this.renderByGroup();
      return;
    }
    if (t.matches('[data-fi]')) { t.checked ? this.filter.intents.add(t.dataset.fi) : this.filter.intents.delete(t.dataset.fi); }
    else if (t.matches('[data-fk]')) { t.checked ? this.filter.kinds.add(t.dataset.fk) : this.filter.kinds.delete(t.dataset.fk); }
    else return;
    this.root.querySelector('[data-abody]').innerHTML = this.view === 'app' ? this.renderByApp() : this.renderByGroup();
  }

  refreshSourceButton() {
    const b = this.root.querySelector('[data-a=apps]');
    if (b) b.textContent = `Analyse ${this.c.plural(this.c.visibleApps().length, 'app')}`;
  }
}
