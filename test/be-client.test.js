'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BeClient, BeClientError, validateBaseUrl } = require('../src/core/be-client');
const ROBOT = '0e3f1083-2546-4f45-8004-5eda5cb75a6f';
const MAP = '4ec85084-3a71-4aa3-a0f3-72f252708fcc';
const SESSION = '725e9c68-9f09-4cff-b8dc-0e77d37a4e06';
const WORKFLOW = 'c1d6e91c-1afc-4c95-bb9a-2261a73b5209';
const FLOOR = 'e2156d86-4aff-44ad-9ebf-1c5a810daacf';

function response(data, status = 200) {
  return new Response(data === null ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function fixture(handler, { role = 'ADMIN', expiresAt = new Date(Date.now() + 3600000).toISOString() } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = { url: new URL(url), ...options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(request);
    if (request.url.pathname === '/api/v1/auth/login') return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', accessTokenExpiresAt: expiresAt, mustChangePassword: false });
    if (request.url.pathname === '/api/v1/auth/me') return response({ accountId: ROBOT, username: 'admin', fullName: 'Admin', role, status: 'ACTIVE', mustChangePassword: false });
    return handler(request);
  };
  return { client: new BeClient({ baseUrl: 'https://example.test', fetchImpl }), calls };
}

test('origin requires HTTPS and rejects credential/path injection', () => {
  for (const value of ['http://robot.test', 'https://admin:secret@example.test', 'https://example.test/api', 'https://example.test?token=x', 'https://example.test/#x']) {
    assert.throws(() => validateBaseUrl(value), BeClientError);
  }
  assert.equal(validateBaseUrl('https://example.test/'), 'https://example.test');
  assert.equal(validateBaseUrl('http://127.0.0.1:9999', true), 'http://127.0.0.1:9999');
});

test('login verifies ADMIN through /me and never exposes token in summary', async () => {
  const { client, calls } = fixture(() => response({}));
  const summary = await client.login('admin', 'password');
  assert.equal(summary.authenticated, true);
  assert.equal(summary.account.role, 'ADMIN');
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(calls[0].body.deviceInfo, 'MAR Desktop');
  assert.equal(calls[1].headers.Authorization, 'Bearer access-secret');
  client.logout();
  assert.equal(client.summary().authenticated, false);
  const staff = fixture(() => response({}), { role: 'STAFF' });
  await assert.rejects(staff.client.login('staff', 'password'), { code: 'ADMIN_REQUIRED' });
  assert.equal(staff.client.summary().authenticated, false);
});

test('catalog pagination and ACTIVE filtering preserve raw business JSON fields', async () => {
  const { client } = fixture(req => {
    const page = Number(req.url.searchParams.get('page'));
    const content = page === 0 ? Array.from({ length: 100 }, (_, i) => ({ mapId: `${i}`, status: i === 0 ? 'ARCHIVED' : 'ACTIVE' })) : [{ mapId: MAP, status: 'ACTIVE', data: { value: 1 } }];
    return response({ content, last: page === 1, totalPages: 2 });
  });
  await client.login('admin', 'password');
  const maps = await client.listMaps();
  assert.equal(maps.length, 100);
  assert.deepEqual(maps.at(-1).data, { value: 1 });
});

test('mapping catalog excludes legacy transports rejected by mapping job API', async () => {
  const { client, calls } = fixture(() => response({ content: [
    { workflowId: WORKFLOW, schemaVersion: 3, serviceType: 'MAPPING' },
    { workflowId: SESSION, schemaVersion: 2, serviceType: 'MAPPING' }
  ], last: true }));
  await client.login('admin', 'password');
  assert.deepEqual((await client.listMappingWorkflows()).map(value => value.workflowId), [WORKFLOW]);
  assert.equal(calls.at(-1).url.searchParams.get('serviceType'), 'MAPPING');
});

test('same-map open navigation is reused and different-map open session is never closed', async () => {
  const { client, calls } = fixture(() => response({ state: 'READY', sessionId: SESSION, mapId: MAP, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  await client.login('admin', 'password');
  assert.equal((await client.openNavigationSession(ROBOT, MAP, 7200)).reused, true);
  await assert.rejects(client.openNavigationSession(ROBOT, FLOOR, 7200), { code: 'NAVIGATION_SESSION_ALREADY_OPEN' });
  assert.equal(calls.filter(req => req.method === 'POST').length, 1, 'Only login can POST in this case');
});

test('closed navigation creates exact source contract and mapping job uses UUIDs', async () => {
  const { client, calls } = fixture(req => response(req.method === 'GET' ? { state: 'CLOSED' } : { sessionId: SESSION }));
  await client.login('admin', 'password');
  await client.openNavigationSession(ROBOT, MAP, 7200);
  const created = calls.at(-1);
  assert.equal(created.url.pathname, `/api/v1/robots/${ROBOT}/navigation-session`);
  assert.deepEqual(created.body, { mapId: MAP, durationSec: 7200 });
  await client.createMappingJob({ workflowId: WORKFLOW, robotId: ROBOT, floorId: FLOOR, mapName: 'Map demo' });
  assert.deepEqual(calls.at(-1).body, { workflowId: WORKFLOW, robotId: ROBOT, floorId: FLOOR, mapName: 'Map demo' });
  await assert.rejects(client.openNavigationSession(ROBOT, MAP, 28801), { code: 'INVALID_INPUT' });
});

test('ambiguous mutation failure is marked uncertain and not replayed', async () => {
  const { client, calls } = fixture(() => { throw new TypeError('connection reset password secret'); });
  await client.login('admin', 'password');
  await assert.rejects(client.createMappingJob({ workflowId: WORKFLOW, robotId: ROBOT, floorId: FLOOR, mapName: 'Demo' }), error => error.code === 'BE_UNREACHABLE' && error.uncertain && !error.message.includes('password'));
  assert.equal(calls.filter(req => req.url.pathname === '/api/v1/mapping-jobs').length, 1);
});

test('401 clears login and never refreshes or replays a mutation', async () => {
  const { client, calls } = fixture(() => response({ error: 'UNAUTHORIZED', message: 'Expired' }, 401));
  await client.login('admin', 'password');
  await assert.rejects(client.closeNavigationSession(ROBOT, SESSION), { code: 'AUTH_EXPIRED', status: 401 });
  assert.equal(client.summary().authenticated, false);
  assert.equal(calls.filter(req => req.url.pathname.endsWith('/close')).length, 1);
  assert.equal(calls.some(req => req.url.pathname.endsWith('/refresh')), false);
});

test('structured backend error retains correlation and rejects oversized bodies', async () => {
  const { client } = fixture(() => response({ error: 'BUSINESS_RULE_VIOLATION', message: 'Robot busy', correlationId: 'request-01' }, 422));
  await client.login('admin', 'password');
  await assert.rejects(client.getJob(SESSION), error => error.code === 'BUSINESS_RULE_VIOLATION' && error.correlationId === 'request-01');
  const big = fixture(() => new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }));
  await big.client.login('admin', 'password');
  await assert.rejects(big.client.getJob(SESSION), { code: 'BE_RESPONSE_TOO_LARGE' });
});
