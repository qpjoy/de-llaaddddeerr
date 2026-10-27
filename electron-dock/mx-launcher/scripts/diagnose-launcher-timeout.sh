#!/usr/bin/env bash
# Read-only, bounded diagnostics. Run on the named Linux host; no credentials are printed.
set -u
case "${1:-}" in
  internal|domestic) ;;
  *) echo "Usage: bash $0 internal|domestic" >&2; exit 2 ;;
esac
command -v python3 >/dev/null 2>&1 || { echo 'python3 is required' >&2; exit 2; }
exec python3 - "$1" <<'PY'
import collections
import datetime
import ipaddress
import json
import re
import subprocess
import sys
import time

role = sys.argv[1]
failures = 0
ns = 'mx-internal-shadow'
kube = ['kubectl', '--kubeconfig=/etc/kubernetes/admin.conf', '--request-timeout=8s', '-n', ns]

def emit(check, **values):
    print(json.dumps(dict(check=check, **values), ensure_ascii=False), flush=True)

def failed(check, reason):
    global failures
    failures += 1
    emit(check, status=reason)

def run(check, args, timeout=12, stdin=None, include_stderr=False):
    try:
        result = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        failed(check, 'command-not-found')
        return None
    except OSError:
        failed(check, 'command-unavailable')
        return None
    except subprocess.TimeoutExpired:
        failed(check, 'command-timeout')
        return None
    if result.returncode:
        # Never print raw stderr: kubectl, curl and logs can contain private data.
        failed(check, 'command-exit-' + str(result.returncode))
        return None
    return result.stdout + (result.stderr if include_stderr else '')

def json_command(check, args):
    output = run(check, args)
    if output is None:
        return None
    try:
        return json.loads(output)
    except ValueError:
        failed(check, 'invalid-json')
        return None

def http(check, url, host=None, real_ip=False):
    args = ['curl', '--noproxy', '*', '--connect-timeout', '3', '--max-time', '8',
            '-sS', '-o', '/dev/null', '-w',
            '{"http_code":"%{http_code}","connect_s":%{time_connect},"ttfb_s":%{time_starttransfer},"total_s":%{time_total}}']
    if host:
        args += ['-H', 'Host: ' + host]
    if real_ip:
        args += ['-H', 'X-Real-IP: 10.88.0.1']
    # curl still writes timings on many failures, including its 8 s timeout.
    try:
        result = subprocess.run(args + [url], capture_output=True, text=True, timeout=12)
    except FileNotFoundError:
        failed(check, 'command-not-found')
        return
    except OSError:
        failed(check, 'command-unavailable')
        return
    except subprocess.TimeoutExpired:
        failed(check, 'command-timeout')
        return
    if result.returncode:
        failed(check, 'curl-exit-' + str(result.returncode))
    try:
        value = json.loads(result.stdout)
        emit(check, command_exit=result.returncode,
             **{k: value.get(k) for k in ('http_code', 'connect_s', 'ttfb_s', 'total_s')})
    except (ValueError, AttributeError):
        failed(check, 'invalid-curl-timings')

def location():
    hostname = run('hostname', ['hostname'], timeout=5)
    if hostname is not None:
        emit('hostname', hostname=hostname.strip())
    routes = json_command('route-to-internal', ['ip', '-j', 'route', 'get', '10.88.88.88'])
    if isinstance(routes, list):
        emit('route-to-internal', routes=[{k: route.get(k) for k in
             ('type', 'dst', 'gateway', 'dev', 'prefsrc', 'table')} for route in routes])

def wireguard():
    outputs = {kind: run('wg-' + kind, ['wg', 'show', 'all', kind])
               for kind in ('allowed-ips', 'latest-handshakes', 'transfer')}
    if any(value is None for value in outputs.values()):
        return
    target = ipaddress.ip_address('10.88.88.88')
    peers = set()
    for line in outputs['allowed-ips'].splitlines():
        row = line.split()
        for cidr in ' '.join(row[2:]).replace(',', ' ').split():
            try:
                if target in ipaddress.ip_network(cidr, strict=False):
                    peers.add(tuple(row[:2]))
            except ValueError:
                pass
    ages, rx, tx = [], 0, 0
    try:
        for line in outputs['latest-handshakes'].splitlines():
            row = line.split()
            if tuple(row[:2]) in peers:
                ages.append(int(time.time()) - int(row[2]) if int(row[2]) else None)
        for line in outputs['transfer'].splitlines():
            row = line.split()
            if tuple(row[:2]) in peers:
                rx += int(row[2])
                tx += int(row[3])
    except (ValueError, IndexError):
        failed('wg-internal', 'invalid-output')
        return
    # Keys, endpoint addresses and all other peers remain private.
    emit('wg-internal', matching_peers=len(peers), handshake_age_s=ages,
         rx_bytes_total=rx, tx_bytes_total=tx)

