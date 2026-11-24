'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');

function privateIPv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b, , d] = value.split('.').map(Number);
  return d !== 0 && d !== 255 && (a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254);
}

function allowedHost(value) {
  return typeof value === 'string' && value.length <= 253 && (privateIPv4(value)
    || /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+local$/i.test(value));
}

function probe(address, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: address, port });
    let settled = false;
    function finish(reachable) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function createDiscovery(dependencies = {}) {
  const lookup = dependencies.lookup || dns.lookup;
  const tcpProbe = dependencies.probe || probe;
  const platform = dependencies.platform ?? process.platform;
  const execFile = dependencies.execFile || promisify(execFileCallback);

  async function discoverRobots(input = {}) {
    const timeoutMs = input.timeoutMs ?? 1000;
    const port = input.port ?? 22;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Thời gian chờ/cổng tìm robot không hợp lệ.');
    if (input.hosts !== undefined && (!Array.isArray(input.hosts) || input.hosts.length > 32 || input.hosts.some(host => !allowedHost(host)))) throw new Error('Chỉ tìm IP LAN hoặc tên .local hợp lệ.');
    const hosts = new Set(input.hosts || []);
    ['mar-v1.local', 'raspberrypi.local', '192.168.149.1'].forEach(host => hosts.add(host));
    // Inspect only existing neighbor cache. Never sweep an entire subnet.
    if (platform === 'win32') {
      try {
        const { stdout } = await execFile('arp.exe', ['-a'], { windowsHide: true, timeout: 2500, maxBuffer: 65536, encoding: 'utf8' });
        for (const match of stdout.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
          if (privateIPv4(match[0])) hosts.add(match[0]);
          if (hosts.size >= 64) break;
        }
      } catch { /* Cached names and the explicit host remain available. */ }
    }
    const pending = [...hosts].slice(0, 64);
    const found = [];
    async function worker() {
      while (pending.length) {
        const host = pending.shift();
        let addresses;
        if (privateIPv4(host)) addresses = [host];
        else {
          let timer;
          try {
            const result = await Promise.race([
              lookup(host, { all: true, family: 4 }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), Math.min(3000, timeoutMs * 2)); })
            ]);
            addresses = [...new Set(result.map(row => row.address).filter(privateIPv4))].slice(0, 4);
          } catch { addresses = []; }
          finally { clearTimeout(timer); }
        }
        // At most one socket per worker, including a name with several IPv4s.
        // The eight-worker bound therefore applies to sockets, not just names.
        let reachable = false;
        for (const address of addresses) {
          if (await tcpProbe(address, port, timeoutMs)) { reachable = true; break; }
        }
        found.push({ host, addresses, reachable, port });
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker));
    found.sort((a, b) => Number(b.reachable) - Number(a.reachable) || a.host.localeCompare(b.host));
    return { candidates: found, message: 'Cổng SSH mở chỉ là ứng viên; kết nối SSH và kiểm tra host key để xác nhận đúng robot.' };
  }
  return { discoverRobots };
}

module.exports = { ...createDiscovery(), createDiscovery, allowedHost, privateIPv4 };
