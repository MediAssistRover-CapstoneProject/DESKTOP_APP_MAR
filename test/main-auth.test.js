'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const beClient = require('../src/core/be-client');

const BASE_URL = 'https://admin.example.test';
const VERSION = '0.2.0';
const SESSION_LIFETIME_MS = 3_600_000;
const ROBOT_ID = '0e3f1083-2546-4f45-8004-5eda5cb75a6f';
const mainPath = path.join(__dirname, '../src/main.js');
const mainSource = readFileSync(mainPath, 'utf8');

async function fixture(t, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  const handlers = new Map();
  const appEvents = new Map();
  const events = [];
  const requests = [];
  const operations = [];
  const { promise: ready, resolve: show, reject: fail } = Promise.withResolvers();
  const webContents = {
    mainFrame: {},
    session: { setPermissionRequestHandler() {} },
    on() {},
    isDestroyed: () => false,
    setWindowOpenHandler() {},
    send: (channel, data) => events.push({ channel, data: structuredClone(data) })
  };
  const app = {
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    on: (event, listener) => appEvents.set(event, listener),
    getPath: () => __dirname,
    getAppPath: () => path.dirname(mainPath),
    getVersion: () => VERSION,
    quit() {}
  };
  const settings = { baseUrl: BASE_URL, host: 'raspberrypi.local', robotId: ROBOT_ID };
  const run = (name, result) => {
    operations.push(name);
    return result;
  };
  let role;
  async function fetchImpl(url, options) {
    const request = new URL(url);
    requests.push(request);
    if (request.pathname === '/api/v1/auth/login') {
      const { username, password } = JSON.parse(options.body);
      if (password !== 'test-password') return Response.json({ message: 'Invalid credentials' }, { status: 401 });
      role = username === 'admin' ? 'ADMIN' : 'STAFF';
      return Response.json({ accessToken: 'test-token', accessTokenExpiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString() });
    }
    if (request.pathname === '/api/v1/auth/me') return Response.json({ role, status: 'ACTIVE' });
    if (request.pathname === `/api/v1/robots/${ROBOT_ID}/snapshot`) return Response.json({}, { status: 401 });
    throw new Error(`Unexpected BE endpoint ${request.pathname}`);
  }

  const modules = {
    electron: {
      app,
      BrowserWindow: class {
        webContents = webContents;
        isDestroyed() { return false; }
        loadFile() {}
        show() { show(); }
      },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      dialog: { showErrorBox: (_title, message) => fail(new Error(message)) },
      shell: { openExternal: url => run('openPage', url) },
      Menu: { setApplicationMenu() {} }
    },
    'node:path': path,
    './core/settings': { Settings: class {
      value = settings;
      load() {}
      snapshot() { return { ...settings }; }
      save(input) { return run('saveSettings', Object.assign(settings, input)); }
    } },
    './core/ssh': { RobotSsh: class {
      summary() { return { connected: false }; }
      disconnect() {}
    } },
    './core/be-client': { ...beClient, BeClient: class extends beClient.BeClient {
      constructor(options) { super({ ...options, fetchImpl }); }
    } },
    './core/launcher': { Launcher: class {
      stop() { return run('stopRobot', { state: 'STOPPED' }); }
    } },
    './core/windows-wifi': { getWifiStatus: () => run('wifiStatus', {}) },
    './core/discovery': { discoverRobots: () => run('discover', { candidates: [] }) }
  };
  vm.runInNewContext(mainSource, {
    require: name => modules[name], __dirname: path.dirname(mainPath),
    setTimeout: schedule, clearTimeout: cancel, Date, URL
  }, { filename: mainPath });
  t.after(() => appEvents.get('before-quit')?.());
  await ready;

  async function invoke(name, input) {
    const handler = handlers.get(`mar:${name}`);
    return structuredClone(await handler({ sender: webContents, senderFrame: webContents.mainFrame }, input));
  }
  return { invoke, events, requests, operations };
}

