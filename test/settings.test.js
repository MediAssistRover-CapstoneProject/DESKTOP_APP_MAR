'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Settings } = require('../src/core/settings');
const { quote, validHost } = require('../src/core/ssh');
test('settings persist connection information but reject passwords and tokens', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-desktop-settings-'));
  try {
    const settings = new Settings(folder);
    await settings.save({ host: '192.168.1.154', password: 'must-not-persist', accessToken: 'must-not-persist', baseUrl: 'https://example.org' });
    const raw = await fs.readFile(settings.file, 'utf8'); assert.ok(!raw.includes('must-not-persist'));
    assert.equal((await new Settings(folder).load()).host, '192.168.1.154');
  } finally {
    const parent = await fs.realpath(os.tmpdir()), target = await fs.realpath(folder);
    assert.equal(path.dirname(target).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(target).startsWith('mar-desktop-settings-'));
    await fs.rm(target, { recursive: true, force: true });
  }
});
test('SSH arguments reject command injection and shell quoting preserves literal paths', () => {
  for (const host of ['-oProxyCommand=x', 'host;reboot', 'x\nlocalhost', 'example.com']) assert.throws(() => validHost(host));
  assert.equal(validHost('raspberrypi.local'), 'raspberrypi.local');
  assert.equal(quote("a'b"), "'a'\\''b'");
});
