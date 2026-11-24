'use strict';
const $ = id => document.getElementById(id);
const state = {
  page: 'connect', mode: 'navigation', ssh: false, cloud: false, host: '', settings: {},
  robotStatus: null, snapshot: null, catalogLoaded: false, running: null, startPending: false,
  launching: false, stopping: false, refreshing: false, networkChanging: false, busy: 0, returnSsid: '',
  result: null, lastError: null, activity: []
};
const labels = { connect: 'Kết nối', run: 'Sử dụng robot', network: 'Đổi Wi-Fi', logs: 'Hỗ trợ' };
const issues = {
  SSH_AUTH_FAILED: ['Mật khẩu kết nối chưa đúng. Kiểm tra lại mật khẩu hoặc nhờ người quản lý robot.', 'connect'],
  SSH_CONNECTION_FAILED: ['Chưa kết nối được robot. Kiểm tra robot đã bật và máy tính dùng cùng mạng Wi-Fi.', 'connect'],
  SSH_CONNECTION_CLOSED: ['Kết nối với robot đã ngắt. Kết nối lại để kiểm tra robot; chương trình trên robot có thể vẫn đang chạy.', 'connect'],
  SSH_NOT_CONNECTED: ['Kết nối robot trước khi thực hiện thao tác này.', 'connect'],
  REMOTE_CHANNEL_FAILED: ['Kết nối với robot bị gián đoạn. Kết nối lại để kiểm tra trạng thái.', 'connect'],
  SSH_PASSWORD_REQUIRED: ['Nhập mật khẩu kết nối robot.', 'connect'],
  INVALID_HOST: ['Nhập địa chỉ robot hoặc chọn một thiết bị tìm thấy trên mạng.', 'connect'],
  LOCAL_HOST_REQUIRED: ['Nhập địa chỉ trong mạng của robot, ví dụ raspberrypi.local hoặc địa chỉ IP.', 'connect'],
  AUTH_EXPIRED: ['Đăng nhập lại tài khoản quản lý để tiếp tục.', 'run'],
  ADMIN_LOGIN_REQUIRED: ['Đăng nhập tài khoản quản lý ở phần Sử dụng robot.', 'run'],
  ADMIN_REQUIRED: ['Tài khoản này không có quyền quản lý robot. Dùng tài khoản quản trị được cấp.', 'run'],
  OLD_SESSION_OPEN: ['Phiên sử dụng trước chưa kết thúc. Kiểm tra nhiệm vụ cũ hoặc chọn kết thúc phiên trước để bắt đầu lại.', 'run'],
  NAVIGATION_SESSION_ALREADY_OPEN: ['Robot đang có phiên sử dụng bản đồ khác. Kiểm tra và kết thúc phiên cũ trước.', 'run'],
  STACK_ALREADY_RUNNING: ['Chương trình robot đã chạy. Bạn có thể mở bản đồ để tiếp tục sử dụng.', 'mapping'],
  STOP_STACK_FIRST: ['Dừng robot trước khi đổi bản đồ hoặc Wi-Fi.', 'run'],
  ROBOT_ID_MISMATCH: ['Robot đã kết nối khác với robot được chọn trong hệ thống. Chọn lại đúng robot.', 'run'],
  ROBOT_JOB_HELD: ['Một nhiệm vụ trước chưa kết thúc. Mở trang bản đồ và nhiệm vụ để kiểm tra.', 'mapping'],
  MAPPING_READY_TIMEOUT: ['Robot chưa hoàn tất kết nối với hệ thống. Cập nhật trạng thái trước khi bắt đầu lại.', 'run'],
  START_CANCELLED: ['Đã ngừng mở phiên vì có yêu cầu dừng. Kiểm tra trạng thái trước khi bắt đầu lại.', 'run'],
  STOP_NOT_CONFIRMED: ['Chưa xác nhận robot đã dừng. Cập nhật trạng thái hoặc nhờ kỹ thuật viên kiểm tra.', 'logs'],
  CLOCK_NOT_SYNCHRONIZED: ['Robot đang chờ đồng bộ giờ. Kiểm tra Internet, chờ một lúc rồi cập nhật trạng thái.', 'run'],
  SESSION_RACE: ['Một phiên khác vừa được mở. Cập nhật trạng thái để xem phiên đang dùng.', 'run'],
  APP_INCOMPLETE: ['Ứng dụng thiếu thành phần cần thiết. Mở bản cài đầy đủ hoặc nhờ kỹ thuật viên kiểm tra.', 'logs'],
  PROJECT_STATUS_UNAVAILABLE: ['Đã kết nối được robot nhưng chưa đọc được chương trình điều khiển. Nhờ kỹ thuật viên kiểm tra.', 'logs'],
  PROJECT_NOT_FOUND: ['Chưa tìm thấy chương trình điều khiển trên robot. Nhờ kỹ thuật viên kiểm tra cài đặt.', 'logs'],
  DOCKER_STATUS_UNAVAILABLE: ['Chưa kiểm tra được chương trình điều khiển trên robot. Nhờ kỹ thuật viên kiểm tra.', 'logs'],
  CONTAINER_NOT_RUNNING: ['Chương trình nền của robot chưa sẵn sàng. Nhờ kỹ thuật viên kiểm tra.', 'logs'],
  WIFI_BACKEND_UNSUPPORTED: ['Ứng dụng chưa hỗ trợ đổi Wi-Fi trên phiên bản robot này. Nhờ kỹ thuật viên hỗ trợ.', 'logs'],
  INVALID_WIFI_PASSWORD: ['Mật khẩu Wi-Fi chưa hợp lệ. Kiểm tra lại mật khẩu của mạng muốn kết nối.', 'network'],
  BE_UNREACHABLE: ['Chưa kết nối được hệ thống quản lý. Kiểm tra Internet rồi thử cập nhật lại.', 'run'],
  BE_TIMEOUT: ['Hệ thống quản lý phản hồi chậm. Cập nhật trạng thái trước khi thử lại.', 'run'],
  ACTION_IN_PROGRESS: ['Một thao tác đang được xử lý. Chờ kết quả trước khi thực hiện tiếp.', null],
  STOP_IN_PROGRESS: ['Đang chờ robot dừng. Chưa bắt đầu phiên mới.', null]
};
function activity(message) {
  state.activity.push('[' + new Date().toLocaleTimeString('vi-VN') + '] ' + message);
  state.activity = state.activity.slice(-150);
  $('activityLog').textContent = state.activity.join('\n');
  $('globalStatus').textContent = String(message).split('\n')[0];
}
function notice(message, error = false, action = null) {
  $('notice').hidden = !message;
  $('notice').className = error ? 'error' : '';
  $('noticeText').textContent = message || '';
  const button = $('noticeAction');
  button.hidden = !action;
  button.textContent = action ? action.label : '';
  button.onclick = action ? action.run : null;
  if (message) activity(message);
}
function goAction(target) {
  if (!target) return null;
  if (target === 'mapping') return { label: 'Mở bản đồ và nhiệm vụ', run: () => task(null, () => call('openPage', { page: 'mapping' })) };
  return { label: target === 'logs' ? 'Xem thông tin hỗ trợ' : 'Đi đến ' + labels[target].toLowerCase(), run: () => tab(target) };
}
function showIssue(error) {
  state.lastError = { time: new Date().toISOString(), code: error.code, message: error.message, uncertain: Boolean(error.uncertain) };
  let [message, target] = issues[error.code] || [
    error.code === 'UI_INPUT' ? error.message : 'Chưa hoàn tất thao tác. Kiểm tra thông tin hỗ trợ hoặc nhờ người quản lý kiểm tra.',
    error.code === 'UI_INPUT' ? null : 'logs'
  ];
  if (error.status === 401 && !state.cloud && error.code !== 'AUTH_EXPIRED') { message = 'Tên đăng nhập hoặc mật khẩu chưa đúng. Kiểm tra lại thông tin tài khoản quản lý.'; target = 'run'; }
  if (error.code === 'REMOTE_TIMEOUT' || error.uncertain) {
    message = 'Chưa nhận được xác nhận. Lệnh có thể đã được gửi; cập nhật trạng thái trước khi bấm lại.';
    target = 'run';
  }
  if (error.code === 'OLD_SESSION_OPEN') { $('sessionChoices').hidden = false; $('sessionChoices').open = true; }
  notice(message, true, goAction(target));
  $('notice').scrollIntoView({ block: 'nearest' });
  renderSupport();
}
function inputError(message) { const error = new Error(message); error.code = 'UI_INPUT'; throw error; }
async function call(name, input) {
  const result = await window.mar[name](input);
  if (!result?.ok) {
    const error = new Error(result?.error?.message || 'Thao tác chưa hoàn tất.');
    Object.assign(error, result?.error || {});
    if (['SSH_NOT_CONNECTED', 'SSH_CONNECTION_CLOSED', 'REMOTE_CHANNEL_FAILED'].includes(error.code)) sshBadge(false);
    if (['ADMIN_LOGIN_REQUIRED', 'AUTH_EXPIRED'].includes(error.code)) cloudBadge(null);
    throw error;
  }
  return result.data;
}
async function task(button, action) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  state.busy++; document.body.classList.add('busy');
  try { return await action(); }
  catch (error) { showIssue(error); }
  finally {
    if (button) button.disabled = false;
    state.busy--; if (!state.busy) document.body.classList.remove('busy');
    renderActions();
  }
}
function tab(name) {
  state.page = name;
  document.querySelector('.content').scrollTop = 0;
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === 'page-' + name));
  $('pageTitle').textContent = labels[name];
  $('notice').hidden = true;
  if (name === 'run' && state.cloud) cloudStatus().catch(showIssue);
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  $('mappingOptions').hidden = mode !== 'mapping';
  $('navigationOptions').hidden = mode !== 'navigation';
  $('startRobot').textContent = mode === 'mapping' ? 'Bắt đầu tạo bản đồ' : 'Bắt đầu sử dụng';
  renderActions();
}
function sshBadge(connected, host) {
  state.ssh = connected;
  if (connected) { state.host = host || state.host; state.networkChanging = false; }
  else { state.robotStatus = null; state.snapshot = null; state.running = null; }
  $('sshBadge').textContent = connected ? 'Đã kết nối robot' : 'Chưa kết nối robot';
  $('sshBadge').className = 'chip ' + (connected ? 'good' : 'neutral');
  $('sideLight').classList.toggle('on', connected);
  $('sideRobot').textContent = connected ? 'Đã kết nối robot' : 'Chưa kết nối';
  $('sideHost').textContent = connected ? state.host : 'Bật robot để bắt đầu';
  $('robotAddress').textContent = connected ? state.host : '—';
  $('sshForm').hidden = connected;
  $('connectedPanel').hidden = !connected;
  $('connectRequired').hidden = connected;
  $('stopRobot').hidden = !connected;
  renderActions(); renderReadiness(); renderSupport();
}
function cloudBadge(summary) {
  state.cloud = summary?.authenticated === true;
  if (!state.cloud) { state.snapshot = null; state.catalogLoaded = false; }
  $('cloudBadge').textContent = state.cloud ? 'Đã đăng nhập' : 'Chưa đăng nhập';
  $('cloudBadge').className = 'chip ' + (state.cloud ? 'good' : 'neutral');
  $('cloudIdentity').textContent = state.cloud ? (summary.account?.fullName || summary.account?.username || 'Tài khoản quản lý') : 'Đăng nhập để xem danh sách bản đồ.';
  $('logout').hidden = !state.cloud; $('loginForm').hidden = state.cloud;
  $('runSetup').hidden = !state.cloud;
  document.querySelector('.cloud-card').classList.toggle('signed-in', state.cloud);
  renderActions(); renderSupport();
}
function projectProblem() {
  const result = state.robotStatus;
  if (!result) return '';
  if (result.project?.exists === false || result.docker?.running === false) return 'Chương trình điều khiển chưa sẵn sàng. Xem phần Hỗ trợ.';
  if (result.host?.ntpSynchronized === false) return 'Robot đang chờ cập nhật giờ. Kiểm tra Internet rồi cập nhật lại trạng thái.';
  return '';
}
function renderActions() {
  let hint = '';
  if (state.networkChanging) hint = 'Robot đang đổi Wi-Fi. Kết nối lại robot sau khi đổi mạng.';
  else if (state.launching) hint = 'Đang mở phiên. Chờ thông báo hoàn tất.';
  else if (state.stopping) hint = 'Đang dừng robot. Chờ xác nhận trước khi bắt đầu lại.';
  else if (!state.ssh) hint = 'Kết nối robot trước khi bắt đầu.';
  else if (!state.cloud) hint = 'Đăng nhập tài khoản quản lý để chọn bản đồ.';
  else if (!state.robotStatus) hint = 'Cập nhật trạng thái để kiểm tra robot.';
  else if (projectProblem()) hint = projectProblem();
  else if (state.running || state.startPending) hint = 'Robot đã nhận yêu cầu mở phiên. Mở bản đồ để tiếp tục, hoặc cập nhật trạng thái.';
  else if (!state.catalogLoaded) hint = 'Bấm Cập nhật để tải danh sách bản đồ.';
  else if (!$('robotSelect').value) hint = 'Chưa có robot trong hệ thống. Nhờ người quản lý kiểm tra.';
  else if (state.mode === 'navigation' && !$('mapSelect').value) hint = 'Chọn một bản đồ hoặc tạo bản đồ mới.';
  else if (state.mode === 'mapping' && (!$('floorSelect').value || !$('mappingWorkflow').value)) hint = 'Cần có tầng và quy trình tạo bản đồ trước khi bắt đầu.';
  else if (state.mode === 'mapping' && !$('mapName').value.trim()) hint = 'Đặt tên cho bản đồ mới để bắt đầu.';
  $('startRobot').disabled = Boolean(hint);
  $('runHint').textContent = hint || (state.mode === 'mapping' ? 'Sau khi mở phiên, bạn sẽ điều khiển robot và lưu bản đồ.' : 'Sau khi mở phiên, xác định vị trí robot trên bản đồ.');
  $('continueToRun').disabled = !state.ssh;
  $('stopRobot').disabled = !state.ssh || state.stopping;
  $('cloudRefresh').disabled = !state.cloud || state.refreshing;
  const canChangeWifi = state.ssh && state.robotStatus && !state.running && !state.startPending && !state.launching && !state.stopping && !state.networkChanging;
  $('sendRobotWifi').disabled = !canChangeWifi;
  $('scanRobotWifi').disabled = !canChangeWifi;
  $('robotWifiHint').textContent = !state.ssh ? 'Kết nối robot trước khi gửi Wi-Fi mới.' : !canChangeWifi ? 'Dừng chương trình robot trước khi tìm hoặc đổi Wi-Fi.' : 'Robot sẽ ngắt kết nối với ứng dụng trong lúc đổi mạng.';
  $('taskProgress').hidden = !state.launching && !state.stopping;
}
function renderReadiness() {
  let text = 'Chưa mở phiên sử dụng';
  const snapshot = state.snapshot, nav = snapshot?.navigationSession;
  if (!state.ssh) text = 'Ứng dụng chưa kết nối robot';
  else if (state.networkChanging) text = 'Robot đang đổi Wi-Fi…';
  else if (state.stopping) text = 'Đang dừng robot…';
  else if (state.launching) text = 'Đang chuẩn bị robot…';
  else if (projectProblem()) text = 'Robot cần được kiểm tra';
  else if (state.running === false && !state.startPending) text = 'Chưa mở phiên sử dụng';
  else if (snapshot?.mqttConnected && snapshot.heartbeatFresh) {
    if (snapshot.activeJobId) text = 'Đang thực hiện hoặc xử lý một nhiệm vụ';
    else if (nav?.state === 'READY' && snapshot.dispatchReady !== false) text = 'Đã xác định vị trí · có thể nhận nhiệm vụ';
    else if (snapshot.dispatchReady === false) text = 'Đã kết nối · chưa sẵn sàng nhận nhiệm vụ';
    else if (nav?.state === 'LOCALIZING') text = 'Cần xác định vị trí trên bản đồ';
    else text = 'Đã kết nối với hệ thống quản lý';
  } else if (state.running || state.startPending) text = 'Chương trình đang mở · chờ phản hồi từ robot';
  $('readiness').textContent = text;
  if (state.ssh) $('stackState').textContent = state.stopping ? 'Đang dừng' : state.running ? 'Chương trình đang chạy' : state.startPending ? 'Đang khởi động' : state.running === false ? 'Chưa mở phiên' : 'Chưa kiểm tra';
  const open = nav?.sessionId && !['NONE', 'CLOSED', 'EXPIRED'].includes(nav.state);
  $('sessionChoices').hidden = !open || Boolean(state.running || state.startPending);
  renderResult();
}
function renderResult() {
  const snapshot = state.snapshot, nav = snapshot?.navigationSession;
  const mode = state.robotStatus?.stack?.mode || state.result?.mode;
  const visible = Boolean(state.result || state.running || state.startPending || snapshot?.activeJobId);
  $('resultPanel').hidden = !visible;
  if (!visible) return;
  let title = 'Bước tiếp theo', text = 'Mở bản đồ để xem trạng thái robot và tiếp tục sử dụng.';
  if (!state.ssh) { title = 'Cần kết nối lại robot'; text = 'Kết nối ứng dụng đã ngắt. Robot có thể vẫn đang chạy; kết nối lại để kiểm tra.'; }
  else if (state.stopping) { title = 'Đang dừng robot'; text = 'Chờ robot xác nhận dừng trước khi mở phiên mới.'; }
  else if (state.running === false && !state.startPending) {
    title = 'Chương trình robot đã dừng';
    text = snapshot?.activeJobId ? 'Một nhiệm vụ vẫn cần được kết thúc trên hệ thống. Mở bản đồ và nhiệm vụ để kiểm tra.' : 'Bạn có thể chọn bản đồ và bắt đầu phiên mới.';
  } else if ((state.running || state.startPending) && (!snapshot?.mqttConnected || !snapshot.heartbeatFresh)) {
    title = 'Chờ robot phản hồi'; text = 'Chưa nhận được trạng thái mới. Kiểm tra mạng của robot rồi bấm Cập nhật.';
  } else if (mode === 'mapping') {
    title = 'Tiếp tục tạo bản đồ'; text = 'Mở bản đồ để điều khiển robot, quét khu vực và lưu kết quả.';
  } else if (snapshot?.activeJobId) { title = 'Theo dõi nhiệm vụ'; text = 'Mở bản đồ để xem và quản lý nhiệm vụ hiện tại.'; }
  else if (nav?.state === 'READY' && snapshot?.mqttConnected && snapshot.heartbeatFresh && snapshot.dispatchReady !== false) {
    title = 'Robot đã xác định vị trí'; text = 'Bạn có thể giao nhiệm vụ từ trang quản lý robot.';
  } else if (['LOCALIZING', 'READY'].includes(nav?.state)) {
    title = 'Xác định vị trí robot'; text = 'Mở bản đồ và đặt vị trí hiện tại của robot trước khi giao nhiệm vụ.';
  } else {
    title = 'Đang mở phiên sử dụng'; text = 'Chờ robot kết nối, sau đó mở bản đồ để xác định vị trí.';
  }
  $('resultTitle').textContent = title; $('runResult').textContent = text;
  const expiry = nav?.expiresAt || state.result?.session?.expiresAt;
  $('sessionExpiry').hidden = state.running === false && !state.startPending || ['CLOSED', 'EXPIRED'].includes(nav?.state) || !expiry;
  $('sessionExpiry').textContent = expiry && Number.isFinite(Date.parse(expiry)) ? 'Phiên sử dụng đến ' + new Date(expiry).toLocaleString('vi-VN') + '.' : '';
}
function renderSupport() {
  $('supportSummary').textContent = (state.ssh ? 'Ứng dụng đã kết nối robot tại ' + state.host + '.' : 'Ứng dụng chưa kết nối robot; chưa xác nhận được trạng thái chương trình.') + (state.cloud ? ' Đã đăng nhập hệ thống quản lý.' : ' Chưa đăng nhập hệ thống quản lý.');
  $('technicalState').textContent = JSON.stringify({ address: state.host, robot: state.robotStatus, system: state.snapshot, lastError: state.lastError }, null, 2);
}
function fillSelect(select, items, valueOf, labelOf, empty) {
  const prior = select.value; select.replaceChildren();
  if (!items?.length) { select.add(new Option(empty, '')); return; }
  for (const item of items) select.add(new Option(labelOf(item), valueOf(item)));
  if ([...select.options].some(option => option.value === prior)) select.value = prior;
}
function datalist(id, items) {
  $(id).replaceChildren(...[...new Set(items.filter(Boolean))].map(value => { const option = document.createElement('option'); option.value = value; return option; }));
}
async function wifiStatus() {
  const result = await call('wifiStatus');
  const current = result.interfaces?.find(item => item.ssid) || result.interfaces?.[0];
  const ssid = current?.ssid || '';
  $('apAddressHint').hidden = !/^HW(?:-|_)/i.test(ssid);
  $('laptopSsid').textContent = ssid || 'Chưa đọc được';
  $('laptopDetail').textContent = ssid ? '' : 'Bạn cũng có thể chọn mạng bằng cài đặt Wi-Fi của Windows.';
  $('networkLaptopStatus').textContent = ssid ? 'Máy tính đang dùng mạng: ' + ssid : 'Kiểm tra Wi-Fi máy tính trong cài đặt Windows.';
  if (ssid && !ssid.startsWith('HW')) { state.returnSsid = ssid; if (!$('targetSsid').value) $('targetSsid').value = ssid; }
  return result;
}
async function waitForWifi(ssid) {
  notice('Đang chờ máy tính kết nối mạng ' + ssid + '…');
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    const status = await wifiStatus();
    if (status.interfaces?.some(item => item.ssid === ssid && item.state === 'connected')) { notice('Máy tính đã kết nối mạng ' + ssid + '.'); return; }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  inputError('Chưa xác nhận máy tính đã nối mạng ' + ssid + '. Kiểm tra mật khẩu và sóng Wi-Fi trong cài đặt Windows.');
}
async function robotStatus() {
  const result = await call('robotStatus'); state.robotStatus = result;
  state.running = result.stack?.running === true || result.stackRunning === true;
  if (!state.running) state.startPending = ['active', 'activating', 'deactivating'].includes(result.service?.state);
  $('robotName').textContent = result.host?.hostname || 'MentorPi';
  $('stackDetail').textContent = state.running ? 'Chọn Sử dụng robot để tiếp tục phiên đang chạy.' : 'Chọn Tiếp tục để mở một phiên sử dụng.';
  if (projectProblem()) $('stackDetail').textContent = projectProblem();
  renderReadiness(); renderActions(); renderSupport();
  return result;
}
async function discover() {
  $('discoveryList').className = 'empty-state'; $('discoveryList').textContent = 'Đang tìm thiết bị trên mạng…';
  const result = await call('discover', { hosts: [$('host').value] });
  const found = new Map();
  for (const item of (result.candidates || []).filter(item => item.reachable)) {
    const key = [...(item.addresses || [item.host])].sort().join(',');
    if (!found.has(key) || item.host.endsWith('.local')) found.set(key, item);
  }
  $('discoveryList').replaceChildren();
  if (!found.size) { $('discoveryList').textContent = 'Chưa tìm thấy thiết bị. Kiểm tra robot đã bật và dùng cùng Wi-Fi, hoặc nhập địa chỉ đã biết.'; return; }
  $('discoveryList').className = 'candidates';
  for (const item of found.values()) {
    const button = document.createElement('button'); button.className = 'candidate';
    const label = document.createElement('span'); label.textContent = item.host;
    const hint = document.createElement('small'); hint.textContent = (item.addresses || []).join(', ') + ' · Chọn để kiểm tra kết nối';
    label.append(hint); button.append(label);
    button.addEventListener('click', () => { $('host').value = item.host; tab('connect'); $('sshPassword').focus(); });
    $('discoveryList').append(button);
  }
}
async function catalog() {
  const result = await call('cloudCatalog'); const firstLoad = !state.catalogLoaded;
  const name = item => item.robotName && item.robotName !== 'string' ? item.robotName : item.robotCode;
  fillSelect($('robotSelect'), result.robots, item => item.robotId, name, 'Chưa có robot');
  const selectedRobot = state.robotStatus?.project?.robotId || state.settings.robotId;
  if ([...$('robotSelect').options].some(option => option.value === selectedRobot)) $('robotSelect').value = selectedRobot;
  $('robotField').hidden = result.robots?.length === 1;
  fillSelect($('mapSelect'), result.maps, item => item.mapId, item => item.mapName, 'Chưa có bản đồ đang sử dụng');
  fillSelect($('floorSelect'), result.floors, item => item.floorId, item => item.floorName || item.floorCode, 'Chưa có tầng');
  fillSelect($('mappingWorkflow'), result.workflows, item => item.workflowId, item => item.workflowName, 'Chưa có quy trình tạo bản đồ');
  $('workflowField').hidden = result.workflows?.length === 1;
  $('navigationCatalogHint').hidden = Boolean(result.maps?.length);
  $('mappingCatalogHint').hidden = Boolean(result.workflows?.length);
  state.catalogLoaded = true;
  if (firstLoad && !result.maps?.length) setMode('mapping');
  renderActions(); await cloudStatus();
}
async function cloudStatus() {
  if (!state.cloud || !$('robotSelect').value || state.refreshing) return;
  const robotId = $('robotSelect').value;
  state.refreshing = true; renderActions();
  try {
    const snapshot = await call('cloudStatus', { robotId });
    if ($('robotSelect').value !== robotId || !state.cloud) return;
    state.snapshot = snapshot;
    renderReadiness(); renderSupport();
    return state.snapshot;
  } finally { state.refreshing = false; renderActions(); }
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => tab(button.dataset.goto)));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
for (const id of ['mapName', 'mapSelect', 'floorSelect', 'mappingWorkflow']) $(id).addEventListener('input', renderActions);
$('sshForm').addEventListener('submit', event => {
  event.preventDefault(); task($('connectRobot'), async () => {
    await call('saveSettings', { projectPath: $('projectPath').value.trim(), container: $('container').value.trim() });
    const input = { host: $('host').value.trim(), port: Number($('port').value), username: $('sshUser').value.trim(), password: $('sshPassword').value, privateKeyPath: $('keyPath').value, passphrase: $('keyPassphrase').value };
    try {
      const result = await call('connectRobot', input); sshBadge(true, result.host);
      await robotStatus();
      if (projectProblem()) notice(projectProblem(), true, goAction('logs'));
      else notice(state.running ? 'Đã kết nối robot. Tiếp tục phiên đang chạy ở phần Sử dụng robot.' : 'Đã kết nối robot. Chọn Tiếp tục để chọn bản đồ.', false, goAction('run'));
    } finally { $('sshPassword').value = ''; $('keyPassphrase').value = ''; }
  });
});
$('refreshRobot').addEventListener('click', event => task(event.currentTarget, async () => { await robotStatus(); notice(projectProblem() || 'Đã cập nhật trạng thái robot.', Boolean(projectProblem()), projectProblem() ? goAction('logs') : null); }));
$('disconnectRobot').addEventListener('click', event => task(event.currentTarget, async () => { await call('disconnectRobot'); sshBadge(false); notice('Đã ngắt kết nối ứng dụng. Thao tác này không dừng chương trình trên robot.'); }));
$('pickKey').addEventListener('click', event => task(event.currentTarget, async () => { const result = await call('pickKey'); if (result.path) $('keyPath').value = result.path; }));
$('clearKey').addEventListener('click', () => { $('keyPath').value = ''; });
$('saveSettings').addEventListener('click', event => task(event.currentTarget, async () => { state.settings = await call('saveSettings', { host: $('host').value.trim(), port: Number($('port').value), username: $('sshUser').value.trim(), projectPath: $('projectPath').value.trim(), container: $('container').value.trim(), privateKeyPath: $('keyPath').value }); notice('Đã lưu cài đặt kết nối.'); }));
$('discover').addEventListener('click', event => task(event.currentTarget, discover));
$('rediscover').addEventListener('click', event => task(event.currentTarget, async () => { await discover(); tab('connect'); }));
$('refreshWifi').addEventListener('click', event => task(event.currentTarget, wifiStatus));
$('scanLaptopWifi').addEventListener('click', event => task(event.currentTarget, async () => { const result = await call('wifiNetworks'); datalist('laptopNetworks', (result.networks || []).map(item => item.ssid)); notice(result.networks?.length ? 'Chọn mạng trong ô Tên Wi-Fi của robot.' : 'Chưa đọc được mạng Wi-Fi. Thử chọn mạng trong cài đặt Windows.'); }));
$('laptopWifiForm').addEventListener('submit', event => {
  event.preventDefault(); task(event.submitter, async () => {
    const ssid = $('laptopWifiName').value.trim();
    try { await call('connectLaptopWifi', { ssid, password: $('laptopWifiPassword').value }); }
    finally { $('laptopWifiPassword').value = ''; }
    await waitForWifi(ssid);
  });
});
$('scanRobotWifi').addEventListener('click', event => task(event.currentTarget, async () => { const result = await call('robotWifiScan'); datalist('robotNetworks', (result.networks || []).map(item => item.ssid)); notice('Chọn mạng trong ô Tên mạng Wi-Fi.'); }));
$('robotWifiForm').addEventListener('submit', event => {
  event.preventDefault(); task(event.submitter, async () => {
    const ssid = $('targetSsid').value.trim();
    try { await call('configureRobotWifi', { ssid, password: $('targetPassword').value }); state.networkChanging = true; notice('Robot đang đổi mạng. Tiếp tục bước 3 để đưa máy tính về cùng mạng với robot.'); }
    finally { $('targetPassword').value = ''; }
    $('laptopWifiName').value = ssid;
  });
});
$('returnWifi').addEventListener('click', event => task(event.currentTarget, async () => {
  const ssid = $('targetSsid').value.trim() || state.returnSsid;
  if (!ssid) inputError('Nhập tên mạng Wi-Fi muốn sử dụng ở bước 2.');
  await call('connectLaptopWifi', { ssid }); await waitForWifi(ssid); await discover(); tab('connect');
}));
$('loginForm').addEventListener('submit', event => {
  event.preventDefault(); task(event.submitter, async () => {
    try { const result = await call('login', { baseUrl: $('baseUrl').value.trim(), username: $('adminUser').value.trim(), password: $('adminPassword').value }); cloudBadge(result); await catalog(); notice('Đã đăng nhập. Chọn bản đồ và cách sử dụng robot.'); }
    finally { $('adminPassword').value = ''; }
  });
});
$('logout').addEventListener('click', event => task(event.currentTarget, async () => { await call('logout'); cloudBadge(null); notice('Đã đăng xuất tài khoản quản lý. Chương trình robot vẫn giữ nguyên trạng thái.'); }));
$('cloudRefresh').addEventListener('click', event => task(event.currentTarget, async () => { if (state.ssh) await robotStatus(); await catalog(); notice(projectProblem() || 'Đã cập nhật thông tin robot và bản đồ.', Boolean(projectProblem())); }));
$('robotSelect').addEventListener('change', () => { state.snapshot = null; $('reopenExisting').checked = false; renderReadiness(); task(null, cloudStatus); });
$('startRobot').addEventListener('click', event => task(event.currentTarget, async () => {
  const input = { robotId: $('robotSelect').value, reopenExisting: $('reopenExisting').checked };
  state.launching = true; state.startPending = true; $('progressText').textContent = 'Đang chuẩn bị robot…'; renderActions();
  try {
    const result = state.mode === 'mapping'
      ? await call('startMapping', { ...input, workflowId: $('mappingWorkflow').value, floorId: $('floorSelect').value, mapName: $('mapName').value })
      : await call('startNavigation', { ...input, mapId: $('mapSelect').value, durationSec: Number($('duration').value), loadProfile: $('loadProfile').value, voiceChat: $('voiceChat').checked, fallMonitor: $('fallMonitor').checked, restrictedMonitor: $('restrictedMonitor').checked });
    state.result = result; $('sessionResult').hidden = false;
    $('sessionResult').textContent = JSON.stringify({ session: result.session, job: result.job }, null, 2);
    $('reopenExisting').checked = false;
    await robotStatus(); await cloudStatus();
    notice(result.mode === 'mapping' ? 'Đã tạo yêu cầu quét. Mở bản đồ để điều khiển robot và lưu kết quả.' : 'Đã gửi yêu cầu mở phiên. Mở bản đồ để kiểm tra và xác định vị trí robot.', false, goAction('mapping'));
    $('resultPanel').scrollIntoView({ block: 'nearest' });
  } catch (error) {
    try { if (state.ssh) await robotStatus(); } catch { /* Keep uncertain Start blocked until status can be verified. */ }
    if (error.uncertain || ['REMOTE_TIMEOUT', 'REMOTE_CHANNEL_FAILED', 'SSH_CONNECTION_CLOSED'].includes(error.code)) state.startPending = true;
    throw error;
  } finally { state.launching = false; renderReadiness(); renderActions(); }
}));
$('stopRobot').addEventListener('click', event => task(event.currentTarget, async () => {
  state.stopping = true; $('progressText').textContent = 'Đang chờ robot dừng…'; renderActions(); renderReadiness();
  try {
    const result = await call('stopRobot');
    if (result.state === 'STOPPED') { state.startPending = false; state.running = false; }
    notice(result.state === 'STOPPED' ? 'Chương trình robot đã dừng. Nếu còn nhiệm vụ chưa kết thúc, kiểm tra trên trang bản đồ và nhiệm vụ.' : 'Robot đang dừng. Bấm Cập nhật để kiểm tra trước khi bắt đầu lại.');
    await robotStatus(); if (state.cloud) await cloudStatus();
  } finally { state.stopping = false; renderReadiness(); renderActions(); }
}));
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', event => task(event.currentTarget, () => call('openPage', { page: button.dataset.open }))));
$('refreshLogs').addEventListener('click', event => task(event.currentTarget, async () => {
  const result = await call('robotLogs', { name: $('logSource').value });
  $('logOutput').textContent = result.text ?? result.content ?? result.lines?.join('\n') ?? JSON.stringify(result, null, 2);
  $('logMeta').textContent = 'Cập nhật lúc ' + new Date().toLocaleTimeString('vi-VN');
}));
function userProgress(message) {
  if (/đóng phiên navigation/i.test(message)) return 'Đang kết thúc phiên sử dụng trước…';
  if (/tải map/i.test(message)) return 'Đang tải bản đồ cho robot…';
  if (/mở phiên dùng map/i.test(message)) return 'Đang tạo phiên sử dụng bản đồ…';
  if (/MQTT đã sẵn sàng/i.test(message)) return 'Robot đã kết nối. Đang tạo yêu cầu quét…';
  if (/heartbeat|lệnh Start/i.test(message)) return 'Đang chờ robot kết nối với hệ thống…';
  if (/mở stack quét/i.test(message)) return 'Đang mở chương trình tạo bản đồ trên robot…';
  if (/supervisor STOP/i.test(message)) return 'Đang chờ robot dừng…';
  return 'Đang xử lý yêu cầu…';
}
window.mar.onProgress?.(message => {
  if (message.startsWith('SSH đã ngắt.')) { sshBadge(false); notice('Mất kết nối với robot. Kết nối lại để kiểm tra; chương trình robot có thể vẫn đang chạy.', true, goAction('connect')); return; }
  if (state.launching || state.stopping) { const text = userProgress(message); $('progressText').textContent = text; activity(text); }
});
function updateClock() { $('clock').textContent = new Date().toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }); }
updateClock(); setInterval(updateClock, 30000);
setInterval(() => {
  if (document.hidden || state.page !== 'run' || !state.cloud || state.launching || state.stopping || state.refreshing) return;
  cloudStatus().catch(error => { state.lastError = { code: error.code, message: error.message, time: new Date().toISOString() }; $('readiness').textContent = 'Chưa cập nhật được trạng thái · bấm Cập nhật để kiểm tra'; renderSupport(); });
}, 10000);
task(null, async () => {
  const result = await call('settings'); state.settings = result.settings;
  for (const [id, key] of Object.entries({ host: 'host', port: 'port', sshUser: 'username', container: 'container', projectPath: 'projectPath', baseUrl: 'baseUrl', keyPath: 'privateKeyPath' })) $(id).value = result.settings[key] ?? '';
  $('version').textContent = 'Phiên bản ' + result.version;
  sshBadge(result.ssh.connected, result.ssh.host); cloudBadge(result.cloud); setMode('navigation');
  if (result.ssh.connected) await robotStatus();
  if (result.cloud.authenticated) await catalog();
  try { await wifiStatus(); } catch { $('laptopSsid').textContent = 'Chưa đọc được'; }
});
