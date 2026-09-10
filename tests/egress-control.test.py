import copy
import importlib.machinery
import json
from pathlib import Path
import tempfile
import types
import subprocess
import sys
import unittest
from unittest.mock import patch, MagicMock

loader = importlib.machinery.SourceFileLoader('control', 'deploy/vpnbot-egress-control')
c = types.ModuleType(loader.name)
loader.exec_module(c)

def fixture():
    return {'revision': 4, 'entryHost': '9.9.9.9', 'default': 'e1', 'proxy': 'e1',
            'nodes': [{'id': 'e1', 'host': '1.1.1.1', 'status': 'ready', 'table': 23001, 'telegram': True},
                      {'id': 'e2', 'host': '8.8.8.8', 'status': 'ready', 'table': 23002, 'telegram': True}],
            'assignments': {'alice': 'e1', 'bob': 'e2', 'expired': 'e1'}}

class ControlTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.paths = patch.multiple(c, ROOT=self.root, STATE=self.root/'state.json', RUN=self.root/'run')
        self.paths.start(); c.save(fixture())

    def tearDown(self):
        self.paths.stop(); self.temp.cleanup()

    def test_bulk_move_does_not_need_source_server_and_preserves_other_assignments(self):
        s = c.load(); s['nodes'][0]['status'] = 'error'; c.save(s)
        with patch.object(c, 'check') as probe, patch.object(c, 'apply'), patch.object(c, 'set_proxy'):
            result = c.mutate({'action':'move','source':'e1','target':'e2','revision':4,
                               'clients':['alice','bob','charlie'],'telegram':True})
            self.assertEqual(result['moved'], 2)
            self.assertEqual(probe.call_args.args[0]['id'], 'e2')
        s = c.load()
        self.assertEqual(s['default'], 'e2'); self.assertEqual(s['proxy'], 'e2')
        self.assertEqual(s['assignments'], {'alice':'e2','bob':'e2','charlie':'e2','expired':'e2'})

    def test_failed_check_never_changes_routes_or_state(self):
        before = c.STATE.read_bytes()
        with patch.object(c, 'check', side_effect=c.ControlError('offline')), patch.object(c, 'apply') as apply:
            with self.assertRaises(c.ControlError): c.mutate({'action':'assign','client':'alice','target':'e2','revision':4})
            apply.assert_not_called()
        self.assertEqual(before, c.STATE.read_bytes())

    def test_apply_failure_rolls_back_before_reporting_error(self):
        before = c.STATE.read_bytes()
        with patch.object(c, 'check'), patch.object(c, 'apply', side_effect=[RuntimeError(), None]) as apply, patch.object(c, 'set_proxy'):
            with self.assertRaises(c.ControlError): c.mutate({'action':'assign','client':'alice','target':'e2','revision':4})
            self.assertEqual(apply.call_args_list[-1].args[0]['assignments']['alice'], 'e1')
        self.assertEqual(before, c.STATE.read_bytes())

    def test_individual_switch_and_repeated_callback(self):
        with patch.object(c, 'check'), patch.object(c, 'apply'), patch.object(c, 'set_proxy'):
            request = {'action':'assign','client':'alice','target':'e2','revision':4}
            c.mutate(request)
            with self.assertRaises(c.ControlError): c.mutate(request)
        s = c.load()
        self.assertEqual(s['default'], 'e1'); self.assertEqual(s['proxy'], 'e1')
        self.assertEqual(s['assignments']['alice'], 'e2')

    def test_current_connection_and_reconnect_keep_certificate_assignment(self):
        sample = 'HEADER\tCLIENT_LIST\tCommon Name\tReal Address\tVirtual Address\tBytes Received\nCLIENT_LIST\talice\t8.8.8.8:123\t10.9.0.9\t100\n'
        entries = c.routing_entries(fixture(), c.read_sessions(sample))
        self.assertEqual(entries, {'10.9.0.9':23001})
        entries = c.routing_entries(fixture(), {'alice':'10.9.0.12','bob':'10.9.0.7'})
        self.assertEqual(entries, {'10.9.0.12':23001,'10.9.0.7':23002})

    def test_password_not_written_to_registry(self):
        request = {'name':'Reserve','host':'4.2.2.2','port':22,'username':'root','password':'one-time-secret','telegram':True}
        with patch.object(c.os, 'fork', return_value=1234): c.add(request)
        self.assertNotIn('one-time-secret', c.STATE.read_text())
        self.assertNotIn('password', c.STATE.read_text())

    def test_bootstrap_rejects_entry_private_addresses_and_shell_injection(self):
        request = {'name':'Reserve','host':'4.2.2.2','port':22,'username':'root','password':'secret','telegram':True}
        for field, value in [('host','9.9.9.9'),('host','127.0.0.1'),('host','10.0.0.1'),('host','8.8.8.8;reboot'),('username','root;id'),('port',0)]:
            with self.subTest(field=field,value=value), self.assertRaises(c.ControlError):
                c.validate_new(dict(request, **{field:value}), fixture())

    def test_bootstrap_renders_valid_shell_and_publishes_ready_only_after_probe(self):
        for telegram in (False, True):
            with self.subTest(telegram=telegram):
                s = fixture()
                s['nodes'].append(dict(id='e3', host='4.2.2.2', status='provisioning', telegram=telegram,
                                       interface='wge3', peer='10.214.3.2', local='10.214.3.1', port=53003, table=23003))
                c.save(s)
                fake = MagicMock()
                fake.SSHClient.return_value.get_transport.return_value.get_remote_server_key.return_value.asbytes.return_value = b'host-key'
                scripts = []
                def remote(client, script, username, password):
                    subprocess.run(['bash', '-n'], input=script, text=True, check=True)
                    scripts.append(script)
                    return 'VPNBOT_PUBLIC=' + 'A' * 43 + '=\n'
                def probe(*args):
                    self.assertEqual(c.node(c.load(), 'e3')['status'], 'provisioning')
                real_atomic = c.atomic
                def atomic(path, data, mode=0o600):
                    target = Path(path)
                    if str(target).startswith('/etc/wireguard/'):
                        target = self.root / target.name
                    return real_atomic(target, data, mode)
                request = dict(port=22, username='root', password='one-time-secret')
                with patch.dict(sys.modules, {'paramiko':fake}), patch.object(c, 'remote', side_effect=remote), \
                     patch.object(c, 'command', return_value='A'*43+'='), patch.object(c, 'atomic', side_effect=atomic), \
                     patch.object(c, 'apply'), patch.object(c, 'check', side_effect=probe):
                    c.provision('e3', request)
                self.assertEqual(c.node(c.load(), 'e3')['status'], 'ready')
                self.assertEqual('dante-server' in scripts[0], telegram)
                self.assertNotIn('one-time-secret', scripts[0])
                self.assertEqual(request['password'], '')

    def test_sudo_password_is_stdin_only(self):
        client = MagicMock()
        stdin, stdout, stderr = MagicMock(), MagicMock(), MagicMock()
        client.exec_command.return_value = (stdin, stdout, stderr)
        stdout.read.return_value = b'complete'
        stdout.channel.recv_exit_status.return_value = 0
        self.assertEqual(c.remote(client, 'printf complete', 'admin', 'special-secret'), 'complete')
        self.assertNotIn('special-secret', client.exec_command.call_args.args[0])
        stdin.write.assert_called_once_with('special-secret\n')

    def test_ssh_errors_explain_authentication_and_timeout_without_secrets(self):
        class AuthenticationError(Exception): pass
        for error, expected in [(AuthenticationError('secret'), 'логин или пароль'), (TimeoutError('secret'), 'не ответил вовремя')]:
            with self.subTest(error=type(error).__name__):
                fake = MagicMock()
                fake.AuthenticationException = AuthenticationError
                fake.ssh_exception.NoValidConnectionsError = ConnectionError
                fake.SSHClient.return_value.connect.side_effect = error
                request = dict(port=22, username='root', password='secret')
                with patch.dict(sys.modules, {'paramiko':fake}): c.provision('e2', request)
                state = c.load()
                self.assertIn(expected, c.node(state,'e2')['error'])
                self.assertNotIn('secret', c.STATE.read_text())
                self.assertEqual(request['password'], '')

if __name__ == '__main__': unittest.main()
