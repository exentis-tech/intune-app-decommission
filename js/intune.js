// Intune / Entra domain logic: catalog, matching, assignments, groups, usage scan.

export const INTENTS = ['required', 'available', 'uninstall', 'availableWithoutEnrollment'];
export const INTENT_LABEL = {
  required: 'Required',
  available: 'Available',
  uninstall: 'Uninstall',
  availableWithoutEnrollment: 'Available (no enrollment)',
};
export const TARGET_LABEL = {
  include: 'Included group',
  exclude: 'Excluded group',
  allUsers: 'All users',
  allDevices: 'All devices',
  other: 'Other target',
};

const TYPE_LABEL = {
  win32LobApp: 'Windows app (Win32)',
  win32CatalogApp: 'Enterprise App Catalog',
  windowsMobileMSI: 'Windows MSI line-of-business',
  winGetApp: 'Microsoft Store app (new)',
  microsoftStoreForBusinessApp: 'Microsoft Store for Business',
  officeSuiteApp: 'Microsoft 365 Apps',
  windowsMicrosoftEdgeApp: 'Microsoft Edge (Windows)',
  macOSMicrosoftEdgeApp: 'Microsoft Edge (macOS)',
  macOSMicrosoftDefenderApp: 'Microsoft Defender (macOS)',
  macOSOfficeSuiteApp: 'Microsoft 365 Apps (macOS)',
  windowsUniversalAppX: 'Windows MSIX / AppX LOB',
  windowsAppX: 'Windows AppX',
  windowsWebApp: 'Windows web link',
  webApp: 'Web link',
  iosLobApp: 'iOS LOB app',
  iosStoreApp: 'iOS store app',
  iosVppApp: 'iOS VPP app',
  managedIOSStoreApp: 'Managed iOS store app',
  managedIOSLobApp: 'Managed iOS LOB app',
  macOSLobApp: 'macOS LOB app',
  macOSDmgApp: 'macOS app (DMG)',
  macOSPkgApp: 'macOS app (PKG)',
  macOsVppApp: 'macOS VPP app',
  macOSWebClip: 'macOS web clip',
  iosiPadOSWebClip: 'iOS/iPadOS web clip',
  androidLobApp: 'Android LOB app',
  androidStoreApp: 'Android store app',
  androidManagedStoreApp: 'Managed Google Play app',
  androidManagedStoreWebApp: 'Managed Google Play web link',
  managedAndroidStoreApp: 'Managed Android store app',
  managedAndroidLobApp: 'Managed Android LOB app',
  androidForWorkApp: 'Android Enterprise app',
};

// App types that are synced from an external store; deleting them may fail or they may come back.
const SYNCED_TYPES = new Set(['iosVppApp', 'macOsVppApp', 'androidManagedStoreApp', 'microsoftStoreForBusinessApp', 'androidForWorkApp']);

export function appType(app) {
  return (app['@odata.type'] || '').replace('#microsoft.graph.', '');
}
export function appTypeLabel(app) {
  const t = appType(app);
  return TYPE_LABEL[t] || t || 'App';
}

export function appFlags(app) {
  const flags = [];
  const dep = app.dependentAppCount || 0;
  const sup = (app.supersedingAppCount || 0) + (app.supersededAppCount || 0);
  if (dep) flags.push({ key: 'dependency', level: 'warn', text: `${dep} dependent app${dep > 1 ? 's' : ''}` });
  if (sup) flags.push({ key: 'supersedence', level: 'warn', text: 'Supersedence relationship' });
  if (SYNCED_TYPES.has(appType(app))) flags.push({ key: 'synced', level: 'info', text: 'Synced from store' });
  return flags;
}

export function blocksDelete(app) {
  return appFlags(app).some(f => f.key === 'dependency' || f.key === 'supersedence');
}

// ---------- name matching ----------

export const MATCH_MODES = {
  contains: 'Contains',
  exact: 'Exact name',
  startsWith: 'Starts with',
  wildcard: 'Wildcard (* ?)',
  regex: 'Regular expression',
};

