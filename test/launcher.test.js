'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Launcher } = require('../src/core/launcher');
const id = '0e3f1083-2546-4f45-8004-5eda5cb75a6f';
function fixture() {
  const calls = [];
  const ssh = { call: async (action, body) => { calls.push(['ssh', action, body]); return action === 'status' ? { stack: { running: false }, project: { robotId: id } } : { accepted: true, state: action === 'stop' ? 'STOPPED' : 'STARTING' }; } };
  const cloud = { getNavigationSession: async () => ({ state: 'NONE' }),
    closeNavigationSession: async (...args) => { calls.push(['close', ...args]); },
    openNavigationSession: async (...args) => { calls.push(['open', ...args]); return { sessionId: id, state: 'WAITING_FOR_PI' }; },
    getRobotSnapshot: async () => ({ observedAt: '2026-11-23T10:00:00Z', mqttConnected: true, heartbeatFresh: true, dispatchReady: true, robot: { status: 'IDLE', lastHeartbeatAt: '2026-11-23T10:00:01Z' } }),
    createMappingJob: async body => { calls.push(['job', body]); return { jobId: id }; } };
  const launcher = new Launcher({ ssh, cloud, settings: () => ({ projectPath: '/home/ubuntu/mar', container: 'MentorPi' }), sleepImpl: async () => {} });
  return { launcher, calls, ssh, cloud };
}
test('mapping starts the runtime and waits for ready MQTT before creating one job', async () => {
  const f = fixture(); let checked = false;
  const baseSnapshot = f.cloud.getRobotSnapshot;
  f.cloud.getRobotSnapshot = async () => { if (f.calls.at(-1)[1] === 'start') checked = true; return baseSnapshot(); };
  const result = await f.launcher.mapping({ robotId: id, workflowId: id, floorId: id, mapName: 'Tầng 1' });
  assert.ok(checked); assert.equal(result.job.jobId, id);
  assert.deepEqual(f.calls.map(row => row[0] === 'ssh' ? row[1] : row[0]), ['status', 'start', 'job']);
});

test('mapping does not reuse an IDLE heartbeat from the previous runtime', async () => {
  const f = fixture(); let reads = 0;
  f.cloud.getRobotSnapshot = async () => ({ observedAt: '2026-11-23T10:00:00Z', mqttConnected: true, heartbeatFresh: true, dispatchReady: true,
    robot: { status: 'IDLE', lastHeartbeatAt: ++reads < 3 ? '2026-11-23T09:59:59Z' : '2026-11-23T10:00:01Z' } });
  await f.launcher.mapping({ robotId: id, workflowId: id, floorId: id, mapName: 'Map' });
  assert.equal(reads, 3); assert.equal(f.calls.filter(row => row[0] === 'job').length, 1);
});
test('a running supervisor blocks mode switching before any BE mutation', async () => {
  const f = fixture(); f.ssh.call = async () => ({ stack: { running: true } });
  await assert.rejects(f.launcher.navigation({ robotId: id, mapId: id }), { code: 'STACK_ALREADY_RUNNING' });
  assert.equal(f.calls.length, 0);
});
test('an old open navigation session requires explicit reopen intent', async () => {
  const f = fixture(); f.cloud.getNavigationSession = async () => ({ sessionId: id, state: 'WAITING_FOR_PI' });
  await assert.rejects(f.launcher.navigation({ robotId: id, mapId: id }), { code: 'OLD_SESSION_OPEN' });
  assert.equal(f.calls.length, 1);
  await f.launcher.navigation({ robotId: id, mapId: id, reopenExisting: true });
  assert.equal(f.calls.filter(row => row[0] === 'close').length, 1);
});

test('a different robot in SSH worker configuration blocks cloud session creation', async () => {
  const f = fixture();
  f.ssh.call = async () => ({ stack: { running: false }, project: { robotId: '11111111-1111-1111-1111-111111111111' } });
  await assert.rejects(f.launcher.navigation({ robotId: id, mapId: id }), { code: 'ROBOT_ID_MISMATCH' });
  assert.equal(f.calls.length, 0);
});
test('navigation opens one session and passes its identity without sending a MOVE', async () => {
  const f = fixture(); await f.launcher.navigation({ robotId: id, mapId: id, loadProfile: 'bare', voiceChat: true });
  const command = f.calls.find(row => row[1] === 'start');
  assert.equal(command[2].mode, 'navigation'); assert.equal(command[2].sessionId, id);
  assert.equal(command[2].loadProfile, 'bare'); assert.equal(command[2].voiceChat, true);
  assert.equal(f.calls.filter(row => row[0] === 'job').length, 0);
});
test('ambiguous Start preserves session instead of closing an operation that may be running', async () => {
  const f = fixture(); const base = f.ssh.call;
  f.ssh.call = async (action, body) => { if (action === 'start') throw new Error('timeout'); return base(action, body); };
  await assert.rejects(f.launcher.navigation({ robotId: id, mapId: id }), /Phiên.*đã tạo/);
  assert.equal(f.calls.filter(row => row[0] === 'close').length, 0);
});
test('a mapping create timeout is never automatically replayed', async () => {
  const f = fixture(); let attempts = 0;
  f.cloud.createMappingJob = async () => { attempts++; throw new Error('ambiguous'); };
  await assert.rejects(f.launcher.mapping({ robotId: id, workflowId: id, floorId: id, mapName: 'Map' }));
  assert.equal(attempts, 1);
});
test('stop asks the supervisor and never silently cancels or reconciles a BE job', async () => {
  const f = fixture(); await f.launcher.stop();
  assert.deepEqual(f.calls.map(row => row[1]), ['stop']);
});

test('Stop interrupts the mapping MQTT wait before any job is created', async () => {
  const f = fixture(); let reads = 0;
  const base = f.cloud.getRobotSnapshot;
  f.cloud.getRobotSnapshot = async () => { if (++reads === 2) await f.launcher.stop(); return base(); };
  await assert.rejects(f.launcher.mapping({ robotId: id, workflowId: id, floorId: id, mapName: 'Map' }), { code: 'START_CANCELLED' });
  assert.equal(f.calls.filter(row => row[0] === 'job').length, 0);
});
