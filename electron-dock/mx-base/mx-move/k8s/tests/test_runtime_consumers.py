"""Execute product wrappers with fake host facts; never access a live runtime."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

DOCK = Path(__file__).resolve().parents[4]
PAY_RUNTIME = (DOCK / 'mx-base/mx-pay/scripts/runtime.mjs').as_uri()
MOCKS = r'''
record() { printf '%s' "$1" >>"$MOCK_LOG"; shift; printf '\t%s' "$@" >>"$MOCK_LOG"; printf '\n' >>"$MOCK_LOG"; }
[() {
  if builtin [ "${2:-}" = /etc/mx-k8s-runtime/active.json ]; then
    if builtin [ "$MOCK_MARKER" = file ]; then return 0; fi
    if builtin [ "$MOCK_MARKER" = dangling ] && builtin [ "$1" = -L ]; then return 0; fi
    return 1
  fi
  builtin [ "$@"
}
id() { printf '%s\n' "$MOCK_UID"; }
need() { :; }
die() { printf '%s\n' "$*" >&2; exit 17; }
python3() {
  record helper "$@"
  builtin [ "$1" = /usr/local/lib/mx-k8s-runtime/resolve.py ] || return 41
  builtin [ "$MOCK_HELPER_FAIL" = 0 ] || { printf '%s\n' private-helper-contents >&2; return 42; }
  if builtin [ "$2" = root ]; then printf '%s\n' /root-volume/k8s-runtime
  else printf '%s\n' "$MOCK_ADDRESS"; fi
}
sudo() {
  record sudo "$@"
  while [[ "${1:-}" = -* ]]; do shift; done
  "$@"
}
ctr() { record ctr "$@"; if [[ "$*" = *--help* ]]; then printf '%s\n' --local; fi; }
k3s() { record k3s "$@"; }
'''


class ConsumerTests(unittest.TestCase):
    def run_shell(self, source, command, **overrides):
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / 'calls'
            env = dict(os.environ, MOCK_LOG=str(log), MOCK_UID='0', MOCK_MARKER='file',
                       MOCK_HELPER_FAIL='0', MOCK_ADDRESS='/run/new-k8s/containerd.sock')
            env.update(overrides)
            script = 'set -euo pipefail\n'
            if source:
                script += 'source ' + shlex.quote(str(DOCK / source)) + '\n'
            script += MOCKS + '\n' + command
            result = subprocess.run(['bash', '-c', script], env=env, text=True, capture_output=True)
            calls = [line.split('\t') for line in log.read_text().splitlines()] if log.exists() else []
            return result, calls

    def pay_script(self, args='version'):
        result = subprocess.run(['node', '--input-type=module', '-e',
                    'import { ctrScript } from ' + json.dumps(PAY_RUNTIME) + ';process.stdout.write(ctrScript(' + json.dumps(args) + '));'],
                    text=True, capture_output=True, check=True)
        return result.stdout

    def test_product_ctr_wrappers_use_managed_address_and_preserve_arguments(self):
        for source, command in (
                ('mx-insight-hub/scripts/manage.sh', 'run_ctr'),
                ('mx-common/scripts/manage.sh', 'common_ctr noninteractive'),
                ('mx-rig/scripts/manage.sh', 'run_ctr')):
            for uid in ('0', '1000'):
                with self.subTest(source=source, uid=uid):
                    result, calls = self.run_shell(source, command + ' images import "/archive with spaces.tar"', MOCK_UID=uid)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    ctr = [c for c in calls if c[0] == 'ctr']
                    self.assertEqual(ctr, [['ctr', '--address', '/run/new-k8s/containerd.sock', '-n', 'k8s.io', 'images', 'import', '/archive with spaces.tar']])
                    if uid != '0':
                        sudo = [c for c in calls if c[0] == 'sudo']
                        self.assertEqual(sudo[0][1:3], ['-n', 'python3'])
                        self.assertEqual(sudo[1][1:3], ['-n', 'ctr'])

    def test_invalid_managed_state_and_dangling_marker_never_fall_back(self):
        wrappers = [('mx-insight-hub/scripts/manage.sh', 'run_ctr version'),
                    ('mx-common/scripts/manage.sh', 'common_ctr noninteractive version'),
                    ('mx-rig/scripts/manage.sh', 'run_ctr version'),
                    ('mx-rig/scripts/build-proxy.sh', 'rig_proxy_namespace_ctr k8s.io images list -q'),
                    ('mx-base/mx-pay/scripts/build-proxy.sh', 'pay_proxy_namespace_ctr k8s.io images list -q'),
                    (None, self.pay_script())]
        for source, command in wrappers:
            for marker in ('file', 'dangling'):
                for uid in ('0', '1000'):
                    with self.subTest(source=source, marker=marker, uid=uid):
                        result, calls = self.run_shell(source, command, MOCK_MARKER=marker, MOCK_HELPER_FAIL='1', MOCK_UID=uid)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('Managed Kubernetes runtime verification failed', result.stderr)
                        self.assertNotIn('private-helper-contents', result.stderr)
                        self.assertFalse(any(c[0] in ('ctr', 'k3s') for c in calls), calls)
                        self.assertTrue(any(c[0] == 'helper' for c in calls), calls)

    def test_legacy_socket_and_product_sudo_policy_stay_unchanged(self):
        for source, command, legacy_sudo in (
                ('mx-insight-hub/scripts/manage.sh', 'run_ctr', ['sudo', 'ctr']),
                ('mx-common/scripts/manage.sh', 'common_ctr noninteractive', ['sudo', '-n', 'ctr']),
                ('mx-common/scripts/manage.sh', 'common_ctr interactive', ['sudo', 'ctr']),
                ('mx-rig/scripts/manage.sh', 'run_ctr', ['sudo', '-n', 'ctr'])):
            for uid in ('0', '1000'):
                with self.subTest(source=source, command=command, uid=uid):
                    result, calls = self.run_shell(source, command + ' version', MOCK_MARKER='none', MOCK_UID=uid)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual([c for c in calls if c[0] == 'ctr'], [['ctr', '-n', 'k8s.io', 'version']])
                    self.assertFalse(any(c[0] == 'helper' for c in calls))
                    if uid != '0':
                        self.assertEqual(calls[0][:len(legacy_sudo)], legacy_sudo)

    def test_proxy_only_redirects_kubernetes_namespace(self):
        for product, source, pull in (
                ('rig', 'mx-rig/scripts/build-proxy.sh', 'MX_RIG_PROXY_PLATFORM=linux/amd64; rig_proxy_ctr_pull {namespace} registry.example/image:one'),
                ('pay', 'mx-base/mx-pay/scripts/build-proxy.sh', 'pay_proxy_ctr_pull {namespace} linux/amd64 registry.example/image:one')):
            for uid in ('0', '1000'):
                for namespace in ('k8s.io', 'mx-' + product + '-build-proxy'):
                    with self.subTest(product=product, uid=uid, namespace=namespace):
                        result, calls = self.run_shell(source, pull.format(namespace=namespace), MOCK_UID=uid)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        ctr = [c for c in calls if c[0] == 'ctr']
                        self.assertEqual(len(ctr), 2)
                        for call in ctr:
                            self.assertEqual('--address' in call, namespace == 'k8s.io')
                            self.assertEqual(call[call.index('--namespace') + 1], namespace)
                        if namespace != 'k8s.io':
                            self.assertFalse(any(c[0] == 'helper' for c in calls))
                        elif uid != '0':
                            self.assertTrue(any(c[0] == 'sudo' and any(a.startswith('--preserve-env=') for a in c) for c in calls))

    def test_common_disk_root_is_managed_and_override_cannot_diverge(self):
        source = 'mx-common/scripts/manage.sh'
        result, calls = self.run_shell(source, 'common_containerd_root', MOCK_UID='1000')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '/root-volume/k8s-runtime')
        self.assertEqual([c for c in calls if c[0] == 'helper'][0][-1], 'root')
        result, _ = self.run_shell(source, 'MX_COMMON_CONTAINERD_ROOT=/old; common_containerd_root')
        self.assertNotEqual(result.returncode, 0)
        result, calls = self.run_shell(source, 'MX_COMMON_CONTAINERD_ROOT=/old; common_containerd_root', MOCK_MARKER='none')
        self.assertEqual(result.stdout.strip(), '/old')
        self.assertFalse(calls)

    def test_pay_script_resolves_each_target_and_keeps_legacy_k3s(self):
        script = self.pay_script('images import --no-unpack -')
        for uid in ('0', '1000'):
            result, calls = self.run_shell(None, script, MOCK_UID=uid, MOCK_ADDRESS='/run/remote-node/containerd.sock')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([c for c in calls if c[0] == 'ctr'], [['ctr', '--address', '/run/remote-node/containerd.sock', '-n', 'k8s.io', 'images', 'import', '--no-unpack', '-']])
            result, calls = self.run_shell(None, 'unset -f ctr\ncommand() { if [ "${1:-}" = -v ] && [ "${2:-}" = ctr ]; then return 1; fi; builtin command "$@"; }\n' + script,
                                          MOCK_UID=uid, MOCK_MARKER='none')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([c for c in calls if c[0] == 'k3s'], [['k3s', 'ctr', '-n', 'k8s.io', 'images', 'import', '--no-unpack', '-']])
            self.assertFalse(any(c[0] == 'helper' for c in calls))

    def test_pay_rejects_shell_text_in_command_arguments(self):
        for args in ('version; touch /tmp/unsafe', '$(id)', 'images import "file"', 'version\nfalse'):
            with self.subTest(args=args), self.assertRaises(subprocess.CalledProcessError):
                self.pay_script(args)

    def test_pay_ssh_transport_resolves_on_destination_instead_of_caller(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            log = base / 'calls'
            transport = base / 'transport.json'
            prelude = base / 'mocks.sh'
            prelude.write_text('set -euo pipefail\n' + MOCKS)
            ssh = base / 'ssh'
            ssh.write_text('#!' + sys.executable + '\n' + '''import json,os,subprocess,sys
from pathlib import Path
Path(os.environ['MOCK_TRANSPORT']).write_text(json.dumps(sys.argv[1:]))
env=dict(os.environ, MOCK_ADDRESS='/run/ssh-destination/containerd.sock')
script=Path(os.environ['MOCK_PRELUDE']).read_text()+'\\n'+sys.argv[-1]
sys.exit(subprocess.run(['bash','-c',script],env=env).returncode)
''')
            ssh.chmod(0o755)
            env = dict(os.environ, PATH=str(base) + os.pathsep + os.environ['PATH'],
                       MOCK_LOG=str(log), MOCK_TRANSPORT=str(transport), MOCK_PRELUDE=str(prelude),
                       MOCK_UID='1000', MOCK_MARKER='file', MOCK_HELPER_FAIL='0',
                       MOCK_ADDRESS='/run/deployment-caller/containerd.sock')
            code = 'import { ctrScript, nodeCommand } from ' + json.dumps(PAY_RUNTIME) + ''';
nodeCommand({metadata:{name:'remote',annotations:{'mx-pay.io/ssh-target':'root@node.example'}}},
            {metadata:{name:'caller'}},ctrScript('version'));
'''
            result = subprocess.run(['node', '--input-type=module', '-e', code], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            args = json.loads(transport.read_text())
            self.assertEqual(args[-2], 'root@node.example')
            self.assertIn('StrictHostKeyChecking=yes', args)
            calls = [line.split('\t') for line in log.read_text().splitlines()]
            self.assertEqual([c for c in calls if c[0] == 'ctr'],
                             [['ctr', '--address', '/run/ssh-destination/containerd.sock', '-n', 'k8s.io', 'version']])
            self.assertNotIn('/run/deployment-caller/containerd.sock', json.dumps(calls))


if __name__ == '__main__':
    unittest.main()