function wildcardToRegex(p) {
  const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** Build a predicate (name) => boolean. Throws on an invalid regex. */
export function makeMatcher(pattern, mode) {
  const p = String(pattern || '').trim();
  const lp = p.toLowerCase();
  switch (mode) {
    case 'exact': return n => String(n || '').trim().toLowerCase() === lp;
    case 'startsWith': return n => String(n || '').toLowerCase().startsWith(lp);
    case 'wildcard': { const re = wildcardToRegex(p); return n => re.test(String(n || '')); }
    case 'regex': { const re = new RegExp(p, 'i'); return n => re.test(String(n || '')); }
    default: return n => String(n || '').toLowerCase().includes(lp);
  }
}

export function parsePatterns(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
}

/** Match a catalog against many patterns. Returns matched apps and the patterns that matched nothing. */
export function matchApps(apps, patterns, mode, excludeText) {
  const matchers = patterns.map(p => ({ p, fn: makeMatcher(p, mode), hits: 0 }));
  const excludes = String(excludeText || '')
    .split(';').map(s => s.trim()).filter(Boolean)
    .map(p => makeMatcher(p, mode === 'regex' ? 'regex' : /[*?]/.test(p) ? 'wildcard' : 'contains'));
  const matched = [];
  for (const app of apps) {
    const name = app.displayName || '';
    let hit = false;
    for (const m of matchers) {
      if (m.fn(name)) { m.hits++; hit = true; }
    }
    if (hit && !excludes.some(x => x(name))) matched.push(app);
  }
  return { matched, unmatched: matchers.filter(m => !m.hits).map(m => m.p) };
}

// ---------- catalog & assignments ----------

const APP_SELECT = 'id,displayName,publisher,createdDateTime,lastModifiedDateTime,isAssigned,dependentAppCount,supersedingAppCount,supersededAppCount';

export async function loadCatalog(graph, onProgress) {
  try {
    return await graph.getAll(`/deviceAppManagement/mobileApps?$select=${APP_SELECT}`, { onPage: onProgress });
  } catch (e) {
    if (e.status === 400) {
      // Some tenants reject relationship-count properties in $select; fall back to full objects.
      return graph.getAll('/deviceAppManagement/mobileApps', { onPage: onProgress });
    }
    throw e;
  }
}

// Version lives on the derived app types, so it isn't in the catalog list; read each matched app once.
const VERSION_PROPS = ['displayVersion', 'productVersion', 'versionNumber', 'versionName', 'primaryBundleVersion', 'version', 'buildNumber'];

/**
 * Best available version of an app.
 * @returns {{ value: string, source: 'app'|'name'|null }}
 */
export function appVersion(app) {
  for (const k of VERSION_PROPS) {
    const v = app[k];
    if (v != null && String(v).trim()) return { value: String(v).trim(), source: 'app' };
  }
  const m = String(app.displayName || '').match(/(?:^|[^\d.])v?(\d+(?:\.\d+)+(?:[a-z]\d*)?|\d+u\d+)(?![\d.])/i);
  if (m) return { value: m[1], source: 'name' };
  return { value: '', source: null };
}

/** Compare dotted versions numerically: 8.10 > 8.9, 22.01 > 19.00. */
export function compareVersions(a, b) {
  const pa = String(a).toLowerCase().split(/[^0-9a-z]+/).filter(Boolean);
  const pb = String(b).toLowerCase().split(/[^0-9a-z]+/).filter(Boolean);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    const c = nx && ny ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true });
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}

export const VERSION_OPS = {
  any: 'Any version',
  eq: 'Is',
  contains: 'Contains',
  lt: 'Older than',
  le: 'Up to',
  gt: 'Newer than',
  ge: 'From',
  none: 'No version',
};

