const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { after, test } = require('node:test');

const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '../../..');
const sourceScript = resolve(repoRoot, 'scripts/mihomo-client.sh');
const packagedScript = resolve(packageRoot, 'resources/mihomo-client.sh');
const testRoot = mkdtempSync(join(tmpdir(), 'qp-tunnel-cli-instance-test-'));
const libraryScript = join(testRoot, 'mihomo-client-library.sh');

const scriptContent = readFileSync(packagedScript, 'utf8');
assert.match(scriptContent, /\nmain "\$@"\s*$/);
writeFileSync(libraryScript, scriptContent.replace(/\nmain "\$@"\s*$/, '\n'));
chmodSync(libraryScript, 0o755);

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('MIHOMO_')) delete environment[name];
  }
  return {
    ...environment,
    MIHOMO_TEST_LIBRARY: libraryScript,
    ...extra,
  };
}

function runLibrary(args, body, options = {}) {
  return spawnSync(
    'bash',
    ['-c', `source "$MIHOMO_TEST_LIBRARY"\n${body}`, options.shellName || 'qp-tunnel-test-shell', ...args],
    {
      encoding: 'utf8',
      env: cleanEnvironment(options.env),
    },
  );
}

test('packaged mihomo client is synchronized with its repository source', () => {
  assert.equal(readFileSync(packagedScript, 'utf8'), readFileSync(sourceScript, 'utf8'));
});

test('default instance preserves historical 7788 paths and arguments', () => {
  const result = runLibrary(['status'], String.raw`
printf '%s\n' \
  "$MIHOMO_INSTANCE" \
  "$MIHOMO_HOME" \
  "$MIHOMO_CONFIG_FILE" \
  "$MIHOMO_BIN" \
  "$MIHOMO_CLIENT_LAUNCHER" \
  "$MIHOMO_SERVICE_NAME" \
  "$MIHOMO_SERVICE_FILE" \
  "$MIHOMO_MIXED_PORT" \
  "$#" \
  "$1"
`);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'default',
    '/etc/mihomo-client',
    '/etc/mihomo-client/config.yaml',
    '/usr/local/bin/mihomo',
    '/usr/local/bin/mihomo-client',
    'mihomo-client.service',
    '/etc/systemd/system/mihomo-client.service',
    '7788',
    '1',
    'status',
  ]);
});

test('subscriptions instance receives a complete namespace and strips only its management option', () => {
  const result = runLibrary(
    ['update-subscription', '--url', 'http://example.test/peer.yaml', '--instance', 'subscriptions'],
    String.raw`
printf '%s\n' \
  "$MIHOMO_INSTANCE" \
  "$MIHOMO_HOME" \
  "$MIHOMO_ENV_FILE" \
  "$MIHOMO_SUBSCRIPTION_FILE" \
  "$MIHOMO_CONFIG_FILE" \
  "$MIHOMO_TUN_OVERLAY_FILE" \
  "$MIHOMO_BIN" \
  "$MIHOMO_CLIENT_LAUNCHER" \
  "$MIHOMO_SERVICE_NAME" \
  "$MIHOMO_SERVICE_FILE" \
  "$MIHOMO_PROFILE_PROXY_FILE" \
  "$MIHOMO_SSH_PROXY_HELPER" \
  "$MIHOMO_SSH_CONFIG_FILE" \
  "$MIHOMO_DAEMON_PROXY_DROPIN_NAME" \
  "$MIHOMO_DOCKER_BUILD_PROXY_DROPIN" \
  "$MIHOMO_EXPLICIT_USE_ONLY" \
  "$#" \
  "$1" \
  "$2" \
  "$3"
`,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'subscriptions',
    '/etc/mihomo-client/instances/subscriptions',
    '/etc/mihomo-client/instances/subscriptions/client.env',
    '/etc/mihomo-client/instances/subscriptions/subscription.yaml',
    '/etc/mihomo-client/instances/subscriptions/config.yaml',
    '/etc/mihomo-client/instances/subscriptions/tun-overlay.yaml',
    '/usr/local/bin/mihomo-subscriptions',
    '/usr/local/bin/mihomo-client-subscriptions',
    'mihomo-client@subscriptions.service',
    '/etc/systemd/system/mihomo-client@subscriptions.service',
    '/etc/profile.d/mihomo-client-subscriptions-proxy.sh',
    '/usr/local/bin/mihomo-subscriptions-ssh-proxy',
    '/etc/ssh/ssh_config.d/99-mihomo-client-subscriptions-proxy.conf',
    'zzz-qp-tunnel-subscriptions-daemon-proxy.conf',
    'zzz-qp-tunnel-subscriptions-docker-build-proxy.conf',
    'true',
    '3',
    'update-subscription',
    '--url',
    'http://example.test/peer.yaml',
  ]);
});

