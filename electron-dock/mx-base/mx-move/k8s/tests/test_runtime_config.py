"""Offline config-clone regressions; no production filesystem or daemon access."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import runtime_config as config
finally:
    sys.path.pop(0)

# Canonical 1.6 built-in schema fixture, checked against upstream
# v1.6.32/pkg/cri/config/config.go, v1.6.32/docs/cri/config.md,
# release/1.6/pkg/cri/config/config_unix.go and
# release/1.6/cmd/containerd/command/config.go. This is source-derived, not a
# captured Linux 1.6.32 binary dump; the executor must validate the real dump.
# SystemdCgroup and pause are the observed host overrides. The imports entry is
# the main-file record added by LoadConfig, even when source imports are [].
DUMP = '''version = 2
root = "/var/lib/containerd"
state = "/run/containerd"
temp = ""
plugin_dir = ""
disabled_plugins = []
required_plugins = []
imports = ["/etc/containerd/config.toml"]
oom_score = 0
[cgroup]
  path = ""
[debug]
  address = ""
  uid = 0
  gid = 0
  level = ""
  format = ""
[grpc]
  address = "/run/containerd/containerd.sock"
  tcp_address = ""
  tcp_tls_ca = ""
  tcp_tls_cert = ""
  tcp_tls_key = ""
  uid = 0
  gid = 0
  max_recv_message_size = 16777216
  max_send_message_size = 16777216
[metrics]
  address = ""
  grpc_histogram = false
[plugins]
  [plugins."io.containerd.gc.v1.scheduler"]
    mutation_threshold = 100
    pause_threshold = 0.02
    deletion_threshold = 0
    schedule_delay = "0s"
    startup_delay = "100ms"
  [plugins."io.containerd.grpc.v1.cri"]
    device_ownership_from_security_context = false
    disable_apparmor = false
    disable_cgroup = false
    disable_hugetlb_controller = true
    disable_proc_mount = false
    disable_tcp_service = true
    drain_exec_sync_io_timeout = "0s"
    stream_server_address = "127.0.0.1"
    stream_server_port = "0"
    stream_idle_timeout = "4h0m0s"
    sandbox_image = "registry.k8s.io/pause:3.10.2"
    enable_selinux = false
    enable_tls_streaming = false
    enable_unprivileged_icmp = false
    enable_unprivileged_ports = false
    ignore_deprecation_warnings = []
    ignore_image_defined_volumes = false
    max_concurrent_downloads = 3
    max_container_log_line_size = 16384
    netns_mounts_under_state_dir = false
    restrict_oom_score_adj = false
    selinux_category_range = 1024
    stats_collect_period = 10
    systemd_cgroup = false
    tolerate_missing_hugetlb_controller = true
    unset_seccomp_profile = ""
    [plugins."io.containerd.grpc.v1.cri".containerd]
      snapshotter = "overlayfs"
      default_runtime_name = "runc"
      disable_snapshot_annotations = true
      discard_unpacked_layers = false
      ignore_rdt_not_enabled_errors = false
      no_pivot = false
      [plugins."io.containerd.grpc.v1.cri".containerd.default_runtime]
        base_runtime_spec = ""
        cni_conf_dir = ""
        cni_max_conf_num = 0
        container_annotations = []
        pod_annotations = []
        privileged_without_host_devices = false
        runtime_type = ""
        runtime_path = ""
        runtime_engine = ""
        runtime_root = ""
        [plugins."io.containerd.grpc.v1.cri".containerd.default_runtime.options]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          cni_conf_dir = ""
          cni_max_conf_num = 0
          container_annotations = []
          pod_annotations = []
          privileged_without_host_devices = false
          runtime_type = "io.containerd.runc.v2"
          runtime_path = ""
          runtime_engine = ""
          runtime_root = ""
          base_runtime_spec = ""
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            BinaryName = ""
            CriuImagePath = ""
            CriuPath = ""
            CriuWorkPath = ""
            IoGid = 0
            IoUid = 0
            NoNewKeyring = false
            NoPivotRoot = false
            Root = ""
            ShimCgroup = ""
            SystemdCgroup = true
      [plugins."io.containerd.grpc.v1.cri".containerd.untrusted_workload_runtime]
        base_runtime_spec = ""
        cni_conf_dir = ""
        cni_max_conf_num = 0
        container_annotations = []
        pod_annotations = []
        privileged_without_host_devices = false
        runtime_engine = ""
        runtime_path = ""
        runtime_root = ""
        runtime_type = ""
        [plugins."io.containerd.grpc.v1.cri".containerd.untrusted_workload_runtime.options]
    [plugins."io.containerd.grpc.v1.cri".cni]
      bin_dir = "/opt/cni/bin"
      conf_dir = "/etc/cni/net.d"
      conf_template = ""
      max_conf_num = 1
      ip_pref = ""
    [plugins."io.containerd.grpc.v1.cri".image_decryption]
      key_model = "node"
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = ""
      [plugins."io.containerd.grpc.v1.cri".registry.auths]
      [plugins."io.containerd.grpc.v1.cri".registry.configs]
      [plugins."io.containerd.grpc.v1.cri".registry.headers]
      [plugins."io.containerd.grpc.v1.cri".registry.mirrors]
    [plugins."io.containerd.grpc.v1.cri".x509_key_pair_streaming]
      tls_cert_file = ""
      tls_key_file = ""
  [plugins."io.containerd.internal.v1.opt"]
    path = "/opt/containerd"
  [plugins."io.containerd.internal.v1.restart"]
    interval = "10s"
  [plugins."io.containerd.internal.v1.tracing"]
    sampling_ratio = 1.0
  [plugins."io.containerd.metadata.v1.bolt"]
    content_sharing_policy = "shared"
  [plugins."io.containerd.monitor.v1.cgroups"]
    no_prometheus = false
  [plugins."io.containerd.runtime.v1.linux"]
    runtime = "runc"
    runtime_root = ""
    shim = "containerd-shim"
    no_shim = false
    shim_debug = false
  [plugins."io.containerd.runtime.v2.task"]
    platforms = ["linux/amd64"]
    sched_core = false
  [plugins."io.containerd.service.v1.diff-service"]
    default = ["walking"]
  [plugins."io.containerd.service.v1.tasks-service"]
    blockio_config_file = ""
    rdt_config_file = ""
  [plugins."io.containerd.snapshotter.v1.aufs"]
    root_path = ""
  [plugins."io.containerd.snapshotter.v1.btrfs"]
    root_path = ""
  [plugins."io.containerd.snapshotter.v1.devmapper"]
    async_remove = false
    discard_blocks = false
    fs_options = ""
    fs_type = ""
    root_path = ""
    pool_name = ""
    base_image_size = ""
  [plugins."io.containerd.snapshotter.v1.native"]
    root_path = ""
  [plugins."io.containerd.snapshotter.v1.overlayfs"]
    root_path = ""
    upperdir_label = false
  [plugins."io.containerd.snapshotter.v1.zfs"]
    root_path = ""
  [plugins."io.containerd.tracing.processor.v1.otlp"]
    endpoint = ""
    insecure = false
[proxy_plugins]
[stream_processors]
  [stream_processors."io.containerd.ocicrypt.decoder.v1.tar"]
    accepts = ["application/vnd.oci.image.layer.v1.tar+encrypted"]
    args = ["--decryption-keys-path", "/etc/containerd/ocicrypt/keys"]
    env = ["OCICRYPT_KEYPROVIDER_CONFIG=/etc/containerd/ocicrypt/ocicrypt_keyprovider.conf"]
    path = "ctd-decoder"
    returns = "application/vnd.oci.image.layer.v1.tar"
  [stream_processors."io.containerd.ocicrypt.decoder.v1.tar.gzip"]
    accepts = ["application/vnd.oci.image.layer.v1.tar+gzip+encrypted"]
    args = ["--decryption-keys-path", "/etc/containerd/ocicrypt/keys"]
    env = ["OCICRYPT_KEYPROVIDER_CONFIG=/etc/containerd/ocicrypt/ocicrypt_keyprovider.conf"]
    path = "ctd-decoder"
    returns = "application/vnd.oci.image.layer.v1.tar+gzip"
[timeouts]
  "io.containerd.timeout.bolt.open" = "0s"
  "io.containerd.timeout.shim.cleanup" = "5s"
  "io.containerd.timeout.shim.load" = "5s"
  "io.containerd.timeout.shim.shutdown" = "3s"
  "io.containerd.timeout.task.state" = "2s"
[ttrpc]
  address = ""
  uid = 0
  gid = 0
'''
ROOT = '/var/lib/mx-move/k8s-runtime/data'
STATE = '/run/mx-k8s-containerd'
ADDRESS = STATE + '/containerd.sock'
SECRET = 'registry-secret-never-print'


class CloneTests(unittest.TestCase):
    def clone(self, raw=DUMP):
        return config.clone_config(raw, ROOT, STATE, ADDRESS)

    def test_standard_profile_is_cloned_and_valid_toml(self):
        result = self.clone()
        text = result['config_text']
        _, entries, _ = config._parse(text)
        self.assertEqual(entries[((), 'imports')][1], '[]')
        self.assertEqual(entries[((), 'root')][1], json.dumps(ROOT))
        self.assertEqual(entries[((), 'state')][1], json.dumps(STATE))
        self.assertEqual(entries[(('ttrpc',), 'address')][1], json.dumps(ADDRESS + '.ttrpc'))
        self.assertIn('Root = "' + STATE + '/runc"', text)
        self.assertIn('sandbox_image = "registry.k8s.io/pause:3.10.2"', text)
        self.assertIn('SystemdCgroup = true', text)
        self.assertFalse(result['metadata']['execution_supported'])
        # On modern test runners, independently validate the whole emitted TOML.
        try:
            import tomllib
        except ImportError:
            pass
        else:
            parsed = tomllib.loads(text)
            self.assertEqual(parsed['root'], ROOT)
            self.assertEqual(parsed['plugins'][config.CRI]['cni']['conf_dir'], '/etc/cni/net.d')

    def test_original_text_and_private_registry_values_are_preserved(self):
        extra = '\n[plugins."io.containerd.grpc.v1.cri".registry.configs."private.example".auth]\n  password = "' + SECRET + '"\n'
        original = DUMP + extra
        result = self.clone(original)
        self.assertIn(extra, result['config_text'])
        self.assertIn('  pause_threshold = 0.02\n', result['config_text'])
        self.assertNotIn(SECRET, json.dumps(result['metadata']))
        self.assertEqual(original, DUMP + extra)

    def test_missing_optional_isolation_fields_are_added_in_correct_tables(self):
        raw = DUMP.replace('temp = ""\n', '').replace('imports = ["/etc/containerd/config.toml"]\n', '')
        raw = raw.replace('            Root = ""\n', '').replace('[metrics]\n  address = ""\n  grpc_histogram = false\n', '')
        text = self.clone(raw)['config_text']
        _, entries, _ = config._parse(text)
        self.assertEqual(entries[((), 'temp')][1], json.dumps(ROOT + '/tmp'))
        self.assertEqual(entries[(('metrics',), 'address')][1], '""')
        self.assertEqual(entries[((), 'imports')][1], '[]')

    def test_fixed_listener_ports_are_isolated(self):
        raw = DUMP.replace('tcp_address = ""', 'tcp_address = "0.0.0.0:8080"')
        raw = raw.replace('stream_server_port = "0"', 'stream_server_port = "10010"')
        raw = raw.replace('[metrics]\n  address = ""', '[metrics]\n  address = "127.0.0.1:1338"')
        text = self.clone(raw)['config_text']
        self.assertNotIn('10010', text)
        self.assertNotIn('1338', text)
        self.assertNotIn('8080', text)

    def test_binary_normalized_clone_can_be_validated_again(self):
        first = self.clone()
        normalized = first['config_text'].replace('imports = []', 'imports = ["/private/staged/config.toml"]')
        second = self.clone(normalized)
        self.assertEqual(first['metadata'], second['metadata'])
        self.assertEqual(first['config_text'], second['config_text'])

    def test_unsupported_profiles_and_external_resources_fail_closed(self):
        examples = [
            DUMP.replace('version = 2', 'version = 3'),
            DUMP.replace('snapshotter = "overlayfs"', 'snapshotter = "stargz"'),
            DUMP.replace('SystemdCgroup = true', 'SystemdCgroup = false'),
            DUMP.replace('plugin_dir = ""', 'plugin_dir = "/opt/custom"'),
            DUMP.replace('root_path = ""', 'root_path = "/shared/snapshots"', 1),
            DUMP.replace('Root = ""', 'Root = "/run/shared-runc"'),
            DUMP.replace('conf_template = ""', 'conf_template = "/tmp/template"'),
            DUMP.replace('pool_name = ""', 'pool_name = "docker-pool"'),
            DUMP.replace('runtime_type = "io.containerd.runc.v2"', 'runtime_type = "custom"'),
            DUMP.replace('runtime_type = ""', 'runtime_type = "io.containerd.runtime.v1.linux"', 1),
            DUMP.replace('ShimCgroup = ""', 'ShimCgroup = "/system/shared"'),
            DUMP + '\n[proxy_plugins.custom]\naddress = "/run/custom.sock"\n',
            DUMP + '\n[plugins."io.containerd.nri.v1.nri"]\ndisable = true\n',
            DUMP + '\n[plugins."io.containerd.grpc.v1.cri".unknown]\nserver_port = 1234\n',
            DUMP + '\n[plugins."io.containerd.grpc.v1.cri".unknown]\nlistener_address = ""\n',
            DUMP + '\n[plugins."io.containerd.grpc.v1.cri".unknown]\ndata_root = "/shared"\n',
            DUMP.replace('[cgroup]\n  path = ""', '[cgroup]\n  path = "/shared"'),
        ]
        for raw in examples:
            with self.subTest(raw=examples.index(raw)):
                with self.assertRaisesRegex(config.ConfigError, '^' + config.ERROR + '$'):
                    self.clone(raw)

    def test_invalid_syntax_does_not_leak_secrets(self):
        for raw in (DUMP + '\nroot = "' + SECRET + '"\nroot = "duplicate"\n',
                    DUMP + '\n[plugins."io.containerd.grpc.v1.cri".weird]\nsecret = """' + SECRET + '\n"""\n',
                    DUMP + '\n[[secret]]\nvalue = "' + SECRET + '"\n'):
            with self.assertRaises(config.ConfigError) as caught:
                self.clone(raw)
            self.assertNotIn(SECRET, str(caught.exception))

    def test_target_aliases_nested_paths_and_unsafe_strings_are_rejected(self):
        for root, state, address in [
                ('/var/lib/containerd/clone', STATE, ADDRESS),
                (ROOT, '/run/containerd/clone', '/run/containerd/clone/a.sock'),
                (ROOT, ROOT + '/state', ROOT + '/state/a.sock'),
                ('/var/lib/../data', STATE, ADDRESS),
                (ROOT, STATE, '/run/other/a.sock'),
                (ROOT, STATE, STATE + '/' + 'a' * 100),
                ('/var/lib/secret\n' + SECRET, STATE, ADDRESS)]:
            with self.assertRaisesRegex(config.ConfigError, '^' + config.PATH_ERROR + '$'):
                config.clone_config(DUMP, root, state, address)

    def test_static_reason_codes_do_not_disclose_configuration(self):
        examples = [
            ('syntax', DUMP + '\n[[bad]]\n'),
            ('profile', DUMP.replace('SystemdCgroup = true', 'SystemdCgroup = false')),
            ('plugin', DUMP + '\n[proxy_plugins.custom]\naddress = "' + SECRET + '"\n'),
            ('external_path', DUMP.replace('Root = ""', 'Root = "/' + SECRET + '"')),
            ('listener', DUMP + '\n[plugins."io.containerd.grpc.v1.cri".unknown]\nlistener_address = "' + SECRET + '"\n'),
        ]
        for reason, raw in examples:
            with self.subTest(reason=reason):
                with self.assertRaises(config.ConfigError) as caught:
                    self.clone(raw)
                self.assertEqual(caught.exception.reason, reason)
                self.assertNotIn(SECRET, str(caught.exception))
        with self.assertRaises(config.ConfigError) as caught:
            config.clone_config(DUMP, '/var/lib/containerd', STATE, ADDRESS)
        self.assertEqual(caught.exception.reason, 'target_path')
        malicious = config.ConfigError(SECRET, reason=SECRET)
        self.assertEqual(malicious.reason, 'unsupported')
        self.assertNotIn(SECRET, str(malicious))


if __name__ == '__main__':
    unittest.main()