/** Build a predicate on an app's version. Wildcards (*, ?) work with "Is". */
export function makeVersionFilter(op, value) {
  const v = String(value || '').trim();
  if (op === 'none') return app => !appVersion(app).value;
  if (op === 'any' || !v) return () => true;
  return app => {
    const ver = appVersion(app).value;
    if (!ver) return false;
    switch (op) {
      case 'eq': return /[*?]/.test(v) ? makeMatcher(v, 'wildcard')(ver) : compareVersions(ver, v) === 0;
      case 'contains': return ver.toLowerCase().includes(v.toLowerCase());
      case 'lt': return compareVersions(ver, v) < 0;
      case 'le': return compareVersions(ver, v) <= 0;
      case 'gt': return compareVersions(ver, v) > 0;
      case 'ge': return compareVersions(ver, v) >= 0;
      default: return true;
    }
  };
}

export async function loadAssignments(graph, apps, onProgress, { withDetails = false } = {}) {
  const reqs = apps.map(a => ({ id: a.id, url: `/deviceAppManagement/mobileApps/${a.id}/assignments` }));
  if (withDetails) reqs.push(...apps.map(a => ({ id: 'd' + a.id, url: `/deviceAppManagement/mobileApps/${a.id}` })));
  const res = await graph.batch(reqs, { onProgress });
  for (const app of apps) {
    const d = res.get('d' + app.id);
    if (d && d.status === 200 && d.body) {
      for (const k of VERSION_PROPS) if (d.body[k] != null) app[k] = d.body[k];
      for (const k of ['dependentAppCount', 'supersedingAppCount', 'supersededAppCount']) if (app[k] == null && d.body[k] != null) app[k] = d.body[k];
    }
    const r = res.get(app.id);
    if (r && r.status === 200) {
      app.assignments = (r.body && r.body.value) || [];
      app.assignmentsError = null;
    } else {
      app.assignments = app.assignments || [];
      app.assignmentsError = r ? `${r.status} ${(r.body && r.body.error && r.body.error.message) || ''}`.trim() : 'No response';
    }
  }
  return apps;
}

export function targetOf(assignment) {
  const t = assignment.target || {};
  const type = (t['@odata.type'] || '').replace('#microsoft.graph.', '');
  const base = {
    filterId: t.deviceAndAppManagementAssignmentFilterId || null,
    filterType: t.deviceAndAppManagementAssignmentFilterType || 'none',
  };
  switch (type) {
    case 'groupAssignmentTarget': return { ...base, kind: 'include', groupId: t.groupId };
    case 'exclusionGroupAssignmentTarget': return { ...base, kind: 'exclude', groupId: t.groupId };
    case 'allLicensedUsersAssignmentTarget': return { ...base, kind: 'allUsers' };
    case 'allDevicesAssignmentTarget': return { ...base, kind: 'allDevices' };
    default: return { ...base, kind: 'other', type };
  }
}

export function groupIdsOf(apps) {
  const ids = new Set();
  for (const a of apps) for (const as of a.assignments || []) {
    const t = targetOf(as);
    if (t.groupId) ids.add(t.groupId);
  }
  return [...ids];
}

const GROUP_SELECT = 'id,displayName,description,groupTypes,securityEnabled,mailEnabled,membershipRule,onPremisesSyncEnabled,isAssignableToRole,createdDateTime';

/** Fetch group details (+ member count). Missing groups come back as { missing: true }. */
export async function resolveGroups(graph, ids, cache, { withCounts = false, onProgress } = {}) {
  const need = ids.filter(id => !cache.has(id) || (withCounts && cache.get(id).memberCount == null && !cache.get(id).missing));
  if (!need.length) return cache;
  const reqs = need.map(id => ({ id: 'g' + id, url: `/groups/${id}?$select=${GROUP_SELECT}` }));
  if (withCounts) {
    for (const id of need) {
      reqs.push({
        id: 'c' + id,
        url: `/groups/${id}/members?$count=true&$top=1&$select=id`,
        headers: { ConsistencyLevel: 'eventual' },
      });
    }
  }
  const res = await graph.batch(reqs, { onProgress });
  for (const id of need) {
    const g = res.get('g' + id);
    const prev = cache.get(id) || {};
    if (g && g.status === 200) {
      const c = res.get('c' + id);
      cache.set(id, {
        ...prev,
        ...g.body,
        missing: false,
        memberCount: c && c.status === 200 ? c.body['@odata.count'] ?? null : prev.memberCount ?? null,
      });
    } else if (g && g.status === 404) {
      cache.set(id, { id, displayName: null, missing: true });
    } else {
      cache.set(id, { ...prev, id, error: g ? g.status : 'no response' });
    }
  }
  return cache;
}