test('recommended install syntax reaches the installer with the selected instance and port', () => {
  const result = runLibrary(
    [
      'install',
      '--instance',
      'subscriptions',
      '--mixed-port',
      '7890',
      '--url',
      'http://example.test:3434/peer_subscriptions.mihomo.yaml',
    ],
    String.raw`
require_root() { :; }
require_cmd() { :; }
install_command() {
  printf '%s\n' "$MIHOMO_INSTANCE" "$1" "$8" "$9"
}
main "$@"
`,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'subscriptions',
    'http://example.test:3434/peer_subscriptions.mihomo.yaml',
    'true',
    '7890',
  ]);
});

test('lifecycle commands target the named systemd unit', () => {
  for (const action of ['start', 'stop', 'restart', 'enable', 'disable']) {
    const result = runLibrary(
      [action, '--instance', 'subscriptions'],
      'require_root() { :; }\nrequire_cmd() { :; }\nsystemctl() { printf "%s\\n" "$*"; }\nmain "$@"',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${action} mihomo-client@subscriptions.service\n`);
  }
});

test('named launcher infers its instance without an extra option', () => {
  const result = runLibrary(['status'], 'printf "%s\\n" "$MIHOMO_INSTANCE" "$MIHOMO_SERVICE_NAME"', {
    shellName: 'mihomo-client-subscriptions',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'subscriptions\nmihomo-client@subscriptions.service\n');
});

test('instance names are constrained before any management action', () => {
  const result = runLibrary(['status', '--instance', '../default'], 'echo unreachable');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Instance must be 'default' or match/);
  assert.doesNotMatch(result.stdout, /unreachable/);
});

test('subscriptions refuses host-wide proxy and TUN integrations', () => {
  const blocked = runLibrary(
    ['status', '--instance', 'subscriptions'],
    'require_host_integration_allowed\necho unreachable',
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /explicit-use-only/);
  assert.doesNotMatch(blocked.stdout, /unreachable/);

  const defaultInstance = runLibrary(['status'], 'require_host_integration_allowed\necho allowed');
  assert.equal(defaultInstance.status, 0, defaultInstance.stderr);
  assert.equal(defaultInstance.stdout, 'allowed\n');
});

test('every host-integration command is blocked before it can mutate subscriptions or shared host state', () => {
  const commands = [
    ['egress-on'],
    ['egress-off'],
    ['server-on'],
    ['server-off'],
    ['tun-on'],
    ['tun-off'],
    ['listen', 'on'],
    ['listen', 'off'],
    ['proxy-on'],
    ['proxy-off'],
    ['ssh-proxy-on'],
    ['ssh-proxy-off'],
    ['daemon-proxy-on'],
    ['daemon-proxy-off'],
    ['docker-proxy-on'],
    ['docker-proxy-off'],
    ['docker-build-proxy', 'on'],
    ['docker-build-proxy', 'off'],
  ];

  for (const command of commands) {
    const result = runLibrary(
      [...command, '--instance', 'subscriptions'],
      'require_root() { :; }\nrequire_cmd() { :; }\nmain "$@"',
    );
    assert.notEqual(result.status, 0, `${command.join(' ')} unexpectedly succeeded`);
    assert.match(result.stderr, /explicit-use-only/, command.join(' '));
  }
});

test('named install persists mixed port and overrides the downloaded YAML port', () => {
  const stateRoot = join(testRoot, 'persisted-state');
  const result = runLibrary(
    ['install', '--instance', 'subscriptions', '--mixed-port', '7890'],
    String.raw`
MIHOMO_HOME="$MIHOMO_TEST_STATE_ROOT"
MIHOMO_ENV_FILE="$MIHOMO_HOME/client.env"
MIHOMO_SUBSCRIPTION_FILE="$MIHOMO_HOME/subscription.yaml"
MIHOMO_CONFIG_FILE="$MIHOMO_HOME/config.yaml"
MIHOMO_TUN_OVERLAY_FILE="$MIHOMO_HOME/tun-overlay.yaml"
MIHOMO_BIN="$MIHOMO_HOME/mihomo"
MIHOMO_CLIENT_LAUNCHER="$MIHOMO_HOME/mihomo-client"
MIHOMO_SERVICE_FILE="$MIHOMO_HOME/mihomo-client.service"

port_held_by_other_process() { return 1; }
install_binary() { set_env_value MIHOMO_VERSION test-engine; }
install_client_launcher() { :; }
write_service_file() { :; }
systemd_reload() { :; }
systemctl() { return 0; }
update_subscription_command() {
  printf '%s\n' 'mixed-port: 4567' 'mode: rule' > "$MIHOMO_SUBSCRIPTION_FILE"
  render_runtime_config
}

install_command '' '' '' latest false '' "$MIHOMO_HOME/input.yaml" true 7890
grep '^MIHOMO_MIXED_PORT=' "$MIHOMO_ENV_FILE"
grep '^mixed-port:' "$MIHOMO_CONFIG_FILE"
`,
    { env: { MIHOMO_TEST_STATE_ROOT: stateRoot } },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^MIHOMO_MIXED_PORT='7890'$/m);
  assert.match(result.stdout, /^mixed-port: 7890$/m);
  assert.doesNotMatch(readFileSync(join(stateRoot, 'config.yaml'), 'utf8'), /^mixed-port: 4567$/m);
});

test('first named install requires an explicit mixed port before it writes state', () => {
  const stateRoot = join(testRoot, 'missing-port-state');
  const result = runLibrary(
    ['install', '--instance', 'subscriptions'],
    String.raw`
MIHOMO_HOME="$MIHOMO_TEST_STATE_ROOT"
MIHOMO_ENV_FILE="$MIHOMO_HOME/client.env"
install_command 'http://example.test/peer.yaml' '' '' latest false '' '' true ''
`,
    { env: { MIHOMO_TEST_STATE_ROOT: stateRoot } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /first install of named instance 'subscriptions' requires --mixed-port PORT/);
});

test('subscriptions is pinned to 7890 even while the default 7788 listener is stopped', () => {
  for (const command of [
    ['install', '--instance', 'subscriptions', '--mixed-port', '7788'],
    ['port', '7788', '--instance', 'subscriptions'],
  ]) {
    const result = runLibrary(
      command,
      'require_root() { :; }\nrequire_cmd() { :; }\nport_held_by_other_process() { return 1; }\nmain "$@"',
    );
    assert.notEqual(result.status, 0, `${command.join(' ')} unexpectedly succeeded`);
    assert.match(result.stderr, /pinned to mixed port 7890/);
  }
});

test('subscriptions rejects a legacy persisted 7788 state through main before systemd lifecycle actions', () => {
  const stateRoot = join(testRoot, 'unsafe-persisted-port');
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, 'client.env'), "MIHOMO_MIXED_PORT='7788'\n");
  for (const action of ['start', 'restart', 'enable']) {
    const result = runLibrary(
      [action, '--instance', 'subscriptions'],
      String.raw`
MIHOMO_ENV_FILE="$MIHOMO_TEST_STATE_ROOT/client.env"
require_root() { :; }
require_cmd() { :; }
systemctl() { echo systemctl-unreachable; }
main "$@"
`,
      { env: { MIHOMO_TEST_STATE_ROOT: stateRoot } },
    );
    assert.notEqual(result.status, 0, `${action} unexpectedly succeeded`);
    assert.match(result.stderr, /unsafe persisted mixed port/, action);
    assert.doesNotMatch(result.stdout, /systemctl-unreachable/, action);
  }
});

test('Basic subscription credentials stay out of curl argv and temporary files are cleaned after success', () => {
  const stateRoot = join(testRoot, 'fetch-basic-success');
  mkdirSync(stateRoot, { recursive: true });
  const result = runLibrary(
    ['status'],
    String.raw`
MIHOMO_HOME="$MIHOMO_TEST_STATE_ROOT/client"
MIHOMO_SUBSCRIPTION_FILE="$MIHOMO_HOME/subscription.yaml"
MIHOMO_CONFIG_FILE="$MIHOMO_HOME/config.yaml"
MIHOMO_TUN_OVERLAY_FILE="$MIHOMO_HOME/tun-overlay.yaml"
mkdir -p "$MIHOMO_HOME"
curl() {
  printf '%s\n' "$@" > "$MIHOMO_TEST_STATE_ROOT/curl.argv"
  local config=""
  local output=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --config) config="$2"; shift 2 ;;
      -o) output="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf '%s\n' "$config" > "$MIHOMO_TEST_STATE_ROOT/curl-config-path"
  printf '%s\n' "$output" > "$MIHOMO_TEST_STATE_ROOT/curl-output-path"
  (stat -c '%a' "$config" 2>/dev/null || stat -f '%Lp' "$config") > "$MIHOMO_TEST_STATE_ROOT/curl-config-mode"
  cp "$config" "$MIHOMO_TEST_STATE_ROOT/curl-config-snapshot"
  printf '%s\n' 'mixed-port: 4567' 'mode: rule' > "$output"
}
extract_auth_from_url 'http://basic-user:p%40ss%3A%22word%5Ctail@example.test:3434/peer.yaml' > "$MIHOMO_TEST_STATE_ROOT/normalized-inputs"
{
  IFS= read -r normalized_url
  IFS= read -r normalized_username
  IFS= read -r normalized_password
} < "$MIHOMO_TEST_STATE_ROOT/normalized-inputs"
fetch_subscription "$normalized_url" "$normalized_username" "$normalized_password"
`,
    { env: { MIHOMO_TEST_STATE_ROOT: stateRoot } },
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = readFileSync(join(stateRoot, 'curl.argv'), 'utf8');
  assert.match(argv, /--config/);
  assert.match(argv, /http:\/\/example\.test:3434\/peer\.yaml/);
  assert.doesNotMatch(argv, /basic-user|p@ss|%40ss/);
  assert.doesNotMatch(result.stderr, /basic-user|p@ss|%40ss/);
  assert.equal(readFileSync(join(stateRoot, 'curl-config-mode'), 'utf8').trim(), '600');
  assert.equal(
    readFileSync(join(stateRoot, 'curl-config-snapshot'), 'utf8'),
    'user = "basic-user:p@ss:\\"word\\\\tail"\n',
  );
  const configPath = readFileSync(join(stateRoot, 'curl-config-path'), 'utf8').trim();
  const outputPath = readFileSync(join(stateRoot, 'curl-output-path'), 'utf8').trim();
  assert.equal(existsSync(configPath), false);
  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(join(stateRoot, 'client/subscription.yaml')), true);
});

test('URL Basic Auth overrides credentials saved by an earlier subscription', () => {
  const stateRoot = join(testRoot, 'update-url-auth-precedence');
  mkdirSync(stateRoot, { recursive: true });
  const result = runLibrary(
    [
      'update-subscription',
      '--url',
      'http://fresh-user:fresh-password@example.test:3434/peer.yaml',
    ],
    String.raw`
MIHOMO_HOME="$MIHOMO_TEST_STATE_ROOT/client"
MIHOMO_ENV_FILE="$MIHOMO_HOME/client.env"
MIHOMO_SUBSCRIPTION_FILE="$MIHOMO_HOME/subscription.yaml"
MIHOMO_CONFIG_FILE="$MIHOMO_HOME/config.yaml"
MIHOMO_TUN_OVERLAY_FILE="$MIHOMO_HOME/tun-overlay.yaml"
mkdir -p "$MIHOMO_HOME"
set_env_value MIHOMO_SUBSCRIPTION_URL 'http://old.example.test/peer.yaml'
set_env_value MIHOMO_SUBSCRIPTION_USER 'stale-user'
set_env_value MIHOMO_SUBSCRIPTION_PASSWORD 'stale-password'
require_root() { :; }
require_cmd() { :; }
service_is_active() { return 1; }
mapfile() {
  if [[ "$1" == '-t' ]]; then shift; fi
  local target="$1"
  local line
  while IFS= read -r line; do
    eval "$target+=(\"\$line\")"
  done
}
curl() {
  printf '%s\n' "$@" > "$MIHOMO_TEST_STATE_ROOT/curl.argv"
  local config=""
  local output=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --config) config="$2"; shift 2 ;;
      -o) output="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$config" "$MIHOMO_TEST_STATE_ROOT/curl-config-snapshot"
  printf '%s\n' 'mixed-port: 4567' 'mode: rule' > "$output"
}
main "$@"
`,
    { env: { MIHOMO_TEST_STATE_ROOT: stateRoot } },
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = readFileSync(join(stateRoot, 'curl.argv'), 'utf8');
  assert.match(argv, /http:\/\/example\.test:3434\/peer\.yaml/);
  assert.doesNotMatch(argv, /fresh-user|fresh-password|stale-user|stale-password/);
  assert.equal(
    readFileSync(join(stateRoot, 'curl-config-snapshot'), 'utf8'),
    'user = "fresh-user:fresh-password"\n',
  );
  const saved = readFileSync(join(stateRoot, 'client/client.env'), 'utf8');
  assert.match(saved, /^MIHOMO_SUBSCRIPTION_USER='fresh-user'$/m);
  assert.match(saved, /^MIHOMO_SUBSCRIPTION_PASSWORD='fresh-password'$/m);
});

test('update --no-auth ignores URL userinfo and clears saved credentials', () => {
  const stateRoot = join(testRoot, 'update-url-no-auth');
  mkdirSync(stateRoot, { recursive: true });
  const result = runLibrary(
    [
      'update-subscription',
      '--url',
      'http://ignored-user:ignored-password@example.test:3434/public.yaml',
      '--no-auth',
    ],
    String.raw`
