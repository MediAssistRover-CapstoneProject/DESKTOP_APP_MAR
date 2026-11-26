'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const { Settings } = require('./core/settings');
const { RobotSsh } = require('./core/ssh');
const { BeClient, validateBaseUrl } = require('./core/be-client');
const { Launcher } = require('./core/launcher');
const wifi = require('./core/windows-wifi');
const discovery = require('./core/discovery');

let window, settings, ssh, cloud, launcher;
let activeAction = false;
let stopping = false;
let expiryTimer;
let disconnectWhenIdle = false;
const LOCKED = Object.freeze({ authenticated: false });
const sensitive = new Set();
function clean(value, password) {
  let text = String(value || '');
  if (typeof password === 'string' && password.length >= 4) text = text.replaceAll(password, '[đã ẩn]');
  for (const secret of sensitive) if (secret.length >= 4) text = text.replaceAll(secret, '[đã ẩn]');
  return text.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [đã ẩn]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token đã ẩn]')
    .replace(/((?:password|passwd|secret|accessToken|refreshToken)\s*[=:]\s*)[^\s,}]+/gi, '$1[đã ẩn]');
}
function progress(message) {
  if (currentSession() && window && !window.isDestroyed()) window.webContents.send('mar:progress', clean(message));
}
function fault(code, message) { const error = new Error(message); error.code = code; return error; }
function currentContext() { const { container, projectPath } = settings.value; return { container, projectPath }; }
function disconnectLockedSession() {
  if (!disconnectWhenIdle || activeAction || stopping) return;
  disconnectWhenIdle = false;
  ssh.disconnect();
  sensitive.clear();
}
function lockSession(reason) {
  if (!cloud) return;
  clearTimeout(expiryTimer);
  cloud.logout();
  cloud = null;
  disconnectWhenIdle = true;
  disconnectLockedSession();
  const change = reason ? { ...LOCKED, reason } : LOCKED;
  if (window && !window.isDestroyed()) window.webContents.send('mar:authChanged', change);
}
function currentSession() {
  if (cloud && !cloud.summary().authenticated) lockSession('AUTH_EXPIRED');
  return cloud;
}
function requireCloud() {
  const session = currentSession();
  if (!session) throw fault('ADMIN_LOGIN_REQUIRED', 'Vui lòng đăng nhập bằng tài khoản ADMIN để tiếp tục.');
  return session;
}
function watchExpiry(session, expiresAt) {
  const delay = Math.min(Math.max(0, Date.parse(expiresAt) - Date.now()), 2_147_483_647);
  expiryTimer = setTimeout(() => {
    if (cloud === session && currentSession()) watchExpiry(session, expiresAt);
  }, delay);
  expiryTimer.unref();
}
async function exclusive(action) {
  if (stopping) throw fault('STOP_IN_PROGRESS', 'Đang chờ robot xác nhận STOP.');
  if (activeAction) throw fault('ACTION_IN_PROGRESS', 'Đang xử lý thao tác trước. Chờ kết quả trước khi gửi tiếp.');
  activeAction = true;
  try { return await action(); } finally { activeAction = false; }
}
async function trustHost({ host, port, fingerprint }) {
  const session = currentSession();
  if (!session) return false;
  const key = `${host}:${port}`, known = settings.value.knownHosts;
  if (known[key]) {
    if (known[key] !== fingerprint) throw fault('SSH_HOST_KEY_CHANGED', 'Khóa nhận diện IP này đã đổi. Kiểm tra đúng robot trước khi xóa ghép nối.');
    return true;
  }
  if (!Object.values(known).includes(fingerprint)) {
    const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['Hủy', 'Ghép nối robot'], defaultId: 0, cancelId: 0,
      title: 'Xác nhận robot lần đầu', message: `Kết nối lần đầu với robot tại ${host}?`,
      detail: `Chỉ xác nhận khi đây là robot bạn muốn sử dụng. Ứng dụng sẽ ghi nhớ nhận diện robot cho những lần sau.\n\nThông tin kỹ thuật để đối chiếu:\n${fingerprint}\nCổng: ${port}` });
    if (choice.response !== 1 || currentSession() !== session) return false;
  }
  known[key] = fingerprint;
  await settings.save({ knownHosts: known });
  return true;
}
function register(name, action, { allowLocked = false, changesSession = false } = {}) {
  ipcMain.handle('mar:' + name, async (event, input = {}) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame)
      return { ok: false, error: { code: 'IPC_DENIED', message: 'Nguồn gọi không hợp lệ.' } };
    try {
      const session = allowLocked ? currentSession() : requireCloud();
      const data = await action(input || {});
      if (!allowLocked && !changesSession && currentSession() !== session)
        throw fault('AUTH_EXPIRED', 'Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.');
      return { ok: true, data };
    }
    catch (error) {
      const message = clean(error.message || 'Thao tác chưa hoàn tất.', name === 'login' ? input?.password : undefined);
      return { ok: false, error: { code: error.code || 'ACTION_FAILED', message, status: error.status, uncertain: error.uncertain === true } };
    }
    finally {
      currentSession();
      disconnectLockedSession();
    }
  });
}
function registerActions() {
  register('settings', () => {
    const session = currentSession();
    const version = app.getVersion();
    if (!session) return { settings: { baseUrl: settings.value.baseUrl }, cloud: LOCKED, version };
    return { settings: settings.snapshot(), ssh: ssh.summary(), cloud: session.summary(), version };
  }, { allowLocked: true });
  register('saveSettings', ({ baseUrl, ...input }) => exclusive(() => settings.save(input)));
  register('changeServer', input => exclusive(async () => {
    const baseUrl = validateBaseUrl(input.baseUrl);
    if (baseUrl.length > 1024) throw fault('INVALID_BE_URL', 'Địa chỉ hệ thống quá dài.');
    if (baseUrl === cloud.baseUrl) return { authenticated: true };
    const previousUrl = settings.value.baseUrl;
    try { await settings.save({ baseUrl }); }
    catch (error) { settings.update({ baseUrl: previousUrl }); throw error; }
    lockSession();
    return LOCKED;
  }), { changesSession: true });
  register('discover', input => discovery.discoverRobots({ hosts: [...new Set([settings.value.host, ...(Array.isArray(input.hosts) ? input.hosts : [])].filter(value => typeof value === 'string' && value.trim()))], timeoutMs: 1200 }));
  register('wifiStatus', () => wifi.getWifiStatus());
  register('wifiNetworks', () => wifi.listWifiNetworks());
  register('connectLaptopWifi', input => exclusive(async () => { if (input.password) sensitive.add(input.password); return wifi.connectWifi(input); }));
  register('connectRobot', input => exclusive(async () => {
    if (input.password) sensitive.add(input.password);
    if (input.passphrase) sensitive.add(input.passphrase);
    const result = await ssh.connect(input);
    await settings.save({ host: input.host, port: Number(input.port || 22), username: input.username || 'pi', privateKeyPath: input.privateKeyPath || '' });
    return result;
  }));
  register('disconnectRobot', () => { ssh.disconnect(); return { connected: false }; });
  register('robotStatus', () => ssh.call('status', currentContext()));
  register('robotWifiScan', () => ssh.call('wifi-scan', currentContext()));
  register('configureRobotWifi', input => exclusive(async () => {
    if (input.password) sensitive.add(input.password);
    const result = await ssh.call('wifi-configure', { ...currentContext(), ssid: input.ssid, password: input.password });
    progress('Pi đã nhận cấu hình Wi-Fi. Kết nối SSH sẽ mất khi Pi đổi mạng; trở lại Wi-Fi đích rồi tìm robot.');
    return result;
  }));
  register('pickKey', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Chọn khóa SSH', properties: ['openFile'], filters: [{ name: 'SSH private key', extensions: ['pem', 'key', '*'] }] });
    return { path: result.canceled ? '' : result.filePaths[0] };
  });
  register('login', input => exclusive(async () => {
    if (currentSession()) throw fault('ALREADY_AUTHENTICATED', 'Đăng xuất trước khi đăng nhập bằng tài khoản khác.');
    const candidate = new BeClient({ baseUrl: settings.value.baseUrl });
    const result = await candidate.login(input.username, input.password);
    if (!result.authenticated) {
      candidate.logout();
      throw fault('AUTH_EXPIRED', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    }
    cloud = candidate;
    launcher.cloud = candidate;
    watchExpiry(candidate, result.expiresAt);
    return result;
  }), { allowLocked: true });
  register('logout', () => { lockSession(); return LOCKED; }, { changesSession: true });
  register('cloudCatalog', async () => {
    const [maps, floors, robots, workflows] = await Promise.all([cloud.listMaps(), cloud.listFloors(), cloud.listRobots(), cloud.listMappingWorkflows()]);
    return { maps, floors, robots, workflows };
  });
  register('cloudStatus', input => cloud.getRobotSnapshot(input.robotId || settings.value.robotId));
  register('startMapping', input => exclusive(async () => { await settings.save({ robotId: input.robotId }); requireCloud(); return launcher.mapping(input); }));
  register('startNavigation', input => exclusive(async () => { await settings.save({ robotId: input.robotId }); requireCloud(); return launcher.navigation(input); }));
  register('stopRobot', async () => {
    if (stopping) throw fault('STOP_IN_PROGRESS', 'Đang chờ robot xác nhận STOP.');
    stopping = true;
    try { return await launcher.stop(); } finally { stopping = false; }
  });
  register('robotLogs', async input => {
    const result = await ssh.call('logs', { ...currentContext(), name: input.name || 'worker', lines: 100 });
    return JSON.parse(clean(JSON.stringify(result)));
  });
  register('openPage', async input => {
    const pages = { mapping: '/mapping.html', delivery: '/delivery-qr.html', camera: '/media-call.html' };
    if (!Object.hasOwn(pages, input.page)) throw fault('PAGE_NOT_ALLOWED', 'Trang không được hỗ trợ.');
    const url = new URL(pages[input.page], cloud.baseUrl);
    if (url.protocol !== 'https:') throw fault('HTTPS_REQUIRED', 'Đường dẫn BE phải dùng HTTPS.');
    await shell.openExternal(url.href);
    return { opened: true };
  });
}
async function createWindow() {
  window = new BrowserWindow({ width: 1250, height: 860, minWidth: 1020, minHeight: 720, title: 'MAR Desktop',
    backgroundColor: '#f5f6f3', show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await window.loadFile(path.join(__dirname, 'renderer/index.html'));
  window.show();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    settings = new Settings(app.getPath('userData')); await settings.load();
    ssh = new RobotSsh({ helperPath: path.join(app.getAppPath(), 'remote/control.py'), verifyHost: trustHost,
      onDisconnected: () => progress('SSH đã ngắt. Tiến trình stack do supervisor quản lý; hãy tìm/kết nối lại robot để đọc trạng thái.') });
    launcher = new Launcher({ ssh, settings: () => settings.value, progress });
    registerActions(); await createWindow();
  }).catch(error => { dialog.showErrorBox('Không mở được MAR Desktop', clean(error.message)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { clearTimeout(expiryTimer); ssh?.disconnect(); cloud?.logout(); sensitive.clear(); });
}
