"""Isolated helper boundaries; never opens SSH, Docker, Wi-Fi, or motors."""
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mar_control', Path(__file__).parents[1] / 'remote/control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class RemoteTests(unittest.TestCase):
    def test_paths_and_names_cannot_escape_into_shell_or_other_directories(self):
        for payload in [{'projectPath': '/etc'}, {'projectPath': '/home/ubuntu/x/../private'},
                        {'projectPath': '/home/ubuntu/x\nreboot'}, {'container': 'MentorPi; reboot'}]:
            with self.subTest(payload=payload), self.assertRaises(control.ControlError): control.options(payload)
        self.assertEqual(control.options({})[1], 'MentorPi')

    def test_nmcli_escaped_ssid_is_not_split_at_colon(self):
        self.assertEqual(control.split_nmcli(r'Lab\: room:80:WPA2'), ['Lab: room', '80', 'WPA2'])

    def test_unknown_wifi_backend_never_writes_or_restarts_network(self):
        with patch.object(control, 'require_stopped'), patch.object(control, 'wifi_supported', return_value=False), patch.object(control, 'run') as run:
            with self.assertRaises(control.ControlError) as error:
                control.wifi_configure({'ssid': 'Lab', 'password': 'validpassword'})
            self.assertEqual(error.exception.code, 'WIFI_BACKEND_UNSUPPORTED'); run.assert_not_called()

    def test_navigation_start_uses_argument_array_and_does_not_enable_boot_service(self):
        report = {'project': {'exists': True, 'robotId': 'robot'}, 'stack': {'running': False}}
        with patch.object(control, 'require_stopped'), patch.object(control, 'container_state', return_value={'running': True}), \
                patch.object(control, 'host_status', return_value={'ntpSynchronized': True}), patch.object(control, 'inspect_project', return_value=report), \
                patch.object(control, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as run:
            result = control.start({'mode': 'navigation', 'sessionId': '0e3f1083-2546-4f45-8004-5eda5cb75a6f',
                                    'voiceChat': True, 'fallMonitor': False})
            args = run.call_args.args[0]
            self.assertEqual(result['state'], 'STARTING')
            self.assertIn('systemd-run', args); self.assertIn('--collect', args)
            self.assertNotIn('enable', args); self.assertNotIn('sh', args)
            self.assertIn('--voice-chat', args); self.assertIn('--no-fall-monitor', args)

    def test_clock_and_stopped_stack_are_admission_checks(self):
        with patch.object(control, 'require_stopped'), patch.object(control, 'host_status', return_value={'ntpSynchronized': False}), patch.object(control, 'run') as run:
            with self.assertRaises(control.ControlError) as error: control.start({'mode': 'mapping'})
            self.assertEqual(error.exception.code, 'CLOCK_NOT_SYNCHRONIZED'); run.assert_not_called()

    def test_orphan_component_stop_never_kills_by_unverified_pid(self):
        with patch.object(control, 'container_state', return_value={'running': True}), \
                patch.object(control, 'inspect_project', return_value={'stack': {'running': True, 'supervisorRunning': False}}), \
                patch.object(control, 'service_state', return_value='inactive'), \
                patch.object(control, 'inside') as inside:
            with self.assertRaises(control.ControlError) as error: control.stop({})
            self.assertEqual(error.exception.code, 'ORPHAN_COMPONENTS'); inside.assert_not_called()

    def test_actual_mentorpi_wifi_keys_use_internal_override_not_ap_fallback(self):
        source = "WIFI_MODE=1\nWIFI_STA_SSID=''\nWIFI_STA_PASSWORD=''\ninternal_config_file='/etc/wifi/wifi_conf.py'\n"
        with patch.object(control.Path, 'read_text', return_value=source):
            self.assertEqual(control.wifi_backend(), {'keys': ['WIFI_MODE', 'WIFI_STA_SSID', 'WIFI_STA_PASSWORD'], 'path': '/etc/wifi/wifi_conf.py'})

    def test_stop_waits_for_preparing_service_then_stops_its_supervisor(self):
        reports = [
            {'stack': {'running': False, 'supervisorRunning': False}},
            {'stack': {'running': True, 'supervisorRunning': True}},
            {'stack': {'running': False, 'supervisorRunning': False}},
        ]
        with patch.object(control, 'container_state', return_value={'running': True}), \
                patch.object(control, 'inspect_project', side_effect=reports), \
                patch.object(control, 'service_state', side_effect=['active', 'active', 'inactive']), \
                patch.object(control.time, 'sleep'), patch.object(control, 'inside') as inside:
            self.assertEqual(control.stop({})['state'], 'STOPPED')
            inside.assert_called_once()

    def test_action_dispatch_rejects_unbounded_or_unknown_input(self):
        with patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(control.main(['shell'], io.StringIO('{}')), 1)
            self.assertIn('UNKNOWN_ACTION', output.getvalue())
        with patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(control.main(['status'], io.StringIO('a' * (control.MAX_INPUT + 1))), 1)
            self.assertIn('INPUT_TOO_LARGE', output.getvalue())


if __name__ == '__main__': unittest.main()
