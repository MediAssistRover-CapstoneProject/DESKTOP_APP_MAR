'use strict';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const OPEN_NAVIGATION_STATES = new Set(['OPEN', 'READY', 'LOCALIZING', 'WAITING_FOR_PI']);

function cleanMessage(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .slice(0, 600);
}

class BeClientError extends Error {
  constructor(code, message, options = {}) {
    super(cleanMessage(message, 'Không thực hiện được yêu cầu tới BE.'));
    this.name = 'BeClientError';
    this.code = code;
    this.status = options.status ?? null;
    this.correlationId = typeof options.correlationId === 'string'
      ? options.correlationId.slice(0, 100) : null;
    this.uncertain = Boolean(options.uncertain);
  }
}

function requiredUuid(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BeClientError('INVALID_INPUT', `${name} phải là UUID hợp lệ.`);
  }
  return value.toLowerCase();
}

function requiredText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new BeClientError('INVALID_INPUT', `${name} không hợp lệ.`);
  }
  return value.trim();
}

function validateBaseUrl(value, allowLocalHttpForTests = false) {
  let url;
  try { url = new URL(value); } catch { throw new BeClientError('INVALID_BE_URL', 'Địa chỉ BE không hợp lệ.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (allowLocalHttpForTests && local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new BeClientError('INVALID_BE_URL', 'BE phải dùng địa chỉ gốc HTTPS, không chứa tài khoản hoặc đường dẫn.');
  }
  return url.origin;
}

// Compatibility only for a conventional envelope; raw contract objects with a data
// business field must not be unwrapped accidentally.
function unwrap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.hasOwn(value, 'data')
      && (value.success === true || value.status === 'success')
      && Object.keys(value).every(key => ['data', 'success', 'status', 'message', 'timestamp'].includes(key))) {
    return value.data;
  }
  return value;
}