test('main process requires a verified ADMIN before releasing settings or operational IPC', async t => {
  const { invoke, events, requests, operations } = await fixture(t);
  const locked = { settings: { baseUrl: BASE_URL }, cloud: { authenticated: false }, version: VERSION };
  assert.deepEqual((await invoke('settings')).data, locked);
  for (const name of ['saveSettings', 'changeServer', 'discover', 'wifiStatus', 'connectRobot', 'robotLogs', 'stopRobot', 'openPage', 'logout']) {
    assert.equal((await invoke(name)).error?.code, 'ADMIN_LOGIN_REQUIRED', name);
  }
  assert.deepEqual(operations, []);

  const invalid = await invoke('login', { username: 'admin', password: 'wrong-password' });
  assert.equal(invalid.error?.status, 401);
  const staff = await invoke('login', { username: 'staff', password: 'test-password' });
  assert.equal(staff.error?.code, 'ADMIN_REQUIRED');
  assert.deepEqual((await invoke('settings')).data, locked);

  const login = await invoke('login', { username: 'admin', password: 'test-password', baseUrl: 'https://untrusted.example.test' });
  assert.equal(login.data?.authenticated, true);
  assert.equal(login.data?.account.role, 'ADMIN');
  assert.ok(requests.every(request => request.origin === BASE_URL));
  assert.equal((await invoke('settings')).data.settings.host, 'raspberrypi.local');
  assert.equal((await invoke('discover')).ok, true);
  assert.equal((await invoke('openPage', { page: 'mapping' })).ok, true);
  assert.deepEqual(operations, ['discover', 'openPage']);

  assert.deepEqual((await invoke('logout')).data, { authenticated: false });
  assert.ok(events.some(({ channel, data }) => channel === 'mar:authChanged' && data.authenticated === false));
  assert.deepEqual((await invoke('settings')).data, locked);
  assert.equal((await invoke('discover')).error?.code, 'ADMIN_LOGIN_REQUIRED');
});

test('a backend 401 invalidates the ADMIN session and re-locks local operations', async t => {
  const { invoke, events, operations } = await fixture(t);
  assert.equal((await invoke('login', { username: 'admin', password: 'test-password' })).data?.authenticated, true);
  assert.equal((await invoke('cloudStatus')).error?.code, 'AUTH_EXPIRED');
  assert.ok(events.some(({ channel, data }) => channel === 'mar:authChanged' && data.authenticated === false && data.reason === 'AUTH_EXPIRED'));
  assert.equal((await invoke('wifiStatus')).error?.code, 'ADMIN_LOGIN_REQUIRED');
  assert.deepEqual(operations, []);
});

test('the session expires and notifies the renderer while the app is idle', async t => {
  let now = Date.now();
  let expire;
  t.mock.method(Date, 'now', () => now);
  const { invoke, events } = await fixture(t, {
    schedule(callback, delay) {
      assert.equal(delay, SESSION_LIFETIME_MS);
      expire = callback;
      return { unref() {} };
    },
    cancel() {}
  });
  assert.equal((await invoke('login', { username: 'admin', password: 'test-password' })).data?.authenticated, true);
  now += SESSION_LIFETIME_MS;
  expire();

  assert.deepEqual(events.at(-1), { channel: 'mar:authChanged', data: { authenticated: false, reason: 'AUTH_EXPIRED' } });
  assert.equal((await invoke('wifiStatus')).error?.code, 'ADMIN_LOGIN_REQUIRED');
});

test('changing the server requires ADMIN and a fresh login against the new origin', async t => {
  const { invoke, events, requests } = await fixture(t);
  const credentials = { username: 'admin', password: 'test-password' };
  assert.equal((await invoke('login', credentials)).data?.authenticated, true);
  assert.equal((await invoke('changeServer', { baseUrl: 'http://new.example.test' })).error?.code, 'INVALID_BE_URL');

  const baseUrl = 'https://new.example.test';
  assert.deepEqual((await invoke('changeServer', { baseUrl })).data, { authenticated: false });
  assert.deepEqual(events.at(-1), { channel: 'mar:authChanged', data: { authenticated: false } });
  assert.deepEqual((await invoke('settings')).data.settings, { baseUrl });
  assert.equal((await invoke('discover')).error?.code, 'ADMIN_LOGIN_REQUIRED');
  assert.equal((await invoke('login', credentials)).data?.authenticated, true);
  assert.equal(requests.at(-1).origin, baseUrl);
});