def domestic():
    http('internal-nginx', 'http://10.88.88.88/admin/', 'launcher.minsight-ai.com', True)
    http('identity-18444', 'http://10.88.88.88:18444/healthz', 'auth.minsight-ai.com')
    start = time.monotonic()
    output = run('nginx-container-upstream', ['docker', 'exec', 'compass-gateway-nginx-1',
        'wget', '-q', '-T', '8', '-O', '/dev/null', '--header=Host: launcher.minsight-ai.com',
        '--header=X-Real-IP: 10.88.0.1', 'http://10.88.88.88/admin/'])
    emit('nginx-container-upstream-timing', success=output is not None,
         elapsed_s=round(time.monotonic() - start, 3))
    logs = run('nginx-errors', ['docker', 'logs', '--since', '15m', '--tail', '3000',
                              'compass-gateway-nginx-1'], include_stderr=True)
    if logs is not None:
        counts = collections.Counter()
        for line in logs.splitlines():
            if 'server: launcher.minsight-ai.com' not in line:
                continue
            kind = next((s for s in ('upstream timed out', 'connect() failed', 'no live upstreams',
                'upstream prematurely closed connection') if s in line), None)
            if kind:
                stage = next((s for s in ('while connecting to upstream',
                    'while reading response header from upstream', 'while sending request to upstream')
                    if s in line), 'other')
                origin = 'unavailable'
                match = re.search(r'upstream: "(https?)://([0-9.]+)(?::([0-9]+))?(?:/|")', line)
                if match:
                    try:
                        address = str(ipaddress.IPv4Address(match[2]))
                        port = int(match[3] or (443 if match[1] == 'https' else 80))
                        if 0 < port < 65536:
                            origin = '{}://{}:{}'.format(match[1], address, port)
                    except ValueError:
                        pass
                counts[(kind, stage, origin)] += 1
        emit('nginx-errors', window='15m, at most 3000 lines',
             counts=[dict(kind=k, stage=s, upstream_origin=o, count=n) for (k, s, o), n in counts.items()],
             note='No matching errors does not prove health; raw logs are never printed.')
    wireguard()

