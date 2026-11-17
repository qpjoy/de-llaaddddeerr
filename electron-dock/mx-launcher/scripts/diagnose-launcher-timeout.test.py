#!/usr/bin/env python3
"""Offline CLI fixtures only: never invokes real curl/kubectl/docker/wg."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

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
elif cmd == 'tail':
    pass
'''


class DiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        dispatcher = self.root / 'fake.py'
        dispatcher.write_text(FAKE)
        dispatcher.chmod(0o755)
        for command in ('curl', 'kubectl', 'docker', 'wg', 'df', 'iostat', 'vmstat', 'journalctl', 'hostname', 'ip', 'tail'):
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


class EmbeddedDiagnosticsTest(unittest.TestCase):
    """Exercise the embedded Python without invoking Bash or host commands."""
    def setUp(self):
        source = SCRIPT.read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
        source = source.split("\nemit('start',", 1)[0]
        self.scope = {}
        with mock.patch('sys.argv', ['diagnostic', 'internal']):
            exec(compile(source, str(SCRIPT), 'exec'), self.scope)
        self.records = []
        self.scope['emit'] = lambda check, **values: self.records.append(dict(check=check, **values))

    def nginx_line(self, age, server='launcher.minsight-ai.com', error=None, upstream=None):
        dt = self.scope['datetime']
        stamp = (dt.datetime.now() - dt.timedelta(seconds=age)).strftime('%Y/%m/%d %H:%M:%S')
        error = error or 'connect() failed (111: Connection refused) while connecting to upstream'
        upstream = upstream or 'http://10.88.88.88:18444/admin/?token=SECRET_DO_NOT_PRINT'
        return ('{} [error] 1#1: *1 {}, client: CLIENT_DO_NOT_PRINT, server: {}, '
                'request: "GET /admin/?cookie=SECRET_DO_NOT_PRINT HTTP/1.1", '
                'upstream: "{}", host: "launcher.minsight-ai.com", '
                'X-MX-Identity-Gateway: SECRET_DO_NOT_PRINT').format(stamp, error, server, upstream)

    def test_python36_subprocess_options_preserve_results_and_redaction(self):
        responses = iter([
            subprocess.CompletedProcess([], 0, 'safe output', 'SECRET_DO_NOT_PRINT'),
            subprocess.CompletedProcess([], 7, 'SECRET_DO_NOT_PRINT', 'SECRET_DO_NOT_PRINT'),
            subprocess.CompletedProcess([], 0, json.dumps({'http_code': '200', 'total_s': 0.01,
                'unexpected': 'SECRET_DO_NOT_PRINT'}), 'SECRET_DO_NOT_PRINT'),
            subprocess.CompletedProcess([], 28, json.dumps({'http_code': '000', 'total_s': 8.001,
                'unexpected': 'SECRET_DO_NOT_PRINT'}), 'SECRET_DO_NOT_PRINT'),
        ])
        calls = []
        # Reject the capture_output/text keywords unavailable on Python 3.6.
        def python36_run(args, *, input=None, stdout=None, stderr=None,
                         universal_newlines=False, timeout=None):
            self.assertEqual((stdout, stderr), (subprocess.PIPE, subprocess.PIPE))
            self.assertTrue(universal_newlines)
            calls.append((input, timeout))
            return next(responses)

        with mock.patch.object(self.scope['subprocess'], 'run', side_effect=python36_run):
            self.assertEqual(self.scope['run']('regular', ['fixture'], timeout=3, stdin='read only'), 'safe output')
            self.assertIsNone(self.scope['run']('failed', ['fixture']))
            self.scope['http']('healthy', 'http://127.0.0.1/healthz')
            self.scope['http']('timeout', 'http://127.0.0.1/healthz')
        self.assertEqual(calls, [('read only', 3), (None, 12), (None, 12), (None, 12)])
        self.assertEqual(self.scope['failures'], 2)
        self.assertEqual(self.records[0]['status'], 'command-exit-7')
        self.assertEqual(self.records[1]['http_code'], '200')
        self.assertEqual(self.records[2]['status'], 'curl-exit-28')
        self.assertEqual(self.records[3]['http_code'], '000')
        self.assertEqual(self.records[3]['total_s'], 8.001)
        self.assertNotIn('DO_NOT_PRINT', json.dumps(self.records))

    def test_nginx_summary_is_bounded_timed_and_redacted(self):
        logs = '\n'.join([
            self.nginx_line(60), self.nginx_line(30), self.nginx_line(16 * 60),
            self.nginx_line(20, server='unrelated.example'),
            self.nginx_line(10, error='unclassified failure',
                            upstream='http://10.88.88.88:18444/?error=connect() failed'),
        ])
        run = mock.Mock(return_value=logs)
        self.scope['run'] = run
        self.scope['internal_nginx_errors']()
        run.assert_called_once_with('internal-nginx-errors',
                                    ['tail', '-c', '1048576', '--', '/var/log/nginx/error.log'])
        record = self.records[-1]
        self.assertEqual(len(record['counts']), 1)
        group = record['counts'][0]
        self.assertEqual(group['count'], 2)
        self.assertEqual(group['server'], 'launcher.minsight-ai.com')
        self.assertEqual(group['kind'], 'connect() failed')
        self.assertEqual(group['errno'], 111)
        self.assertEqual(group['stage'], 'while connecting to upstream')
        self.assertEqual(group['upstream_origin'], 'http://10.88.88.88:18444')
        self.assertLess(group['first'], group['last'])
        self.assertNotIn('DO_NOT_PRINT', json.dumps(self.records))
        self.assertNotIn('/admin/', json.dumps(self.records))

        self.records.clear()
        run.return_value = self.nginx_line(1) + '\n' + '\n'.join(['irrelevant'] * 3000)
        self.scope['internal_nginx_errors']()
        self.assertEqual(self.records[-1]['counts'], [])

        self.records.clear()
        run.return_value = '\n'.join(self.nginx_line(1, server='auth.minsight-ai.com',
            error='connect() failed ({}: SECRET_DO_NOT_PRINT) while connecting to upstream'.format(errno))
            for errno in (111, 113, 13))
        self.scope['internal_nginx_errors']()
        self.assertEqual([group['errno'] for group in self.records[-1]['counts']], [111, 113, 13])
        self.assertTrue(all(group['server'] == 'auth.minsight-ai.com' for group in self.records[-1]['counts']))
        self.assertNotIn('DO_NOT_PRINT', json.dumps(self.records))

    def test_nginx_unavailable_is_reported_without_raw_output(self):
        failure = mock.Mock(returncode=1, stdout='SECRET_DO_NOT_PRINT', stderr='SECRET_DO_NOT_PRINT')
        with mock.patch.object(self.scope['subprocess'], 'run', return_value=failure) as execute:
            self.scope['internal_nginx_errors']()
        self.assertEqual(execute.call_args.kwargs['timeout'], 12)
        self.assertEqual(self.scope['failures'], 1)
        self.assertEqual(self.records[0]['status'], 'command-exit-1')
        self.assertEqual(self.records[-1]['source'], '/var/log/nginx/error.log')
        self.assertNotIn('counts', self.records[-1])
        self.assertNotIn('DO_NOT_PRINT', json.dumps(self.records))

    def test_public_identity_probe_and_container_failure_state(self):
        container = {'name': 'identity', 'image': 'test:identity', 'ready': False, 'restartCount': 2,
                     'state': {'waiting': {'reason': 'CrashLoopBackOff', 'message': 'SECRET_DO_NOT_PRINT'}},
                     'lastState': {'terminated': {'reason': 'OOMKilled', 'exitCode': 137,
                                                 'finishedAt': '2026-11-17T00:01:00Z',
                                                 'message': 'SECRET_DO_NOT_PRINT'}}}
        def pod(name, address, phase='Running', state=None):
            return {'metadata': {'name': name}, 'status': {'phase': phase, 'podIP': address,
                    'containerStatuses': [state or container]}}
        pods = [pod('mx-identity-public-a', '192.168.224.31'),
                pod('mx-identity-public-b', '192.168.224.32', state={**container,
                    'state': {'terminated': {'reason': 'Error', 'exitCode': 1,
                                            'message': 'SECRET_DO_NOT_PRINT'}}}),
                pod('mx-identity-public-c', '192.168.224.33'),
                pod('mx-identity-private', '192.168.224.34'),
                pod('mx-identity-public-pending', '192.168.224.35', phase='Pending'),
                pod('mx-identity-public-invalid', 'invalid.example'),
                pod('unrelated', '192.168.224.36')]
        self.scope['json_command'] = lambda check, args: {'items': pods} if check == 'pods' else {}
        self.scope['run'] = mock.Mock(return_value='')
        self.scope['http'] = http = mock.Mock()
        self.scope['internal']()
        identity = [call for call in http.call_args_list if call.args[0].startswith('identity-pod-')]
        self.assertEqual(len(identity), 2)
        self.assertEqual([call.args[1] for call in identity],
                         ['http://192.168.224.31:18444/healthz', 'http://192.168.224.32:18444/healthz'])
        self.assertTrue(all(call.args[2] == 'auth.minsight-ai.com' for call in identity))
        http.assert_any_call('identity-18444', 'http://10.88.88.88:18444/healthz', 'auth.minsight-ai.com')
        records = [r for r in self.records if r['check'] == 'pod']
        self.assertEqual(records[0]['containers'][0]['state'], {'waiting': {'reason': 'CrashLoopBackOff'}})
        self.assertEqual(records[0]['containers'][0]['last_termination']['reason'], 'OOMKilled')
        self.assertEqual(records[1]['containers'][0]['state'], {'terminated': {'reason': 'Error', 'exitCode': 1}})
        self.assertNotIn('DO_NOT_PRINT', json.dumps(self.records))


if __name__ == '__main__':
    unittest.main()
