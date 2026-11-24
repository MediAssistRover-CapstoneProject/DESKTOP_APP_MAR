#!/usr/bin/env python3
"""Bounded SSH operations for the MAR desktop. No daemon and no boot autostart.

The desktop transmits this source through SSH and sends JSON on stdin. The only
commands accepted here are the named actions below; no arbitrary shell endpoint.
"""
import ast
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import stat
import subprocess
import sys
import time
import uuid

MAX_INPUT = 32768
UNIT = 'mar-desktop-stack.service'
DEFAULT_PROJECT = '/home/ubuntu/mediassist-mqtt-2026-10-08'
WIFI_SOURCE = Path('/home/pi/hiwonder-toolbox/wifi.py')
WIFI_CONFIG = WIFI_SOURCE.with_name('wifi_conf.py')


class ControlError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def fail(code, message):
    raise ControlError(code, message)


@contextmanager
def mutation_lock():
    import fcntl
    target = '/tmp/mar-desktop-control-' + str(os.getuid()) + '.lock'
    fd = os.open(target, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            fail('INVALID_CONTROL_LOCK', 'Không xác minh được khóa điều khiển trên Pi.')
        deadline = time.monotonic() + 40
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    fail('CONTROL_BUSY', 'Pi còn thao tác điều khiển trước; chưa xác nhận thao tác mới.')
                time.sleep(.2)
        yield
    finally:
        os.close(fd)


def run(argv, *, stdin=None, timeout=12, check=True):
    try:
        result = subprocess.run(argv, input=stdin, capture_output=True, text=True,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        fail('COMMAND_TIMEOUT', 'Thao tác quá thời gian; kiểm tra trạng thái trước khi thử lại.')
    except OSError:
        fail('COMMAND_UNAVAILABLE', 'Thiếu công cụ hệ thống cần thiết trên Pi.')
    if check and result.returncode:
        # Do not echo argv, stdin or stderr: network credentials can occur there.
        fail('REMOTE_COMMAND_FAILED', 'Pi từ chối thao tác. Kiểm tra Docker, sudo và nhật ký hệ thống.')
    return result


def options(payload):
    project = payload.get('projectPath', DEFAULT_PROJECT)
    container = payload.get('container', 'MentorPi')
    if (not isinstance(project, str) or len(project) > 400
            or not project.startswith('/home/ubuntu/') or '\\' in project
            or any(ord(c) < 32 for c in project) or '..' in PurePosixPath(project).parts
            or str(PurePosixPath(project)) != project):
        fail('INVALID_PROJECT_PATH', 'Thư mục dự án phải là đường dẫn tuyệt đối trong /home/ubuntu.')
    if not isinstance(container, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', container):
        fail('INVALID_CONTAINER', 'Tên container không hợp lệ.')
    return project, container


def container_state(container):
    result = run(['sudo', '-n', 'docker', 'inspect', '--format', '{{json .State}}', container], check=False)
    if result.returncode:
        fail('DOCKER_STATUS_UNAVAILABLE', 'Không đọc được container qua sudo Docker. Chưa xác nhận stack đã dừng; chưa đổi mạng.')
    try:
        state = json.loads(result.stdout)
        return {'running': state.get('Running') is True, 'status': state.get('Status', 'unknown')}
    except (ValueError, AttributeError):
        fail('INVALID_DOCKER_STATUS', 'Không đọc được trạng thái container.')


def inside(project, container, args, *, stdin=None, timeout=12, check=True):
    return run(['sudo', '-n', 'docker', 'exec', '-i', '-u', 'ubuntu', '-w', project,
                container, *args], stdin=stdin, timeout=timeout, check=check)


INSPECT_SOURCE = r'''
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); present=(root/'tools/robot.zsh').is_file() and (root/'tools/robot_stack.py').is_file()
out={'project':{'exists':present,'robotId':None},'stack':{'running':False,'supervisorRunning':False,'mode':None,'pids':[]}}
if present:
    sys.path.insert(0,str(root/'tools'))
    from robot_stack import processes,conflict,still_same
    table=processes()
    out['stack']['pids']=[p['pid'] for p in table.values() if conflict(p)]
    cfg_path=root/'pi/config/mqtt.worker.json'
    if cfg_path.is_file():
        cfg=json.loads(cfg_path.read_text())
        out['project']['robotId']=cfg.get('robot_id')
    record=root/'pi/state/stack/supervisor.json'
    if record.is_file():
        try:
            identity=json.loads(record.read_text())
            live=still_same(identity)
            out['stack']['supervisorRunning']=live
            if live:
                args=identity.get('argv',[])
                out['stack']['mode']=args[args.index('--mode')+1] if '--mode' in args else 'mapping'
                config=identity.get('config')
                if config:
                    runtime=json.loads(Path(config).read_text())
                    out['stack']['mode']='navigation' if runtime.get('navigation_session') else 'mapping'
        except (OSError,ValueError,KeyError,TypeError):pass
    out['stack']['running']=out['stack']['supervisorRunning'] or bool(out['stack']['pids'])
print(json.dumps(out))
'''


def inspect_project(project, container, state=None):
    if not (state or container_state(container))['running']:
        return {'project': {'exists': False, 'robotId': None},
                'stack': {'running': False, 'supervisorRunning': False, 'mode': None, 'pids': []}}
    result = inside(project, container, ['python3', '-B', '-c', INSPECT_SOURCE, project], check=False)
    if result.returncode:
        fail('PROJECT_STATUS_UNAVAILABLE', 'Không đọc được project/process trong container. Chưa xác nhận stack đã dừng.')
    try:
        return json.loads(result.stdout)
    except ValueError:
        fail('INVALID_PROJECT_STATUS', 'Không đọc được trạng thái MAR.')


def service_state():
    result = run(['systemctl', 'show', UNIT, '-p', 'ActiveState', '--value'], check=False)
    return result.stdout.strip() if result.returncode == 0 else 'inactive'


def host_status():
    addresses = []
    try:
        for interface in json.loads(run(['ip', '-j', '-4', 'addr', 'show']).stdout):
            if interface.get('ifname') in ('lo', 'docker0') or interface.get('ifname', '').startswith(('veth', 'br-')):
                continue
            for value in interface.get('addr_info', []):
                if value.get('scope') == 'global':
                    addresses.append(value['local'])
    except (ValueError, KeyError):
        pass
    ssid_result = run(['nmcli', '-g', 'GENERAL.CONNECTION', 'device', 'show', 'wlan0'], check=False)
    ntp = run(['timedatectl', 'show', '-p', 'NTPSynchronized', '-p', 'Timezone'], check=False)
    properties = dict(line.split('=', 1) for line in ntp.stdout.splitlines() if '=' in line)
    return {'hostname': socket.gethostname(), 'addresses': addresses,
            'ssid': ssid_result.stdout.strip() if ssid_result.returncode == 0 else None,
            'ntpSynchronized': properties.get('NTPSynchronized') == 'yes',
            'timezone': properties.get('Timezone')}


def status(payload):
    project, container = options(payload)
    state = container_state(container)
    report = inspect_project(project, container, state)
    return {'host': host_status(), 'docker': state, **report,
            'service': {'state': service_state(), 'unit': UNIT},
            'clock': {'epoch': time.time(), 'utc': datetime.now(timezone.utc).isoformat()}}


def require_stopped(project, container):
    current = inspect_project(project, container)
    if current['stack']['running'] or service_state() in ('active', 'activating', 'deactivating'):
        fail('STOP_STACK_FIRST', 'Dừng stack MAR và chờ STOP hoàn tất trước khi đổi chế độ hoặc Wi-Fi.')
    return current


def split_nmcli(line):
    fields, current, escape = [], [], False
    for char in line:
        if escape:
            current.append(char); escape = False
        elif char == '\\':
            escape = True
        elif char == ':':
            fields.append(''.join(current)); current = []
        else:
            current.append(char)
    if escape: current.append('\\')
    fields.append(''.join(current))
    return fields


def wifi_backend():
    try:
        source = WIFI_SOURCE.read_text(encoding='utf-8')
        tree = ast.parse(source)
        names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        names.update(node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute))
        names.update(node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str))
        for prefix in ('WIFI_', 'HW_WIFI_'):
            keys = [prefix + 'MODE', prefix + 'STA_SSID', prefix + 'STA_PASSWORD']
            if set(keys) <= names and 'wifi_conf' in source:
                # The current MentorPi service reloads /etc/wifi ahead of the
                # external fallback config. Keep its factory AP fallback intact.
                target = '/etc/wifi/wifi_conf.py' if '/etc/wifi' in source and 'internal_config_file' in source else str(WIFI_CONFIG)
                return {'keys': keys, 'path': target}
        return None
    except (OSError, SyntaxError, UnicodeError):
        return None


def wifi_supported():
    return wifi_backend() is not None


def wifi_scan(payload):
    project, container = options(payload)
    require_stopped(project, container)
    result = run(['nmcli', '-t', '-e', 'yes', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'], timeout=18)
    networks = {}
    for line in result.stdout.splitlines():
        values = split_nmcli(line)
        if len(values) != 3 or not values[0]: continue
        try: signal = max(0, min(100, int(values[1])))
        except ValueError: continue
        row = {'ssid': values[0], 'signal': signal, 'secure': values[2] not in ('', '--')}
        if values[0] not in networks or signal > networks[values[0]]['signal']:
            networks[values[0]] = row
    return {'networks': sorted(networks.values(), key=lambda row: -row['signal']),
            'backendSupported': wifi_supported()}


def wifi_configure(payload):
    project, container = options(payload)
    require_stopped(project, container)
    ssid, password = payload.get('ssid'), payload.get('password')
    if not isinstance(ssid, str) or not 1 <= len(ssid.encode('utf-8')) <= 32 or any(ord(c) < 32 for c in ssid):
        fail('INVALID_SSID', 'SSID cần 1–32 byte và không có ký tự điều khiển.')
    if not isinstance(password, str) or not (8 <= len(password) <= 63 or re.fullmatch(r'[0-9A-Fa-f]{64}', password)) or any(ord(c) < 32 for c in password):
        fail('INVALID_WIFI_PASSWORD', 'Nhập mật khẩu WPA/WPA2 8–63 ký tự hoặc khóa hex 64 ký tự.')
    if not wifi_supported():
        fail('WIFI_BACKEND_UNSUPPORTED', 'Chưa nhận diện được cấu hình Wi-Fi Hiwonder trên image này; chưa thay đổi mạng.')
    backend = wifi_backend()
    if backend is None:
        fail('WIFI_BACKEND_UNSUPPORTED', 'Cấu hình Wi-Fi đã đổi trong lúc kiểm tra; chưa ghi mạng.')
    # Root reads/preserves the private vendor file. Credentials are stdin only.
    source = r'''
import ast,json,os,shutil,sys,tempfile
from pathlib import Path
data=json.load(sys.stdin);p=Path(data['path']);keys=data['keys']
if str(p) not in ('/etc/wifi/wifi_conf.py','/home/pi/hiwonder-toolbox/wifi_conf.py') or p.is_symlink():raise ValueError('path')
p.parent.mkdir(parents=True,exist_ok=True)
old=p.read_text(encoding='utf-8-sig') if p.exists() else ''
tree=ast.parse(old or '\n');lines=old.splitlines(keepends=True);remove=set()
for node in tree.body:
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in keys for t in node.targets):
  if len(node.targets)!=1:raise ValueError('shared assignment')
  remove.update(range(node.lineno-1,node.end_lineno))
text=''.join(line for i,line in enumerate(lines) if i not in remove)
text+='\n'+keys[0]+' = 2\n'+keys[1]+' = '+repr(data['ssid'])+'\n'+keys[2]+' = '+repr(data['password'])+'\n'
ast.parse(text)
if p.exists():
 b=p.with_name('wifi_conf.mar-backup.py');shutil.copy2(p,b);b.chmod(0o600)
fd,name=tempfile.mkstemp(prefix='.wifi_conf.mar-',dir=p.parent)
try:
 with os.fdopen(fd,'w',encoding='utf-8') as out:out.write(text);out.flush();os.fsync(out.fileno())
 os.chmod(name,0o600);os.replace(name,p)
finally:
 if os.path.exists(name):os.unlink(name)
'''
    run(['sudo', '-n', 'python3', '-B', '-c', source], stdin=json.dumps({**backend, 'ssid': ssid, 'password': password}))
    # Delayed timer returns its acknowledgement before Wi-Fi drops this SSH connection.
    unit = 'mar-desktop-wifi-' + uuid.uuid4().hex[:10]
    run(['sudo', '-n', 'systemd-run', '--quiet', '--collect', '--unit=' + unit,
         '--on-active=4s', '/usr/bin/systemctl', 'restart', 'wifi.service'])
    return {'accepted': True, 'state': 'SWITCHING_NETWORK', 'ssid': ssid, 'reconnectAfterSeconds': 12,
            'message': 'Pi đang chuyển sang Wi-Fi đã chọn. Nối laptop về cùng mạng rồi tìm lại robot.'}


def start(payload):
    project, container = options(payload)
    mode = payload.get('mode')
    if mode not in ('mapping', 'navigation'):
        fail('INVALID_MODE', 'Chọn mapping hoặc navigation.')
    require_stopped(project, container)
    if not host_status()['ntpSynchronized']:
        fail('CLOCK_NOT_SYNCHRONIZED', 'Pi chưa đồng bộ giờ NTP. Chờ Internet và đồng bộ giờ trước khi mở phiên.')
    state = container_state(container)
    if not state['running']:
        run(['sudo', '-n', 'docker', 'start', container], timeout=20)
    report = inspect_project(project, container)
    if not report['project']['exists']:
        fail('PROJECT_NOT_FOUND', 'Không tìm thấy source MAR trong container tại đường dẫn đã chọn.')
    if not report['project'].get('robotId'):
        fail('ROBOT_NOT_CONFIGURED', 'Worker chưa có robot_id. Chưa khởi chạy stack.')
    if report['stack']['running']:
        fail('STOP_STACK_FIRST', 'Một stack đã được mở trong lúc kiểm tra; chưa khởi chạy bản thứ hai.')
    args = ['sudo', '-n', 'systemd-run', '--quiet', '--collect', '--unit=' + UNIT,
            '--description=MAR desktop manual stack', '--property=Type=exec', '--property=Restart=no',
            '--property=KillMode=process', '--property=TimeoutStopSec=120s',
            '/usr/bin/docker', 'exec', '-u', 'ubuntu', '-w', project, container]
    if mode == 'mapping':
        args += ['zsh', 'tools/robot.zsh', 'run', '--mode', 'mapping']
    else:
        session_id = payload.get('sessionId')
        try:
            if not isinstance(session_id, str) or str(uuid.UUID(session_id)) != session_id: raise ValueError()
        except ValueError:
            fail('INVALID_SESSION_ID', 'Phiên navigation cần UUID hợp lệ do BE cấp.')
        load_profile = payload.get('loadProfile', 'cargo')
        if load_profile not in ('bare', 'cargo'):
            fail('INVALID_LOAD_PROFILE', 'Chọn bare hoặc cargo.')
        args += ['pi/.venv/bin/python', '-u', 'tools/run_navigation_session.py',
                 '--session-id', session_id, '--load-profile', load_profile]
        for key, flag in [('voiceChat', 'voice-chat'), ('fallMonitor', 'fall-monitor'), ('restrictedMonitor', 'restricted-monitor')]:
            if key in payload and payload[key] is not None:
                if type(payload[key]) is not bool: fail('INVALID_OPTION', 'Cờ chế độ phải là true hoặc false.')
                args.append('--' + ('' if payload[key] else 'no-') + flag)
    run(args, timeout=15)
    return {'accepted': True, 'state': 'STARTING', 'unit': UNIT, 'mode': mode,
            'message': 'Đã nhận yêu cầu mở stack; theo dõi trạng thái và log để xác nhận READY.'}


def stop(payload):
    project, container = options(payload)
    deadline = time.monotonic() + 90
    requested = False
    while time.monotonic() < deadline:
        state = container_state(container)
        report = inspect_project(project, container, state)
        service = service_state()
        if not report['stack']['running'] and service not in ('active', 'activating', 'deactivating'):
            return {'accepted': True, 'state': 'STOPPED', 'unit': UNIT,
                    'message': 'Không còn stack hoặc phiên app đang chạy. Trạng thái Job BE cần kiểm tra riêng.'}
        if report['stack']['supervisorRunning'] and not requested:
            inside(project, container, ['zsh', 'tools/robot.zsh', 'stop'], timeout=15)
            requested = True
        elif report['stack']['running'] and not report['stack']['supervisorRunning'] and service not in ('active', 'activating', 'deactivating'):
            fail('ORPHAN_COMPONENTS', 'Có component MAR nhưng không có supervisor hợp lệ. Không tự kill PID; kiểm tra log và recovery.')
        # A navigation service may still be downloading its map. Wait for the
        # supervisor and request its STOP; killing docker exec would orphan it.
        time.sleep(.5)
    return {'accepted': True, 'state': 'STOPPING', 'unit': UNIT,
            'message': 'Đã yêu cầu STOP; đang chờ worker và ROS đóng đúng thứ tự.'}


def logs(payload):
    project, container = options(payload)
    name = payload.get('name', 'worker')
    lines = payload.get('lines', 80)
    if name not in ('worker', 'voice', 'gate', 'navigation', 'service') or type(lines) is not int or not 1 <= lines <= 300:
        fail('INVALID_LOG_REQUEST', 'Chọn log hợp lệ và số dòng từ 1 đến 300.')
    if name == 'service':
        result = run(['sudo', '-n', 'journalctl', '-u', UNIT, '--no-pager', '-n', str(lines), '-o', 'short-iso'], check=False)
        return {'name': name, 'text': result.stdout[-60000:]}
    source = """import sys\nfrom pathlib import Path\nfrom collections import deque\np=Path('pi/state/stack')/(sys.argv[1]+'.log')\nif p.is_file():\n with p.open(errors='replace') as f:print(''.join(deque(f,maxlen=int(sys.argv[2])))[-60000:])\nelse:print('Chưa có log cho phiên này.')\n"""
    result = inside(project, container, ['python3', '-B', '-c', source, name, str(lines)], check=False)
    return {'name': name, 'text': result.stdout[-60000:] if result.returncode == 0 else 'Container hoặc log hiện chưa sẵn sàng.'}


ACTIONS = {'status': status, 'wifi-scan': wifi_scan, 'wifi-configure': wifi_configure,
           'start': start, 'stop': stop, 'logs': logs}


def main(argv=None, stream=None):
    try:
        args = sys.argv[1:] if argv is None else argv
        if len(args) != 1 or args[0] not in ACTIONS: fail('UNKNOWN_ACTION', 'Thao tác không được hỗ trợ.')
        raw = (stream or sys.stdin).read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT: fail('INPUT_TOO_LARGE', 'Yêu cầu quá lớn.')
        payload = json.loads(raw or '{}')
        if not isinstance(payload, dict): fail('INVALID_INPUT', 'Yêu cầu phải là JSON object.')
        if args[0] in ('start', 'stop', 'wifi-configure'):
            with mutation_lock():
                data = ACTIONS[args[0]](payload)
        else:
            data = ACTIONS[args[0]](payload)
        result = {'ok': True, 'data': data}
    except ControlError as error:
        result = {'ok': False, 'error': {'code': error.code, 'message': error.message}}
    except (ValueError, TypeError, SyntaxError, UnicodeError):
        result = {'ok': False, 'error': {'code': 'INVALID_INPUT', 'message': 'Dữ liệu yêu cầu hoặc cấu hình không hợp lệ.'}}
    except Exception:
        result = {'ok': False, 'error': {'code': 'REMOTE_UNAVAILABLE', 'message': 'Không hoàn tất được thao tác trên Pi; chưa xác nhận kết quả.'}}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
