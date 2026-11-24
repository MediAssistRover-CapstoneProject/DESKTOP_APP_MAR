'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createWindowsWifi, profileXml } = require('../src/core/windows-wifi');
const { createDiscovery, privateIPv4, allowedHost } = require('../src/core/discovery');

test('Wi-Fi provisioning escapes profile data, uses argv, and removes its password file', async () => {
  const calls = [];
  let importedFile;
  const wifi = createWindowsWifi({ platform: 'win32', execFile: async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes('profile')) {
      importedFile = args.find(value => value.startsWith('filename=')).slice(9);
      const xml = await fs.readFile(importedFile, 'utf8');
      assert.match(xml, /a&amp;b&lt;c&gt;d/);
      assert.match(xml, /connectionMode>manual/);
    }
    return { stdout: '' };
  } });
  const result = await wifi.connectWifi({ ssid: 'HW-<&"', password: 'a&b<c>d123', interfaceName: 'Wi-Fi' });
  assert.equal(result.started, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].file, 'netsh.exe');
  assert.ok(calls[1].args.includes('ssid=HW-<&"'));
  assert.ok(calls.every(call => call.options.windowsHide));
  await assert.rejects(fs.access(importedFile));
  assert.throws(() => profileXml('a'.repeat(33), 'password', 'profile'));
  assert.throws(() => profileXml('SSID\ncommand', 'password', 'profile'));
  assert.throws(() => profileXml('SSID', 'short', 'profile'));
});

test('Wi-Fi status is structured and never queries stored profile passwords', async () => {
  let script;
  const wifi = createWindowsWifi({ platform: 'win32', execFile: async (file, args) => {
    assert.equal(file, 'powershell.exe');script = args.at(-1);
    return { stdout: JSON.stringify({ supported: true, interfaces: [{ name: 'Wi-Fi', ssid: 'Nhà' }], profiles: [{ name: 'Nhà' }] }) };
  } });
  const status = await wifi.getWifiStatus();
  assert.equal(status.interfaces[0].ssid, 'Nhà');
  assert.match(script, /WlanGetProfileList/);
  assert.doesNotMatch(script, /WlanGetProfile\(/);
  assert.doesNotMatch(script, /key=clear/);
  assert.deepEqual(status.networks, []);
  const other = createWindowsWifi({ platform: 'linux' });
  assert.equal((await other.getWifiStatus()).supported, false);
  await assert.rejects(other.connectWifi({ ssid: 'test' }), /Windows/);
});

test('remembered profile reconnect requires no password and failures do not echo secrets', async () => {
  let call;
  const wifi = createWindowsWifi({ platform: 'win32', execFile: async (file, args) => {
    call = { file, args };return { stdout: '' };
  } });
  await wifi.connectWifi({ ssid: 'My WiFi', profileName: 'Office Saved', interfaceName: 'Wi-Fi' });
  assert.deepEqual(call.args, ['wlan', 'connect', 'name=Office Saved', 'ssid=My WiFi', 'interface=Wi-Fi']);
  const broken = createWindowsWifi({ platform: 'win32', execFile: async () => { throw new Error('SENSITIVE_PASSWORD'); } });
  await assert.rejects(broken.connectWifi({ ssid: 'HW', password: 'password1' }), error => !error.message.includes('SENSITIVE_PASSWORD'));
});

test('Wi-Fi reconnect finds its generated saved profile without requesting a password', async () => {
  const ssid = 'HW-Reconnect';
  const profileName = `MAR-${crypto.createHash('sha256').update(ssid).digest('hex').slice(0, 16)}`;
  const calls = [];
  const wifi = createWindowsWifi({ platform: 'win32', execFile: async (file, args) => {
    calls.push({ file, args });
    return { stdout: file === 'powershell.exe' ? JSON.stringify({ interfaces: [], profiles: [{ name: profileName, interfaceName: 'Wi-Fi' }] }) : '' };
  } });
  const result = await wifi.connectWifi({ ssid, interfaceName: 'Wi-Fi' });
  assert.equal(result.profileName, profileName);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['wlan', 'connect', `name=${profileName}`, `ssid=${ssid}`, 'interface=Wi-Fi']);
});

test('Wi-Fi temp cleanup refuses a resolved target outside the intended temp parent', async () => {
  const parent = path.resolve(os.tmpdir());
  const outside = path.join(path.dirname(parent), 'mar-wifi-outside');
  let writes = 0, removals = 0;
  const wifi = createWindowsWifi({ platform: 'win32', tmpdir: () => parent, execFile: async () => ({ stdout: '' }), fs: {
    realpath: async value => value,
    mkdtemp: async () => outside,
    writeFile: async () => { writes++; },
    rm: async () => { removals++; }
  } });
  await assert.rejects(wifi.connectWifi({ ssid: 'HW', password: 'password1' }), /Từ chối dọn thư mục/);
  assert.equal(writes, 0);
  assert.equal(removals, 0);
});

test('discovery stays on private LAN, treats SSH as unverified, and uses bounded cached candidates', async () => {
  assert.equal(privateIPv4('192.168.1.154'), true);
  assert.equal(privateIPv4('172.31.2.5'), true);
  for (const value of ['8.8.8.8', '127.0.0.1', '192.168.1.255', '172.32.1.1', '999.1.1.1']) assert.equal(privateIPv4(value), false);
  assert.equal(allowedHost('mar-v1.local'), true);
  assert.equal(allowedHost('example.com'), false);
  const probes = [];
  const discovery = createDiscovery({ platform: 'win32', execFile: async () => ({ stdout: '192.168.1.10 10.0.0.6 8.8.8.8' }),
    lookup: async host => [{ address: host === 'mar-v1.local' ? '192.168.1.154' : '8.8.8.8' }],
    probe: async (address, port, timeout) => { probes.push({ address, port, timeout });return address === '192.168.1.154'; }
  });
  const result = await discovery.discoverRobots({ hosts: ['192.168.1.20'], timeoutMs: 200 });
  assert.equal(result.candidates[0].host, 'mar-v1.local');
  assert.equal(result.candidates[0].reachable, true);
  assert.ok(probes.every(value => privateIPv4(value.address) && value.port === 22 && value.timeout === 200));
  await assert.rejects(discovery.discoverRobots({ hosts: ['example.com'] }));
  await assert.rejects(discovery.discoverRobots({ port: 0 }));
  await assert.rejects(discovery.discoverRobots({ timeoutMs: 10000 }));
});

test('discovery never opens more than eight probes even for multi-address names', async () => {
  let active = 0, peak = 0;
  const discovery = createDiscovery({ platform: 'linux',
    lookup: async () => [{ address: '10.0.0.1' }, { address: '10.0.0.2' }],
    probe: async () => { active++;peak = Math.max(peak, active);await new Promise(resolve => setTimeout(resolve, 2));active--;return false; }
  });
  await discovery.discoverRobots({ hosts: Array.from({ length: 20 }, (_, i) => `robot-${i}.local`) });
  assert.ok(peak <= 8);
  assert.ok(peak > 1);
});