def internal():
    pods = json_command('pods', kube + ['get', 'pods', '-o', 'json'])
    api_ips, api_names = [], []
    if isinstance(pods, dict):
        for pod in pods.get('items', []):
            name = pod.get('metadata', {}).get('name', '')
            if not name.startswith(('mx-launcher-internal-', 'mx-identity-', 'mx-internal-postgres-',
                                    'mx-internal-gateway-', 'mx-internal-coredns-')):
                continue
            status = pod.get('status', {})
            containers = status.get('containerStatuses', [])
            ready = next((c.get('status') for c in status.get('conditions', []) if c.get('type') == 'Ready'), 'Unknown')
            emit('pod', name=name, phase=status.get('phase'), ready=ready, ip=status.get('podIP'),
                 containers=[dict({k: c.get(k) for k in ('name', 'image', 'ready', 'restartCount')},
                    last_termination={k: c.get('lastState', {}).get('terminated', {}).get(k)
                    for k in ('reason', 'exitCode', 'finishedAt')}) for c in containers])
            if name.startswith('mx-launcher-internal-') and status.get('phase') == 'Running':
                if any(c.get('name') == 'internal-api' and c.get('restartCount', 0) > 0 for c in containers):
                    api_names.append(name)
                else:
                    emit('api-previous-log', pod=name, status='skipped-no-restarts')
                try:
                    api_ips.append(str(ipaddress.ip_address(status.get('podIP', ''))))
                except ValueError:
                    pass
    for name in ('mx-launcher-internal', 'mx-internal-postgres'):
        service = json_command('service-' + name, kube + ['get', 'service', name, '-o', 'json'])
        if isinstance(service, dict):
            spec = service.get('spec', {})
            emit('service', name=name, clusterIP=spec.get('clusterIP'), ports=spec.get('ports', []))
        slices = json_command('endpoints-' + name, kube + ['get', 'endpointslices', '-l',
                              'kubernetes.io/service-name=' + name, '-o', 'json'])
        if isinstance(slices, dict):
            emit('endpoints', service=name, slices=[dict(name=s.get('metadata', {}).get('name'),
                 ports=s.get('ports'), endpoints=[dict(addresses=e.get('addresses'), conditions=e.get('conditions'))
                 for e in s.get('endpoints', [])]) for s in slices.get('items', [])])
    for path in ('healthz', 'readyz', 'admin/'):
        http('gateway-18090-' + path, 'http://127.0.0.1:18090/' + path)
    http('identity-18444', 'http://10.88.88.88:18444/healthz', 'auth.minsight-ai.com')
    for ip in sorted(set(api_ips))[:2]:
        authority = '[' + ip + ']' if ':' in ip else ip
        for path in ('healthz', 'admin/'):
            http('api-pod-' + ip + '-' + path, 'http://' + authority + ':18090/' + path)
    for name in sorted(api_names)[:2]:
        logs = run('api-previous-log-' + name, kube + ['logs', name, '-c', 'internal-api',
                   '--previous', '--tail=200', '--since=1h'])
        if logs is not None:
            patterns = {'expired_handover': r'reconcileExpiredHandovers|runExpiredHandoverReconciliation',
                        'oom': r'\bOOM\b|out of memory|OOMKilled',
                        'connection': r'ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection (?:timeout|terminated)|too many clients|remaining connection slots'}
            emit('api-previous-log', pod=name, window='1h, at most 200 lines',
                 counts={key: sum(bool(re.search(pattern, line, re.I)) for line in logs.splitlines())
                         for key, pattern in patterns.items()})
    sql = """BEGIN READ ONLY;
SET LOCAL statement_timeout = '3s';
SET LOCAL lock_timeout = '1s';
SELECT json_build_object('state',state,'wait_event_type',wait_event_type,'wait_event',wait_event,'count',count(*))
FROM pg_stat_activity WHERE pid <> pg_backend_pid() GROUP BY state,wait_event_type,wait_event;
COMMIT;
"""
    pg = run('pg-waits', kube + ['exec', '-i', 'mx-internal-postgres-0', '--', 'sh', '-c',
        'PGCONNECT_TIMEOUT=3 PGOPTIONS="-c statement_timeout=3000 -c default_transaction_read_only=on" '
        'psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'], stdin=sql)
    if pg is not None:
        try:
            rows = [json.loads(line) for line in pg.splitlines() if line.strip()]
            emit('pg-waits', groups=[{k: row.get(k) for k in ('state', 'wait_event_type', 'wait_event', 'count')} for row in rows])
        except (ValueError, AttributeError):
            failed('pg-waits', 'invalid-output')
    for check, args in (('iostat-first-report-since-boot', ['iostat', '-xz', '1', '3']),
                        ('vmstat-first-report-since-boot', ['vmstat', '1', '3']),
                        ('disk-space', ['df', '-h', '/', '/data', '/var/lib/etcd'])):
        output = run(check, args)
        if output is not None:
            emit(check, output=output.strip())
    kernel = run('kernel-errors', ['journalctl', '-k', '--since=-30 min', '-n', '1000',
                                  '--no-pager', '--output=short-iso'])
    if kernel is not None:
        patterns = {'nvme_timeout': r'nvme.*timeout', 'nvme_abort': r'nvme.*abort',
                    'nvme_reset': r'nvme.*reset', 'io_error': r'I/O error',
                    'hung_task': r'blocked for more than|hung task', 'xfs_error': r'XFS.*error'}
        emit('kernel-errors', window='30m, at most 1000 lines',
             counts={key: sum(bool(re.search(pattern, line, re.I)) for line in kernel.splitlines())
                     for key, pattern in patterns.items()})

emit('start', role=role, utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
     read_only=True, note='Role is user-selected, not host verification. HTTP codes alone do not establish the cause. Missing checks continue.')
location()
if role == 'internal':
    internal()
else:
    domestic()
emit('complete', failed_checks=failures, note='This is a bounded snapshot, not a recovery or user-login acceptance test.')
PY
