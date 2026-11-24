'use strict';
const { setTimeout: sleep } = require('node:timers/promises');
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function requireUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '')))
    throw fail('INVALID_ID', `Chọn ${label} hợp lệ.`);
  return value;
}
function stackRunning(status) {
  return status?.stack?.running === true || status?.stackRunning === true;
}
function openSession(value) { return value?.sessionId && !['NONE', 'CLOSED', 'EXPIRED'].includes(value.state); }

class Launcher {
  constructor({ ssh, cloud, settings, progress = () => {}, sleepImpl = sleep, readyTimeoutMs = 75000 }) {
    this.ssh = ssh; this.cloud = cloud; this.settings = settings; this.progress = progress;
    this.sleep = sleepImpl; this.readyTimeoutMs = readyTimeoutMs;
    this.epoch = 0;
  }
  check(epoch) { if (epoch !== this.epoch) throw fail('START_CANCELLED', 'Đã yêu cầu dừng trong lúc mở stack. Không tạo thêm job; đọc lại trạng thái Pi và BE.'); }
  context() { const { projectPath, container } = this.settings(); return { projectPath, container }; }
  async ensureStopped(robotId) {
    const status = await this.ssh.call('status', this.context());
    if (status.docker?.running === false) throw fail('CONTAINER_NOT_RUNNING', 'Container MentorPi chưa chạy hoặc SSH không có quyền Docker. Kiểm tra Docker trên Pi trước khi mở phiên.');
    if (stackRunning(status)) throw fail('STACK_ALREADY_RUNNING', 'Stack đã chạy. Dừng stack và chờ STOP trước khi chọn chế độ khác.');
    if (robotId && status.project?.robotId !== robotId)
      throw fail('ROBOT_ID_MISMATCH', 'Robot được chọn trên BE khác robot_id trong worker config của Pi. Chọn lại robot hoặc cấu hình Pi trước khi mở phiên.');
    return status;
  }
  async prepareSession(robotId, reopenExisting) {
    const current = await this.cloud.getNavigationSession(robotId);
    if (openSession(current)) {
      if (!reopenExisting) throw fail('OLD_SESSION_OPEN', 'Robot còn phiên bản đồ mở. Chọn đóng phiên cũ để tạo phiên mới, hoặc dùng trang map để xử lý job còn giữ phiên.');
      this.progress('Đang đóng phiên navigation cũ qua BE…');
      await this.cloud.closeNavigationSession(robotId, current.sessionId);
    }
  }
  async mapping(input) {
    const epoch = this.epoch;
    const robotId = requireUuid(input.robotId, 'robot'), workflowId = requireUuid(input.workflowId, 'workflow quét');
    const floorId = requireUuid(input.floorId, 'tầng');
    const mapName = String(input.mapName || '').trim();
    if (!mapName || mapName.length > 160) throw fail('MAP_NAME_REQUIRED', 'Tên map cần từ 1–160 ký tự.');
    await this.ensureStopped(robotId);
    this.check(epoch);
    await this.prepareSession(robotId, input.reopenExisting === true);
    this.check(epoch);
    const beforeStart = await this.cloud.getRobotSnapshot(robotId);
    const serverStart = Date.parse(beforeStart.observedAt);
    this.check(epoch);
    if (!Number.isFinite(serverStart)) throw fail('INVALID_SNAPSHOT', 'BE chưa trả mốc thời gian trạng thái. Chưa gửi Start; hãy tải lại BE.');
    this.progress('Đang mở stack quét map trên Pi…');
    const started = await this.ssh.call('start', { ...this.context(), mode: 'mapping' });
    this.check(epoch);
    this.progress('Stack đã nhận lệnh Start. Đang chờ MQTT và heartbeat mới…');
    const until = Date.now() + this.readyTimeoutMs;
    let snapshot;
    while (Date.now() < until) {
      snapshot = await this.cloud.getRobotSnapshot(robotId);
      this.check(epoch);
      const heartbeatAt = Date.parse(snapshot.robot?.lastHeartbeatAt);
      if (snapshot.mqttConnected && snapshot.heartbeatFresh && snapshot.dispatchReady && snapshot.robot?.status === 'IDLE'
          && Number.isFinite(heartbeatAt) && heartbeatAt >= serverStart) break;
      if (snapshot.activeJobId) throw fail('ROBOT_JOB_HELD', 'Robot còn job trên BE. Stack đã mở; xử lý job cũ trên trang map trước khi tạo nhiệm vụ quét.');
      await this.sleep(1800);
    }
    if (!snapshot?.mqttConnected || !snapshot.heartbeatFresh || !snapshot.dispatchReady || snapshot.robot?.status !== 'IDLE'
        || !(Date.parse(snapshot.robot?.lastHeartbeatAt) >= serverStart))
      throw fail('MAPPING_READY_TIMEOUT', 'Stack đã nhận Start nhưng BE chưa xác nhận robot IDLE/MQTT sẵn sàng. Xem log; không bấm tạo job lặp lại.');
    this.progress('MQTT đã sẵn sàng. Đang tạo nhiệm vụ quét…');
    const job = await this.cloud.createMappingJob({ workflowId, robotId, floorId, mapName });
    return { mode: 'mapping', started, job, message: 'Đã tạo nhiệm vụ quét. Mở trang map để quét, điều khiển và lưu bản đồ.' };
  }
  async navigation(input) {
    const epoch = this.epoch;
    const robotId = requireUuid(input.robotId, 'robot'), mapId = requireUuid(input.mapId, 'map');
    const durationSec = Number(input.durationSec || 7200);
    if (!Number.isInteger(durationSec) || durationSec < 60 || durationSec > 28800)
      throw fail('INVALID_DURATION', 'Phiên bản đồ nhận 60–28.800 giây.');
    if (!['bare', 'cargo'].includes(input.loadProfile || 'cargo')) throw fail('INVALID_LOAD_PROFILE', 'Chọn robot trần hoặc có thùng.');
    await this.ensureStopped(robotId);
    this.check(epoch);
    await this.prepareSession(robotId, input.reopenExisting === true);
    this.check(epoch);
    this.progress('Đang mở phiên dùng map đã lưu trên BE…');
    const session = await this.cloud.openNavigationSession(robotId, mapId, durationSec);
    this.check(epoch);
    if (session.reused) throw fail('SESSION_RACE', 'Có phiên khác vừa được mở. Tải lại trạng thái trước khi Start; chưa phát lệnh stack.');
    this.progress('Đang tải map và mở stack navigation trên Pi…');
    try {
      const started = await this.ssh.call('start', { ...this.context(), mode: 'navigation', sessionId: session.sessionId,
        loadProfile: input.loadProfile || 'cargo', voiceChat: input.voiceChat === true,
        fallMonitor: input.fallMonitor === true, restrictedMonitor: input.restrictedMonitor === true });
      this.check(epoch);
      return { mode: 'navigation', started, session, message: 'Đã gửi Start. Chờ Pi tải map rồi khởi tạo vị trí trên trang map; chưa gửi MOVE.' };
    } catch (error) {
      // A timed-out Start can already be running. Keep the BE descriptor visible for inspection.
      error.message = `Phiên ${session.sessionId} đã tạo. ${error.message} Kiểm tra trạng thái trước khi tạo phiên khác.`;
      throw error;
    }
  }
  async stop() {
    this.epoch++;
    this.progress('Đang yêu cầu supervisor STOP; chờ dừng và dọn tiến trình…');
    const result = await this.ssh.call('stop', this.context());
    if (!['STOPPED', 'STOPPING'].includes(result?.state)) throw fail('STOP_NOT_CONFIRMED', 'Pi chưa trả xác nhận STOP hợp lệ. Đọc lại trạng thái trước khi mở phiên khác.');
    return { ...result, message: result.state === 'STOPPING'
      ? 'Pi đang dừng; chưa xác nhận STOP hoàn tất. Đọc trạng thái/log trước khi mở phiên khác.'
      : 'Pi đã xác nhận STOP. Job/incident còn recovery vẫn phải được xử lý qua BE; app không tự đổi trạng thái job.' };
  }
}
module.exports = { Launcher, requireUuid, stackRunning, openSession };
