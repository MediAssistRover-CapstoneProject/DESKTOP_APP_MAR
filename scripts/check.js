'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const required of ['remote/control.py', 'src/main.js', 'src/preload.js', 'src/renderer/index.html']) {
  if (!fs.statSync(path.join(root, required)).isFile()) throw new Error(`Missing required app file: ${required}`);
}
function walk(folder) { return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]); }
const scripts = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'test')), __filename].filter(file => file.endsWith('.js'));
for (const script of scripts) {
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
console.log(`Syntax checked ${scripts.length} JavaScript files.`);
