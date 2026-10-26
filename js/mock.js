// In-memory demo tenant that answers the Graph calls this app makes.
// Lets anyone try every workflow (dry run and live) without touching a real tenant.

let seed = 20261026;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
function guid() {
  const h = () => Math.floor(rnd() * 16).toString(16);
  const s = n => Array.from({ length: n }, h).join('');
  return `${s(8)}-${s(4)}-4${s(3)}-a${s(3)}-${s(12)}`;
}
const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();

export function createDemoTenant() {
  seed = 20261026;
  const groups = new Map();
  const mkGroup = (name, extra = {}) => {
    const g = {
      id: guid(), displayName: name, description: '', groupTypes: [], securityEnabled: true, mailEnabled: false,
      membershipRule: null, onPremisesSyncEnabled: null, isAssignableToRole: false, createdDateTime: daysAgo(400 + Math.floor(rnd() * 900)),
      _members: Math.floor(rnd() * 400) + 3, ...extra,
    };
    groups.set(g.id, g);
    return g;
  };

  const G = {
    zip19: mkGroup('SG-APP-7Zip-19.00-Required'),
    zip22: mkGroup('SG-APP-7Zip-22.01-Required'),
    zip22u: mkGroup('SG-APP-7Zip-22.01-Uninstall'),
    zip23: mkGroup('SG-APP-7Zip-23.01-Required'),
    acro21: mkGroup('SG-APP-AcrobatReader-2021-Users'),
    acro21x: mkGroup('SG-APP-AcrobatReader-2021-Exclude'),
    chrome98: mkGroup('SG-APP-Chrome98-Legacy'),
    npp795: mkGroup('SG-APP-NotepadPP-7.9.5'),
    npp842: mkGroup('SG-APP-NotepadPP-8.4.2'),
    java202: mkGroup('SG-APP-Java8u202-Required'),
    java381: mkGroup('SG-APP-Java8u381-Required'),
    zoom510: mkGroup('SG-APP-Zoom-5.10-Available'),
    vlc311: mkGroup('SG-APP-VLC-3.0.11'),
    winrar: mkGroup('SG-APP-WinRAR-Retired'),
    anyconnect: mkGroup('SG-APP-AnyConnect-4.9-Required'),
    teams: mkGroup('M365-Teams-Classic-Pilot', { groupTypes: ['Unified'], mailEnabled: true }),
    filezilla: mkGroup('SG-APP-FileZilla-Old'),
    putty076: mkGroup('SG-APP-Putty-0.76'),
    finance: mkGroup('SG-Devices-Finance'),
    paris: mkGroup('AD-Workstations-Paris', { onPremisesSyncEnabled: true }),
    dynWin10: mkGroup('DYN-Windows10-Devices', { membershipRule: '(device.deviceOSVersion -startsWith "10.0.1")', groupTypes: ['DynamicMembership'] }),
    pilot: mkGroup('SG-Pilot-Ring', { _members: 12 }),
  };
  const ghostGroupId = guid(); // assigned somewhere but already deleted in Entra

  const apps = new Map();
  const mkApp = (name, type, publisher, assigns = [], extra = {}) => {
    const id = guid();
    const app = {
      '@odata.type': `#microsoft.graph.${type}`, id, displayName: name, publisher,
      createdDateTime: daysAgo(300 + Math.floor(rnd() * 900)), lastModifiedDateTime: daysAgo(30 + Math.floor(rnd() * 600)),
      dependentAppCount: 0, supersedingAppCount: 0, supersededAppCount: 0, ...extra,
    };
    app._assignments = assigns.map(([kind, intent, groupId, filter]) => {
      const target =
        kind === 'include' ? { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId } :
        kind === 'exclude' ? { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId } :
        kind === 'allUsers' ? { '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget' } :
        { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' };
      if (filter) { target.deviceAndAppManagementAssignmentFilterId = filter; target.deviceAndAppManagementAssignmentFilterType = 'include'; }
      else { target.deviceAndAppManagementAssignmentFilterType = 'none'; }
      return { id: `${groupId || kind}_${intent}_${Math.floor(rnd() * 1e6)}`, intent, source: 'direct', target };
    });
    app.isAssigned = app._assignments.length > 0;
    apps.set(id, app);
    return app;
  };

  const W = 'win32LobApp';
  mkApp('7-Zip 19.00', W, 'Igor Pavlov', [['include', 'required', G.zip19.id], ['include', 'required', G.finance.id]]);
  mkApp('7-Zip 22.01', W, 'Igor Pavlov', [['include', 'required', G.zip22.id], ['include', 'uninstall', G.zip22u.id], ['exclude', 'required', G.pilot.id]]);
  mkApp('7-Zip 23.01', W, 'Igor Pavlov', [['include', 'required', G.zip23.id], ['allDevices', 'available', null]]);
  mkApp('Adobe Acrobat Reader DC 2021', W, 'Adobe', [['include', 'required', G.acro21.id], ['exclude', 'required', G.acro21x.id], ['include', 'available', G.paris.id]]);
  mkApp('Adobe Acrobat Reader DC 2023', W, 'Adobe', [['allUsers', 'available', null]]);
  mkApp('Google Chrome 98 (Legacy)', 'windowsMobileMSI', 'Google', [['include', 'required', G.chrome98.id], ['include', 'required', ghostGroupId]]);
  mkApp('Google Chrome Enterprise', W, 'Google', [['allDevices', 'required', null, guid()]]);
  mkApp('Notepad++ 7.9.5', W, 'Notepad++ Team', [['include', 'required', G.npp795.id]]);
  mkApp('Notepad++ 8.4.2', W, 'Notepad++ Team', [['include', 'required', G.npp842.id], ['include', 'available', G.dynWin10.id]], { supersededAppCount: 1 });
  mkApp('Notepad++ 8.6.4', W, 'Notepad++ Team', [['include', 'required', G.npp842.id]], { supersedingAppCount: 1 });
  mkApp('Java Runtime 8u202', W, 'Oracle', [['include', 'required', G.java202.id]], { dependentAppCount: 1 });
  mkApp('Java Runtime 8u381', W, 'Oracle', [['include', 'required', G.java381.id]]);
  mkApp('Zoom Client 5.10', 'windowsMobileMSI', 'Zoom', [['include', 'available', G.zoom510.id], ['allUsers', 'available', null]]);
  mkApp('Zoom Workplace', W, 'Zoom', [['allUsers', 'available', null]]);
  mkApp('VLC media player 3.0.11', W, 'VideoLAN', [['include', 'available', G.vlc311.id]]);
  mkApp('VLC media player 3.0.20', W, 'VideoLAN', [['allUsers', 'available', null]]);
  mkApp('WinRAR 5.91 (Retired)', W, 'win.rar GmbH', [['include', 'uninstall', G.winrar.id]]);
  mkApp('Cisco AnyConnect 4.9', W, 'Cisco', [['include', 'required', G.anyconnect.id], ['include', 'required', G.finance.id]]);
  mkApp('Cisco Secure Client 5.1', W, 'Cisco', [['include', 'required', G.finance.id]]);
  mkApp('Microsoft Teams Classic (Retired)', 'windowsMobileMSI', 'Microsoft', [['include', 'required', G.teams.id]]);
  mkApp('FileZilla 3.55 (Old)', W, 'Tim Kosse', [['include', 'available', G.filezilla.id]]);
  mkApp('PuTTY 0.76', 'windowsMobileMSI', 'Simon Tatham', [['include', 'required', G.putty076.id]]);
  mkApp('PuTTY 0.80', 'windowsMobileMSI', 'Simon Tatham', []);
  mkApp('Microsoft 365 Apps for enterprise', 'officeSuiteApp', 'Microsoft', [['allDevices', 'required', null]]);
  mkApp('Company Portal', 'winGetApp', 'Microsoft Corporation', [['allDevices', 'required', null]]);
  mkApp('Microsoft Authenticator', 'iosVppApp', 'Microsoft Corporation', [['allUsers', 'available', null]]);
  mkApp('Outlook (Android)', 'androidManagedStoreApp', 'Microsoft Corporation', [['allUsers', 'available', null]]);
  for (const [v, a] of [['7.6.2', []], ['7.9.1', [['include', 'required', G.pilot.id]]], ['8.0.4', [['include', 'required', G.pilot.id], ['include', 'uninstall', G.winrar.id]]], ['8.1.0', [['allUsers', 'available', null]]]]) {
    mkApp('AnyDesk_User', W, 'AnyDesk', a, { displayVersion: v });
  }
  for (const [v, a] of [['3.4.1', [['include', 'required', G.filezilla.id]]], ['3.10.0', [['allUsers', 'available', null]]]]) {
    mkApp('Contoso Agent', 'windowsMobileMSI', 'Contoso IT', a, { productVersion: v });
  }
  for (let i = 1; i <= 54; i++) {
    mkApp(`LOB Tool ${String(i).padStart(2, '0')}`, i % 3 ? W : 'windowsMobileMSI', 'Contoso IT', i % 4 ? [] : [['include', 'required', G.pilot.id]]);
  }

  const policies = {
    deviceConfigurations: [
      { id: guid(), displayName: 'WIN - BitLocker - Finance', assignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: G.finance.id } }] },
      { id: guid(), displayName: 'WIN - Wi-Fi - Paris', assignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: G.paris.id } }] },
    ],
    configurationPolicies: [
      { id: guid(), name: 'WIN - Edge baseline', assignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: G.dynWin10.id } }] },
    ],
    deviceCompliancePolicies: [
      { id: guid(), displayName: 'WIN - Compliance - Pilot', assignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: G.pilot.id } }] },
    ],
    groupPolicyConfigurations: [],
    deviceManagementScripts: [
      { id: guid(), displayName: 'Remove Java 8u202 leftovers', assignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: G.java202.id } }] },
    ],
    mobileAppConfigurations: [],
  };

  const json = (status, body, headers) => ({ status, body, headers: headers || {} });
  const err = (status, code, message) => json(status, { error: { code, message } });

  function strip(u) {
    const url = new URL(u, 'https://graph.microsoft.com');
    return { path: url.pathname.replace(/^\/(beta|v1\.0)/, ''), q: url.searchParams };
  }

  function handle(method, rawUrl, body, headers, inBatch) {
    const { path, q } = strip(rawUrl);
    let m;

    if (method === 'POST' && path === '/$batch') {
      const responses = body.requests.map(r => {
        // Occasionally throttle a sub-request so the retry path gets exercised.
        if (rnd() < 0.04) return { id: r.id, status: 429, headers: { 'Retry-After': '1' }, body: { error: { code: 'TooManyRequests', message: 'Throttled' } } };
        const res = handle(r.method || 'GET', '/' + r.url, r.body, r.headers || {}, true);
        return { id: r.id, status: res.status, headers: res.headers, body: res.body };
      });
      return json(200, { responses });
    }

    if (method === 'GET' && path === '/deviceAppManagement/mobileApps') {
      const all = [...apps.values()].map(({ _assignments, ...a }) => a);
      const skip = Number(q.get('$skiptoken') || 0);
      const page = all.slice(skip, skip + 40);
      const out = { value: page };
      if (skip + 40 < all.length) out['@odata.nextLink'] = `https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?$skiptoken=${skip + 40}`;
      return json(200, out);
    }
    if ((m = path.match(/^\/deviceAppManagement\/mobileApps\/([^/]+)\/assignments$/)) && method === 'GET') {
      const app = apps.get(m[1]);
      return app ? json(200, { value: app._assignments.map(a => ({ ...a })) }) : err(404, 'ResourceNotFound', 'App not found');
    }
    if ((m = path.match(/^\/deviceAppManagement\/mobileApps\/([^/]+)\/assignments\/([^/]+)$/)) && method === 'DELETE') {
      const app = apps.get(m[1]);
      if (!app) return err(404, 'ResourceNotFound', 'App not found');
      const before = app._assignments.length;
      app._assignments = app._assignments.filter(a => a.id !== decodeURIComponent(m[2]));
      if (app._assignments.length === before) return err(404, 'ResourceNotFound', 'Assignment not found');
      app.isAssigned = app._assignments.length > 0;
      return json(204, null);
    }
    if ((m = path.match(/^\/deviceAppManagement\/mobileApps\/([^/]+)$/)) && method === 'GET') {
      const app = apps.get(m[1]);
      if (!app) return err(404, 'ResourceNotFound', 'App not found');
      const { _assignments, ...pub } = app;
      return json(200, pub);
    }
    if ((m = path.match(/^\/deviceAppManagement\/mobileApps\/([^/]+)$/)) && method === 'DELETE') {
      const app = apps.get(m[1]);
      if (!app) return err(404, 'ResourceNotFound', 'App not found');
      if (app.dependentAppCount || app.supersedingAppCount || app.supersededAppCount) {
        return err(400, 'BadRequest', 'This app has dependency or supersedence relationships. Remove them before deleting the app.');
      }
      apps.delete(m[1]);
      return json(204, null);
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/members$/)) && method === 'GET') {
      const g = groups.get(m[1]);
      if (!g) return err(404, 'Request_ResourceNotFound', 'Group not found');
      return json(200, { '@odata.count': g._members, value: [] });
    }
    if ((m = path.match(/^\/groups\/([^/]+)$/))) {
      const g = groups.get(m[1]);
      if (!g) return err(404, 'Request_ResourceNotFound', `Resource '${m[1]}' does not exist.`);
      if (method === 'GET') { const { _members, ...pub } = g; return json(200, pub); }
      if (method === 'DELETE') {
        if (g.onPremisesSyncEnabled) return err(400, 'Request_BadRequest', 'Unable to update the specified properties for on-premises mastered Directory Sync objects.');
        groups.delete(m[1]);
        return json(204, null);
      }
    }
    if ((m = path.match(/^\/deviceManagement\/(deviceConfigurations|configurationPolicies|deviceCompliancePolicies|groupPolicyConfigurations|deviceManagementScripts)$/))) {
      return json(200, { value: policies[m[1]] });
    }
    if (path === '/deviceManagement/deviceHealthScripts') {
      return err(403, 'Forbidden', 'Remediations require a Windows Enterprise E3/E5 license (demo).');
    }
    if (path === '/deviceAppManagement/mobileAppConfigurations') return json(200, { value: policies.mobileAppConfigurations });

    return err(400, 'BadRequest', `Demo tenant has no route for ${method} ${path}`);
  }

  return {
    handle,
    claims: { name: 'Demo Admin', upn: 'admin@contoso-demo.onmicrosoft.com', tid: 'demo' },
  };
}
