'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const net = require('node:net');
const { Client } = require('ssh2');

const ACTIONS = new Set(['status', 'wifi-scan', 'wifi-configure', 'start', 'stop', 'logs']);
function fault(code, message) { const error = new Error(message); error.code = code; return error; }
function validHost(value) {
  const host = String(value || '').trim();
  if (!host || host.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(host) || host.startsWith('-'))
    throw fault('INVALID_HOST', 'Nhập IP hoặc tên .local hợp lệ của robot.');
  if (!net.isIP(host) && !host.endsWith('.local') && host !== 'localhost')
    throw fault('LOCAL_HOST_REQUIRED', 'Chỉ kết nối IP hoặc tên .local trên mạng robot.');
  return host;
}
function quote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

class RobotSsh {
  constructor({ helperPath, verifyHost, onDisconnected = () => {} }) {
    this.helperPath = helperPath;
    this.verifyHost = verifyHost;
    this.onDisconnected = onDisconnected;
    this.client = null;
    this.pendingClient = null;
    this.identity = null;
    this.generation = 0;
  }
  summary() { return { connected: Boolean(this.client), ...(this.identity || {}) }; }
  async connect(input) {
    const host = validHost(input.host);
    const port = Number(input.port || 22);
    const username = String(input.username || 'pi');
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(username))
      throw fault('INVALID_SSH_SETTINGS', 'User hoặc cổng SSH không hợp lệ.');
    this.disconnect();
    const generation = this.generation;
    const client = new Client();
    const config = { host, port, username, readyTimeout: 60000, keepaliveInterval: 10000,
      keepaliveCountMax: 2,
      hostVerifier: (key, callback) => {
        const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        Promise.resolve(this.verifyHost({ host, port, fingerprint })).then(value => callback(value === true), () => callback(false));
      } };
    if (input.privateKeyPath) {
      const stat = await fs.stat(input.privateKeyPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw fault('INVALID_KEY_FILE', 'File khóa SSH không hợp lệ.');
      config.privateKey = await fs.readFile(input.privateKeyPath);
      if (input.passphrase) config.passphrase = String(input.passphrase);
    } else {
      if (typeof input.password !== 'string' || !input.password) throw fault('SSH_PASSWORD_REQUIRED', 'Nhập mật khẩu SSH hoặc chọn khóa.');
      config.password = input.password;
    }
    if (generation !== this.generation) throw fault('CONNECTION_CANCELLED', 'Đã hủy kết nối.');
    this.pendingClient = client;
    await new Promise((resolve, reject) => {
      let ready = false;
      client.once('ready', () => {
        ready = true;
        if (generation !== this.generation) { client.end(); reject(fault('CONNECTION_CANCELLED', 'Đã hủy kết nối.')); return; }
        this.client = client;
        this.pendingClient = null;
        this.identity = { host, port, username };
        resolve();
      });
      client.on('error', error => {
        if (!ready) reject(fault(error.level === 'client-authentication' ? 'SSH_AUTH_FAILED' : 'SSH_CONNECTION_FAILED',
          error.level === 'client-authentication' ? 'SSH từ chối xác thực. Kiểm tra user, mật khẩu hoặc khóa.' : 'Không nối được SSH. Kiểm tra IP, Wi-Fi và khóa nhận diện robot.'));
      });
      client.once('close', () => {
        if (this.pendingClient === client) this.pendingClient = null;
        if (!ready) reject(fault('SSH_CONNECTION_CLOSED', 'Kết nối SSH đã đóng trước khi xác thực.'));
        if (this.client === client) { this.client = null; this.identity = null; this.onDisconnected(); }
      });
      client.connect(config);
    });
    return this.summary();
  }
  disconnect() {
    this.generation++;
    const client = this.client;
    const pending = this.pendingClient;
    this.client = null;
    this.pendingClient = null;
    this.identity = null;
    client?.end();
    if (pending !== client) pending?.end();
  }
  async call(action, payload = {}) {
    if (!ACTIONS.has(action)) throw fault('ACTION_NOT_ALLOWED', 'Thao tác không được hỗ trợ.');
    const client = this.client;
    if (!client) throw fault('SSH_NOT_CONNECTED', 'Kết nối SSH tới robot trước.');
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 65536) throw fault('PAYLOAD_TOO_LARGE', 'Dữ liệu gửi robot quá lớn.');
    let helper;
    try { helper = await fs.readFile(this.helperPath); }
    catch { throw fault('APP_INCOMPLETE', 'Bản app thiếu module điều khiển robot. Cập nhật bản đầy đủ trước khi Start; chưa gửi lệnh tới Pi.'); }
    const code = "import base64;exec(compile(base64.b64decode(" + JSON.stringify(helper.toString('base64')) + "),'<mar-desktop-control>','exec'))";
    const command = 'python3 -B -c ' + quote(code) + ' ' + quote(action);
    const timeoutMs = action === 'stop' ? 150000 : action === 'start' ? 45000 : 30000;
    return new Promise((resolve, reject) => {
      let bytes = 0, output = '', errors = '', stream;
      const timeout = setTimeout(() => {
        stream?.close();
        reject(fault('REMOTE_TIMEOUT', 'Robot chưa trả kết quả. Kiểm tra trạng thái trước khi thử lại; lệnh có thể đã được nhận.'));
      }, timeoutMs);
      client.exec(command, { pty: false }, (error, channel) => {
        if (error) { clearTimeout(timeout); reject(fault('REMOTE_EXEC_FAILED', 'Không mở được kênh điều khiển SSH.')); return; }
        stream = channel;
        const receive = (chunk, stderr) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { channel.close(); clearTimeout(timeout); reject(fault('REMOTE_OUTPUT_TOO_LARGE', 'Log robot vượt giới hạn đọc.')); return; }
          if (stderr) errors += chunk.toString(); else output += chunk.toString();
        };
        channel.on('data', chunk => receive(chunk, false));
        channel.stderr.on('data', chunk => receive(chunk, true));
        channel.on('error', () => { clearTimeout(timeout); reject(fault('REMOTE_CHANNEL_FAILED', 'Kênh SSH bị gián đoạn; hãy kiểm tra lại trạng thái.')); });
        channel.on('close', code => {
          clearTimeout(timeout);
          let result;
          try { result = JSON.parse(output.trim()); }
          catch { reject(fault('INVALID_ROBOT_RESPONSE', 'Robot không trả JSON hợp lệ. Kiểm tra Python 3 và quyền sudo trên host Pi.')); return; }
          if (!result.ok) { reject(fault(result.error?.code || 'ROBOT_ACTION_FAILED', result.error?.message || 'Robot từ chối thao tác.')); return; }
          if (code !== 0) { reject(fault('ROBOT_ACTION_FAILED', 'Thao tác robot chưa hoàn tất.')); return; }
          resolve(result.data);
        });
        channel.end(body);
      });
    });
  }
}

module.exports = { RobotSsh, validHost, quote, ACTIONS };
