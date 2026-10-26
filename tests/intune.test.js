// Unit tests for the matching, version and assignment logic. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeMatcher, parsePatterns, matchApps, compareVersions, makeVersionFilter,
  appVersion, targetOf, groupIdsOf, blocksDelete, appFlags,
} from '../js/intune.js';

const app = (displayName, extra = {}) => ({ id: displayName, displayName, ...extra });

test('match modes', () => {
  assert.ok(makeMatcher('zip', 'contains')('7-Zip 19.00'));
  assert.ok(makeMatcher('7-zip 19.00', 'exact')('7-Zip 19.00'));
  assert.ok(!makeMatcher('7-zip 19', 'exact')('7-Zip 19.00'));
  assert.ok(makeMatcher('Adobe', 'startsWith')('Adobe Acrobat'));
  assert.ok(makeMatcher('Notepad++ 7.*', 'wildcard')('Notepad++ 7.9.5'));
  assert.ok(!makeMatcher('Notepad++ 7.*', 'wildcard')('Notepad++ 8.4.2'));
  assert.ok(makeMatcher('\\(Retired\\)$', 'regex')('WinRAR 5.91 (Retired)'));
  assert.throws(() => makeMatcher('([bad', 'regex'));
});

test('parsePatterns ignores blanks and comments', () => {
  assert.deepEqual(parsePatterns('a\n\n # note\n#x\n b \r\nc'), ['a', 'b', 'c']);
});

test('matchApps reports unmatched patterns and applies excludes', () => {
  const apps = [app('7-Zip 19.00'), app('7-Zip 23.01'), app('VLC 3.0.11')];
  const r = matchApps(apps, ['7-Zip', 'Nothing here'], 'contains', '23.01');
  assert.deepEqual(r.matched.map(a => a.displayName), ['7-Zip 19.00']);
  assert.deepEqual(r.unmatched, ['Nothing here']);
  const w = matchApps(apps, ['*'], 'wildcard', '7-Zip*');
  assert.deepEqual(w.matched.map(a => a.displayName), ['VLC 3.0.11']);
});

test('compareVersions is numeric', () => {
  assert.equal(compareVersions('8.10', '8.9'), 1);
  assert.equal(compareVersions('22.01', '19.00'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('3.4.1', '3.10.0'), -1);
});

test('appVersion prefers app properties, then the name', () => {
  assert.deepEqual(appVersion(app('X', { displayVersion: '8.0.4' })), { value: '8.0.4', source: 'app' });
  assert.deepEqual(appVersion(app('X', { productVersion: '3.10.0' })), { value: '3.10.0', source: 'app' });
  assert.deepEqual(appVersion(app('7-Zip 19.00')), { value: '19.00', source: 'name' });
  assert.deepEqual(appVersion(app('Java Runtime 8u202')), { value: '8u202', source: 'name' });
  assert.deepEqual(appVersion(app('AnyDesk_User_AM1')), { value: '', source: null });
  assert.deepEqual(appVersion(app('Microsoft 365 Apps')), { value: '', source: null });
});

test('version filter operators', () => {
  const v = s => app('A', { displayVersion: s });
  assert.ok(makeVersionFilter('lt', '8.0')(v('7.9.1')));
  assert.ok(!makeVersionFilter('lt', '8.0')(v('8.0.4')));
  assert.ok(makeVersionFilter('le', '7.9.1')(v('7.9.1')));
  assert.ok(makeVersionFilter('gt', '3.4')(v('3.10.0')));
  assert.ok(makeVersionFilter('ge', '3.10')(v('3.10.0')));
  assert.ok(makeVersionFilter('eq', '7.*')(v('7.6.2')));
  assert.ok(makeVersionFilter('eq', '8.1')(v('8.1.0')));
  assert.ok(makeVersionFilter('contains', '.9.')(v('7.9.1')));
  assert.ok(makeVersionFilter('none', '')(app('AnyDesk_User_AM1')));
  assert.ok(!makeVersionFilter('lt', '8.0')(app('AnyDesk_User_AM1')), 'unknown version never matches a comparison');
  assert.ok(makeVersionFilter('any', '')(app('Anything')));
});

test('assignment targets and group ids', () => {
  const a = {
    assignments: [
      { intent: 'required', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'g1' } },
      { intent: 'required', target: { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: 'g2' } },
      { intent: 'available', target: { '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget' } },
      { intent: 'required', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget', deviceAndAppManagementAssignmentFilterId: 'f1', deviceAndAppManagementAssignmentFilterType: 'include' } },
    ],
  };
  assert.deepEqual(a.assignments.map(x => targetOf(x).kind), ['include', 'exclude', 'allUsers', 'allDevices']);
  assert.equal(targetOf(a.assignments[3]).filterId, 'f1');
  assert.deepEqual(groupIdsOf([a, a]).sort(), ['g1', 'g2']);
});

test('apps with relationships are flagged as not deletable', () => {
  assert.ok(blocksDelete(app('A', { supersededAppCount: 1 })));
  assert.ok(blocksDelete(app('A', { dependentAppCount: 2 })));
  assert.ok(!blocksDelete(app('A')));
  assert.ok(appFlags(app('A', { '@odata.type': '#microsoft.graph.iosVppApp' })).some(f => f.key === 'synced'));
});