export function groupKind(g) {
  if (!g) return [];
  if (g.missing) return ['Deleted / not found'];
  const out = [];
  out.push((g.groupTypes || []).includes('Unified') ? 'Microsoft 365' : g.securityEnabled ? 'Security' : 'Distribution');
  if ((g.groupTypes || []).includes('DynamicMembership')) out.push('Dynamic');
  if (g.onPremisesSyncEnabled) out.push('Synced from AD');
  if (g.isAssignableToRole) out.push('Role-assignable');
  return out;
}

export function groupName(id, cache) {
  const g = cache.get(id);
  if (!g) return id;
  if (g.missing) return '(deleted group)';
  return g.displayName || id;
}

// ---------- usage scan ----------

const POLICY_SOURCES = [
  { label: 'Configuration profile', url: '/deviceManagement/deviceConfigurations?$expand=assignments&$select=id,displayName' },
  { label: 'Settings catalog policy', url: '/deviceManagement/configurationPolicies?$expand=assignments&$select=id,name', name: 'name' },
  { label: 'Compliance policy', url: '/deviceManagement/deviceCompliancePolicies?$expand=assignments&$select=id,displayName' },
  { label: 'Administrative template', url: '/deviceManagement/groupPolicyConfigurations?$expand=assignments&$select=id,displayName' },
  { label: 'Platform script', url: '/deviceManagement/deviceManagementScripts?$expand=assignments&$select=id,displayName' },
  { label: 'Remediation', url: '/deviceManagement/deviceHealthScripts?$expand=assignments&$select=id,displayName' },
  { label: 'App configuration policy', url: '/deviceAppManagement/mobileAppConfigurations?$expand=assignments&$select=id,displayName' },
];

/**
 * Find every app / policy assignment that still references the given groups.
 * @returns {{ refs: Map<string, {type:string, name:string, objectId:string, kind:string}[]>, skipped: string[], scannedAt: string }}
 */
export async function scanUsage(graph, groupIds, catalog, { includePolicies = true, onStatus } = {}) {
  const wanted = new Set(groupIds);
  const refs = new Map(groupIds.map(id => [id, []]));
  const skipped = [];
  const add = (gid, ref) => { if (wanted.has(gid)) refs.get(gid).push(ref); };

  onStatus && onStatus(`Reading assignments of ${catalog.length} apps…`);
  const res = await graph.batch(
    catalog.map(a => ({ id: a.id, url: `/deviceAppManagement/mobileApps/${a.id}/assignments` })),
    { onProgress: (d, t) => onStatus && onStatus(`Reading app assignments ${d}/${t}…`) }
  );
  let appFailures = 0;
  for (const app of catalog) {
    const r = res.get(app.id);
    if (!r || r.status !== 200) { appFailures++; continue; }
    for (const as of r.body.value || []) {
      const t = targetOf(as);
      if (t.groupId) add(t.groupId, { type: 'App', name: app.displayName, objectId: app.id, kind: t.kind, intent: as.intent });
    }
  }
  if (appFailures) skipped.push(`${appFailures} app(s) could not be read`);

  if (includePolicies) {
    for (const src of POLICY_SOURCES) {
      onStatus && onStatus(`Scanning ${src.label.toLowerCase()}s…`);
      try {
        const items = await graph.getAll(src.url);
        for (const it of items) {
          for (const as of it.assignments || []) {
            const t = targetOf(as);
            if (t.groupId) add(t.groupId, { type: src.label, name: it[src.name || 'displayName'] || it.id, objectId: it.id, kind: t.kind });
          }
        }
      } catch (e) {
        skipped.push(`${src.label}s (${e.status || ''} ${e.status === 403 ? 'no permission' : e.message})`.replace('( ', '('));
      }
    }
  } else {
    skipped.push('Policies (scan disabled)');
  }
  return { refs, skipped, scannedAt: new Date().toISOString() };
}
