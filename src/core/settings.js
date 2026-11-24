'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = Object.freeze({ host: 'raspberrypi.local', username: 'pi', port: 22,
  projectPath: '/home/ubuntu/mediassist-mqtt-2026-10-08', container: 'MentorPi',
  baseUrl: 'https://mediassistrover.duckdns.org', robotId: '0e3f1083-2546-4f45-8004-5eda5cb75a6f',
  privateKeyPath: '', knownHosts: {} });
const KEYS = new Set(Object.keys(DEFAULTS));
class Settings {
  constructor(folder) { this.file = path.join(folder, 'settings.json'); this.value = structuredClone(DEFAULTS); }
  async load() {
    try { const raw = JSON.parse(await fs.readFile(this.file, 'utf8')); this.update(raw); }
    catch (error) { if (error.code !== 'ENOENT') this.value = structuredClone(DEFAULTS); }
    return this.snapshot();
  }
  update(input) {
    for (const [key, value] of Object.entries(input || {})) {
      if (!KEYS.has(key)) continue;
      if (key === 'knownHosts') {
        if (value && typeof value === 'object' && !Array.isArray(value)) this.value.knownHosts = Object.fromEntries(
          Object.entries(value).filter(([host, pin]) => /^[a-zA-Z0-9.:[\]-]{1,260}$/.test(host) && /^SHA256:[a-zA-Z0-9+/]{43}$/.test(pin)));
      } else if (key === 'port') {
        if (Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535) this.value[key] = Number(value);
      } else if (typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f]/.test(value)) this.value[key] = value;
    }
  }
  snapshot() { const { knownHosts, ...rest } = this.value; return { ...rest }; }
  async save(input = {}) {
    this.update(input);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.new';
    await fs.writeFile(temporary, JSON.stringify(this.value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, this.file);
    return this.snapshot();
  }
}
module.exports = { Settings, DEFAULTS };