MIHOMO_HOME="$MIHOMO_TEST_STATE_ROOT/client"
MIHOMO_ENV_FILE="$MIHOMO_HOME/client.env"
MIHOMO_SUBSCRIPTION_FILE="$MIHOMO_HOME/subscription.yaml"
MIHOMO_CONFIG_FILE="$MIHOMO_HOME/config.yaml"
MIHOMO_TUN_OVERLAY_FILE="$MIHOMO_HOME/tun-overlay.yaml"
mkdir -p "$MIHOMO_HOME"
set_env_value MIHOMO_SUBSCRIPTION_URL 'http://old.example.test/peer.yaml'
set_env_value MIHOMO_SUBSCRIPTION_USER 'stale-user'
set_env_value MIHOMO_SUBSCRIPTION_PASSWORD 'stale-password'
require_root() { :; }
require_cmd() { :; }
service_is_active() { return 1; }
mapfile() {
  if [[ "$1" == '-t' ]]; then shift; fi
  local target="$1"
  local line
  while IFS= read -r line; do
    eval "$target+=(\"\$line\")"
  done
}
curl() {
  printf '%s\n' "$@" > "$MIHOMO_TEST_STATE_ROOT/curl.argv"
  local output=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o) output="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf '%s\n' 'mixed-port: 4567' 'mode: rule' > "$output"
}
main "$@"
`,
    { env: { MIHOMO_TEST_STATE_ROOT: stateRoot } },
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = readFileSync(join(stateRoot, 'curl.argv'), 'utf8');
  assert.match(argv, /http:\/\/example\.test:3434\/public\.yaml/);
  assert.doesNotMatch(argv, /--config|-u|--user|ignored-user|ignored-password/);
  const saved = readFileSync(join(stateRoot, 'client/client.env'), 'utf8');
  assert.match(saved, /^MIHOMO_SUBSCRIPTION_USER=''$/m);
  assert.match(saved, /^MIHOMO_SUBSCRIPTION_PASSWORD=''$/m);
});

test('Basic subscription temporary files are cleaned when curl fails', () => {
  const stateRoot = join(testRoot, 'fetch-basic-failure');
  mkdirSync(stateRoot, { recursive: true });
  const result = runLibrary(
    ['status'],
    String.raw`
