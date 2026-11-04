#!/usr/bin/env python3
"""Offline CLI fixtures only: never invokes real curl/kubectl/docker/wg."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('diagnose-launcher-timeout.sh')
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
cmd = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
stdin = sys.stdin.read() if cmd == 'kubectl' and 'exec' in args else ''
with open(os.environ['MX_DIAG_TEST_CALLS'], 'a') as f:
    f.write(json.dumps({'cmd':cmd, 'args':args, 'stdin':stdin}) + '\n')
if os.environ.get('MX_DIAG_TEST_FAIL') == cmd:
    print('SECRET_DO_NOT_PRINT', file=sys.stderr)
    sys.exit(7)
if os.environ.get('MX_DIAG_TEST_TIMEOUT') == cmd:
    time.sleep(6)
if cmd == 'kubectl':
    if 'exec' in args:
        print(json.dumps({'state':'active','wait_event_type':'IO','wait_event':'WALSync','count':2}))
    elif 'logs' in args:
        print('SECRET_DO_NOT_PRINT runExpiredHandoverReconciliation ECONNRESET')
    elif 'pods' in args:
        print(json.dumps({'items':[
          {'metadata':{'name':'mx-launcher-internal-test'},
           'spec':{'env':{'token':'SECRET_DO_NOT_PRINT'}},
           'status':{'phase':'Running','podIP':'192.168.224.25','conditions':[{'type':'Ready','status':'True'}],
                     'containerStatuses':[{'name':'internal-api','image':'test:current','ready':True,
                       'restartCount':int(os.environ.get('MX_DIAG_TEST_RESTARTS','1'))}]}},
          {'metadata':{'name':'unrelated-SECRET_DO_NOT_PRINT'}}]}))
    elif 'service' in args:
        print(json.dumps({'spec':{'clusterIP':'192.168.241.51','ports':[{'port':18090}]}}))
    else:
        print(json.dumps({'items':[{'metadata':{'name':'api-test'},'ports':[{'port':18090}],
          'endpoints':[{'addresses':['192.168.224.25'],'conditions':{'ready':True}}]}]}))
elif cmd == 'curl':
    if os.environ.get('MX_DIAG_TEST_CURL_TIMEOUT'):
        print('{"http_code":"000","connect_s":0.001,"ttfb_s":0,"total_s":8.001}')
        sys.exit(28)
    print('{"http_code":"200","connect_s":0.001,"ttfb_s":0.002,"total_s":0.003}')
elif cmd == 'docker' and args[0] == 'logs':
    print('client: SECRET_DO_NOT_PRINT, server: launcher.minsight-ai.com, upstream timed out while connecting to upstream, upstream: "http://10.88.88.88:80/admin/?token=SECRET_DO_NOT_PRINT", request: GET /admin/?token=SECRET_DO_NOT_PRINT', file=sys.stderr)
elif cmd == 'wg':
    if args[-1] == 'allowed-ips':
        print('wg0 PUBLIC_KEY_DO_NOT_PRINT 10.88.88.88/32')
        print('wg0 OTHER_PUBLIC_KEY_DO_NOT_PRINT 10.88.10.8/32')
    elif args[-1] == 'latest-handshakes':
        print('wg0 PUBLIC_KEY_DO_NOT_PRINT', int(time.time())-5)
        print('wg0 OTHER_PUBLIC_KEY_DO_NOT_PRINT 0')
    else:
        print('wg0 PUBLIC_KEY_DO_NOT_PRINT 42 84')
        print('wg0 OTHER_PUBLIC_KEY_DO_NOT_PRINT 999 999')
elif cmd == 'journalctl':
    print('2026-10-27 kernel nvme nvme0: I/O SECRET_DO_NOT_PRINT timeout, aborting')
elif cmd == 'hostname':
    print('fixture-internal')
elif cmd == 'ip':
    print('[{"type":"local","dst":"10.88.88.88","dev":"lo","prefsrc":"10.88.88.88"}]')
elif cmd in ('df','iostat','vmstat'):
    print('safe fixture statistics')
'''


class DiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        dispatcher = self.root / 'fake.py'
        dispatcher.write_text(FAKE)
        dispatcher.chmod(0o755)
        for command in ('curl', 'kubectl', 'docker', 'wg', 'df', 'iostat', 'vmstat', 'journalctl', 'hostname', 'ip'):
            (self.root / command).symlink_to(dispatcher)
        self.calls = self.root / 'calls.jsonl'
        self.env = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ['PATH'],
                        MX_DIAG_TEST_CALLS=str(self.calls))

    def invoke(self, mode):
        result = subprocess.run(['bash', str(SCRIPT), mode], env=self.env,
                                capture_output=True, text=True, timeout=15)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        self.assertNotIn('DO_NOT_PRINT', result.stdout + result.stderr)
        return result, calls

    def test_internal_read_only_and_layer_probes(self):
        result, calls = self.invoke('internal')
        self.assertEqual(result.returncode, 0, result.stderr)
        records = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(records[-1]['failed_checks'], 0)
        self.assertTrue(any(r['check'] == 'pg-waits' and r['groups'][0]['wait_event'] == 'WALSync' for r in records))
        previous = next(r for r in records if r['check'] == 'api-previous-log')
        self.assertEqual(previous['counts']['expired_handover'], 1)
        self.assertEqual(previous['counts']['connection'], 1)
        for call in calls:
            if call['cmd'] == 'kubectl':
                self.assertIn('--kubeconfig=/etc/kubernetes/admin.conf', call['args'])
                self.assertTrue(set(call['args']) & {'get', 'exec', 'logs'})
                self.assertFalse(set(call['args']) & {'patch','apply','delete','create','rollout','set'})
                if 'exec' in call['args']:
                    self.assertIn('BEGIN READ ONLY;', call['stdin'])
                    self.assertIn("statement_timeout = '3s'", call['stdin'])
                    self.assertIn('default_transaction_read_only=on', call['args'][-1])
                    self.assertNotIn('query,', call['stdin'])
        curl_calls = [call for call in calls if call['cmd'] == 'curl']
        self.assertTrue(any('http://192.168.224.25:18090/admin/' in c['args'] for c in curl_calls))
        self.assertTrue(any('Host: auth.minsight-ai.com' in c['args'] for c in curl_calls))
        self.assertTrue(all('--max-time' in c['args'] and '--noproxy' in c['args'] for c in curl_calls))

    def test_domestic_redaction_and_wg_scope(self):
        result, calls = self.invoke('domestic')
        self.assertEqual(result.returncode, 0, result.stderr)
        records = [json.loads(line) for line in result.stdout.splitlines()]
        wg = next(r for r in records if r['check'] == 'wg-internal')
        self.assertEqual((wg['matching_peers'], wg['rx_bytes_total'], wg['tx_bytes_total']), (1,42,84))
        nginx = next(r for r in records if r['check'] == 'nginx-errors')
        self.assertEqual(nginx['counts'][0]['stage'], 'while connecting to upstream')
        self.assertEqual(nginx['counts'][0]['upstream_origin'], 'http://10.88.88.88:80')
        self.assertFalse(any(c['cmd'] == 'kubectl' for c in calls))
        self.assertTrue(all(c['args'][0] in ('exec','logs') for c in calls if c['cmd'] == 'docker'))

    def test_failures_continue_without_printing_stderr(self):
        self.env['MX_DIAG_TEST_FAIL'] = 'kubectl'
        result, calls = self.invoke('internal')
        self.assertEqual(result.returncode, 0)
        self.assertIn('command-exit-7', result.stdout)
        self.assertTrue(any(c['cmd'] == 'journalctl' for c in calls))
        self.assertGreater(json.loads(result.stdout.splitlines()[-1])['failed_checks'], 0)

    def test_bad_mode_never_invokes_commands(self):
        result, calls = self.invoke('wrong')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, [])

    def test_curl_failure_keeps_timings(self):
        self.env['MX_DIAG_TEST_CURL_TIMEOUT'] = '1'
        result, _ = self.invoke('domestic')
        records = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(any(r.get('http_code') == '000' and r.get('command_exit') == 28 and r.get('total_s') == 8.001 for r in records))
        self.assertGreater(records[-1]['failed_checks'], 0)

    def test_command_timeout_continues(self):
        self.env['MX_DIAG_TEST_TIMEOUT'] = 'hostname'
        result, calls = self.invoke('domestic')
        self.assertIn('command-timeout', result.stdout)
        self.assertTrue(any(c['cmd'] == 'wg' for c in calls))

    def test_no_restarts_skips_previous_logs(self):
        self.env['MX_DIAG_TEST_RESTARTS'] = '0'
        result, calls = self.invoke('internal')
        self.assertIn('skipped-no-restarts', result.stdout)
        self.assertFalse(any(c['cmd'] == 'kubectl' and 'logs' in c['args'] for c in calls))
        self.assertEqual(json.loads(result.stdout.splitlines()[-1])['failed_checks'], 0)


if __name__ == '__main__':
    unittest.main()