async function boundedText(response) {
  const advertised = response.headers?.get?.('content-length');
  if (advertised && Number(advertised) > MAX_BODY_BYTES) {
    await response.body?.cancel?.();
    throw new BeClientError('BE_RESPONSE_TOO_LARGE', 'Phản hồi BE vượt giới hạn cho phép.');
  }
  if (!response.body?.getReader) {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      throw new BeClientError('BE_RESPONSE_TOO_LARGE', 'Phản hồi BE vượt giới hạn cho phép.');
    }
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new BeClientError('BE_RESPONSE_TOO_LARGE', 'Phản hồi BE vượt giới hạn cho phép.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

class BeClient {
  #accessToken = null;
  #refreshToken = null;
  #expiresAt = null;
  #account = null;

  constructor({ baseUrl, fetchImpl = globalThis.fetch, allowLocalHttpForTests = false, timeoutMs = 15000 } = {}) {
    this.baseUrl = validateBaseUrl(baseUrl, allowLocalHttpForTests);
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.min(15000, Math.max(100, Number(timeoutMs) || 15000));
  }

  summary() {
    const account = this.#account;
    return {
      baseUrl: this.baseUrl,
      authenticated: Boolean(account && this.#accessToken && this.#expiresAt > Date.now()),
      account: account ? { accountId: account.accountId, username: account.username,
        fullName: account.fullName, role: account.role } : null,
      expiresAt: this.#expiresAt ? new Date(this.#expiresAt).toISOString() : null
    };
  }

  logout() {
    this.#accessToken = null;
    this.#refreshToken = null;
    this.#expiresAt = null;
    this.#account = null;
    return this.summary();
  }

  async login(username, password) {
    username = requiredText(username, 'Tên đăng nhập', 100);
    if (typeof password !== 'string' || !password || password.length > 500) {
      throw new BeClientError('INVALID_INPUT', 'Mật khẩu không hợp lệ.');
    }
    this.logout();
    try {
      const token = await this.#request('/api/v1/auth/login', {
        method: 'POST', auth: false, body: { username, password, deviceInfo: 'MAR Desktop' }
      });
      const expires = Date.parse(token?.accessTokenExpiresAt);
      if (!token || typeof token.accessToken !== 'string' || !token.accessToken
          || !Number.isFinite(expires) || expires <= Date.now()) {
        throw new BeClientError('INVALID_LOGIN_RESPONSE', 'BE không trả phiên đăng nhập hợp lệ.');
      }
      if (token.mustChangePassword) {
        throw new BeClientError('PASSWORD_CHANGE_REQUIRED', 'Tài khoản cần đổi mật khẩu trên trang quản trị trước.');
      }
      this.#accessToken = token.accessToken;
      this.#refreshToken = typeof token.refreshToken === 'string' ? token.refreshToken : null;
      this.#expiresAt = expires;
      const account = await this.#request('/api/v1/auth/me');
      if (account?.role !== 'ADMIN' || account.status !== 'ACTIVE' || account.mustChangePassword) {
        throw new BeClientError('ADMIN_REQUIRED', 'App vận hành cần tài khoản ADMIN đang hoạt động.');
      }
      this.#account = account;
      return this.summary();
    } catch (error) {
      this.logout();
      throw error;
    }
  }

  #requireAuth() {
    if (!this.#accessToken || !this.#expiresAt || this.#expiresAt <= Date.now()) {
      this.logout();
      throw new BeClientError('AUTH_EXPIRED', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    }
  }

  async #request(path, { method = 'GET', body, auth = true } = {}) {
    if (auth) this.#requireAuth();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const mutation = !['GET', 'HEAD'].includes(method);
    const headers = { Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${this.#accessToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal, redirect: 'error'
      });
      if (response.status === 401 && auth) this.logout();
      const raw = await boundedText(response);
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch {
          throw new BeClientError('INVALID_BE_RESPONSE', 'BE trả dữ liệu không phải JSON.', {
            status: response.status, uncertain: mutation && response.ok
          });
        }
      }
      if (!response.ok) {
        throw new BeClientError(response.status === 401 && auth ? 'AUTH_EXPIRED'
          : (typeof data?.error === 'string' ? data.error : 'BE_HTTP_ERROR'),
        response.status === 401 && auth ? 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.'
          : cleanMessage(data?.message, `BE trả lỗi HTTP ${response.status}.`),
        { status: response.status, correlationId: data?.correlationId });
      }
      return unwrap(data);
    } catch (error) {
      if (error instanceof BeClientError) throw error;
      const timeout = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
      throw new BeClientError(timeout ? 'BE_TIMEOUT' : 'BE_UNREACHABLE',
        mutation
          ? 'Chưa xác nhận BE đã xử lý yêu cầu. Tải lại trạng thái trước khi thử tạo lại.'
          : timeout ? 'BE phản hồi quá thời gian chờ.' : 'Không kết nối được BE. Kiểm tra Internet và địa chỉ HTTPS.',
      { uncertain: mutation });
    } finally {
      clearTimeout(timer);
    }
  }

  async #pages(path) {
    const all = [];
    for (let page = 0; page < 100; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const result = await this.#request(`${path}${separator}page=${page}&size=100`);
      if (!result || !Array.isArray(result.content)) {
        throw new BeClientError('INVALID_BE_RESPONSE', 'Danh mục BE không đúng định dạng phân trang.');
      }
      all.push(...result.content);
      if (result.last === true || result.content.length < 100 || (Number.isInteger(result.totalPages) && page + 1 >= result.totalPages)) {
        return all;
      }
    }
    throw new BeClientError('CATALOG_TOO_LARGE', 'Danh mục quá lớn. Hãy lọc dữ liệu ở trang quản trị.');
  }

  health() { return this.#request('/actuator/health', { auth: false }); }
  async listMaps() { return (await this.#pages('/api/v1/maps')).filter(map => map.status === 'ACTIVE'); }
  async listFloors() { return (await this.#pages('/api/v1/floors')).filter(floor => floor.active === true); }
  listRobots() { return this.#pages('/api/v1/robots'); }
  listWorkflows(serviceType) {
    if (typeof serviceType !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(serviceType)) {
      throw new BeClientError('INVALID_INPUT', 'Loại workflow không hợp lệ.');
    }
    return this.#pages(`/api/v1/workflows/published?serviceType=${encodeURIComponent(serviceType)}`);
  }
  async listMappingWorkflows() {
    return (await this.listWorkflows('MAPPING')).filter(workflow => workflow.schemaVersion === 3);
  }
  getRobotSnapshot(robotId) { return this.#request(`/api/v1/robots/${requiredUuid(robotId, 'Robot ID')}/snapshot`); }
  getNavigationSession(robotId) { return this.#request(`/api/v1/robots/${requiredUuid(robotId, 'Robot ID')}/navigation-session`); }
  async openNavigationSession(robotId, mapId, durationSec = 7200) {
    robotId = requiredUuid(robotId, 'Robot ID');
    mapId = requiredUuid(mapId, 'Map ID');
    if (!Number.isInteger(durationSec) || durationSec < 60 || durationSec > 28800) {
      throw new BeClientError('INVALID_INPUT', 'Thời lượng phiên phải từ 60 đến 28800 giây.');
    }
    const current = await this.getNavigationSession(robotId);
    if (OPEN_NAVIGATION_STATES.has(current?.state)
        && (!current.expiresAt || Date.parse(current.expiresAt) > Date.now())) {
      if (current.mapId !== mapId) {
        throw new BeClientError('NAVIGATION_SESSION_ALREADY_OPEN',
          'Robot đang có phiên map khác. Dừng stack và đóng phiên hiện tại trước khi đổi map.');
      }
      return { ...current, reused: true };
    }
    return this.#request(`/api/v1/robots/${robotId}/navigation-session`, {
      method: 'POST', body: { mapId, durationSec }
    });
  }
  closeNavigationSession(robotId, sessionId) {
    return this.#request(`/api/v1/robots/${requiredUuid(robotId, 'Robot ID')}/navigation-session/close`, {
      method: 'POST', body: { sessionId: requiredUuid(sessionId, 'Session ID') }
    });
  }
  initializeNavigation(robotId, sessionId, pose) {
    const body = { sessionId: requiredUuid(sessionId, 'Session ID'), mode: pose ? 'SEED' : 'GLOBAL' };
    if (pose) {
      for (const key of ['xM', 'yM', 'yawRad']) {
        if (typeof pose[key] !== 'number' || !Number.isFinite(pose[key])) throw new BeClientError('INVALID_INPUT', 'Tọa độ khởi tạo không hợp lệ.');
        body[key] = pose[key];
      }
      if (Math.abs(body.yawRad) > Math.PI) throw new BeClientError('INVALID_INPUT', 'Góc yaw phải từ -π đến π.');
    }
    return this.#request(`/api/v1/robots/${requiredUuid(robotId, 'Robot ID')}/navigation-session/initialization`, { method: 'POST', body });
  }
  createMappingJob({ workflowId, robotId, floorId, mapName } = {}) {
    return this.#request('/api/v1/mapping-jobs', { method: 'POST', body: {
      workflowId: requiredUuid(workflowId, 'Workflow ID'), robotId: requiredUuid(robotId, 'Robot ID'),
      floorId: requiredUuid(floorId, 'Floor ID'), mapName: requiredText(mapName, 'Tên map', 160)
    } });
  }
  getJob(jobId) { return this.#request(`/api/v1/jobs/${requiredUuid(jobId, 'Job ID')}`); }
  getMappingSession(jobId) { return this.#request(`/api/v1/jobs/${requiredUuid(jobId, 'Job ID')}/mapping-session?includePreview=false`); }
}

module.exports = { BeClient, BeClientError, validateBaseUrl };