MIHOMO_HOME="$MIHOMO_TEST_STATE_ROOT/client"
MIHOMO_SUBSCRIPTION_FILE="$MIHOMO_HOME/subscription.yaml"
MIHOMO_CONFIG_FILE="$MIHOMO_HOME/config.yaml"
mkdir -p "$MIHOMO_HOME"
curl() {
  printf '%s\n' "$@" > "$MIHOMO_TEST_STATE_ROOT/curl.argv"
  local config=""
  local output=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --config) config="$2"; shift 2 ;;
      -o) output="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf '%s\n' "$config" > "$MIHOMO_TEST_STATE_ROOT/curl-config-path"
  printf '%s\n' "$output" > "$MIHOMO_TEST_STATE_ROOT/curl-output-path"
  return 22
}
fetch_subscription 'http://example.test:3434/peer.yaml' 'failure-user' 'failure-password'
echo unreachable
`,
    { env: { MIHOMO_TEST_STATE_ROOT: stateRoot } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to fetch remote subscription/);
  assert.doesNotMatch(result.stderr, /failure-user|failure-password/);
  assert.doesNotMatch(readFileSync(join(stateRoot, 'curl.argv'), 'utf8'), /failure-user|failure-password/);
  assert.doesNotMatch(result.stdout, /unreachable/);
  const configPath = readFileSync(join(stateRoot, 'curl-config-path'), 'utf8').trim();
  const outputPath = readFileSync(join(stateRoot, 'curl-output-path'), 'utf8').trim();
  assert.equal(existsSync(configPath), false);
  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(join(stateRoot, 'client/subscription.yaml')), false);
});

test('subscription fetch without authentication does not create a curl credential config', () => {
  const stateRoot = join(testRoot, 'fetch-no-auth');
  mkdirSync(stateRoot, { recursive: true });
  const result = runLibrary(
    ['status'],
    String.raw`
MIHOMO_HOME="$MIHOMO_TEST_STATE_ROOT/client"
MIHOMO_SUBSCRIPTION_FILE="$MIHOMO_HOME/subscription.yaml"
MIHOMO_CONFIG_FILE="$MIHOMO_HOME/config.yaml"
MIHOMO_TUN_OVERLAY_FILE="$MIHOMO_HOME/tun-overlay.yaml"
mkdir -p "$MIHOMO_HOME"
curl() {
  printf '%s\n' "$@" > "$MIHOMO_TEST_STATE_ROOT/curl.argv"
  local output=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o) output="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf '%s\n' "$output" > "$MIHOMO_TEST_STATE_ROOT/curl-output-path"
  printf '%s\n' 'mixed-port: 4567' 'mode: rule' > "$output"
}
fetch_subscription 'http://example.test:3434/public.yaml' '' ''
`,
    { env: { MIHOMO_TEST_STATE_ROOT: stateRoot } },
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = readFileSync(join(stateRoot, 'curl.argv'), 'utf8');
  assert.doesNotMatch(argv, /--config|-u|--user/);
  assert.match(argv, /http:\/\/example\.test:3434\/public\.yaml/);
  const outputPath = readFileSync(join(stateRoot, 'curl-output-path'), 'utf8').trim();
  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(join(stateRoot, 'client/subscription.yaml')), true);
});
