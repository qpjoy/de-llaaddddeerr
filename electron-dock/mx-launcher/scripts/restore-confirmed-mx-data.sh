#!/usr/bin/env bash
# One-time, user-confirmed September 2026 storage cutover. Not a generic deploy.
# Keep both data trees and private backups; never replace the live etcd cluster.
set -Eeuo pipefail
umask 077
export KUBECONFIG=/etc/kubernetes/admin.conf
# All network operations here address the existing local cluster/Docker daemon.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
unset DOCKER_CONTEXT
export DOCKER_HOST=unix:///var/run/docker.sock
MX_RESTORE_NS=mx-internal-shadow
MX_RESTORE_OLD=/data/mx-runtime/mx-launcher
MX_RESTORE_NEW=/data/k8s/mx-runtime/mx-launcher
MX_RESTORE_TARGET=/var/lib/mx-launcher
MX_RESTORE_ETCD=/data/k8s/mx-runtime/etcd
MX_RESTORE_WORK=
MX_RESTORE_PHASE=preflight
fail() { echo "停止：$*" >&2; exit 1; }
mxk() { kubectl --request-timeout=20s -n "$MX_RESTORE_NS" "$@"; }
trap 'mx_status=$?; if [ "$mx_status" != 0 ]; then echo "恢复停在 $MX_RESTORE_PHASE；备份目录：${MX_RESTORE_WORK:-尚未创建}。保留现状，不要重新 deploy、改密码或删除目录。" >&2; fi' EXIT
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || fail '请在原 Linux 服务器以 root 执行。'
for mx_cmd in node kubectl docker flock findmnt mount umount cp du df sha256sum find sort xargs cmp stat grep awk tail tr mktemp systemctl sync chcon; do
  command -v "$mx_cmd" >/dev/null || fail "缺少命令：$mx_cmd"
done
exec 9>/run/mx-launcher-deploy.lock
flock -n 9 || fail '另一个 deploy/恢复正在运行。'
export MX_RESTORE_OLD MX_RESTORE_NEW MX_RESTORE_TARGET MX_RESTORE_ETCD

node <<'CHECK_SOURCE'
const fs = require('node:fs');
const id = path => { const s=fs.statSync(path); return `${s.dev}:${s.ino}`; };
const { MX_RESTORE_OLD:old, MX_RESTORE_NEW:next, MX_RESTORE_TARGET:target, MX_RESTORE_ETCD:etcd }=process.env;
if(id(old)!==id(target) || id(old)===id(next)) throw Error('挂载与已确认的旧/新目录不符；不自动继续');
const pg=next+'/k8s/postgres/pgdata';
if(id(pg)!=='66309:1084247412') throw Error('候选目录身份已变化；不自动继续');
if(fs.readFileSync(pg+'/PG_VERSION','utf8').trim()!=='16' || fs.statSync(pg+'/global/pg_control').size!==8192) throw Error('不是已确认的 PostgreSQL 16 数据');
for(const file of ['postmaster.pid','standby.signal','recovery.signal']) if(fs.existsSync(pg+'/'+file)) throw Error('候选目录存在运行/恢复标记；不删除标记');
const pgId=id(pg), etcdId=id(etcd+'/member/snap/db');
for(const pid of fs.readdirSync('/proc').filter(v=>/^\d+$/.test(v))) {
  let name; try {name=fs.readFileSync('/proc/'+pid+'/comm','utf8').trim();} catch {continue;}
  if(/^(postgres|postmaster)/.test(name)) {
    let cwd; try {cwd=id('/proc/'+pid+'/cwd');} catch(error) {if(!fs.existsSync('/proc/'+pid)) continue; throw error;}
    if(cwd===pgId) throw Error('候选 PostgreSQL 仍被使用');
  }
  if(name==='etcd') for(const fd of fs.readdirSync('/proc/'+pid+'/fd')) {
    let value; try {value=id('/proc/'+pid+'/fd/'+fd);} catch {continue;}
    if(value===etcdId) throw Error('候选 etcd 仍被使用');
  }
}
function checkLinks(path) {
  const s=fs.lstatSync(path);
  if(s.isSymbolicLink()) throw Error('PGDATA 包含符号链接，须单独保护 WAL/表空间后再恢复');
  if(s.isDirectory()) for(const entry of fs.readdirSync(path)) checkLinks(path+'/'+entry);
}
checkLinks(pg);
const rows=fs.readFileSync('/etc/fstab','utf8').split('\n').filter(line=>line.trim()&&!line.trim().startsWith('#'))
  .map(line=>line.trim().split(/\s+/)).filter(fields=>fields[1]===target);
if(rows.length!==1 || rows[0][0]!==old || !rows[0][3].split(',').includes('bind')) throw Error('fstab 与已确认配置不符');
console.log('已确认两份独立目录、候选未被已发现的 PostgreSQL/etcd 使用，且没有外部 PGDATA 链接。');
CHECK_SOURCE

MX_RESTORE_IMAGE=$(docker image inspect postgres:16-alpine --format '{{.Id}}')
MX_RESTORE_OWNER=$(stat -c '%u:%g' "$MX_RESTORE_NEW/k8s/postgres/pgdata")
MX_RESTORE_CONTROL=$(docker run --rm --pull=never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --security-opt label=disable --user "$MX_RESTORE_OWNER" \
  -e LC_ALL=C --mount "type=bind,src=$MX_RESTORE_NEW/k8s/postgres/pgdata,dst=/candidate,readonly" \
  --entrypoint pg_controldata "$MX_RESTORE_IMAGE" -D /candidate)
printf '%s\n' "$MX_RESTORE_CONTROL" | grep -Eq '^Database cluster state:[[:space:]]+shut down[[:space:]]*$' \
  || fail '候选库不是干净关闭状态；原目录未启动，须在副本中处理。'
MX_RESTORE_NEEDED=$(du -sb "$MX_RESTORE_OLD" "$MX_RESTORE_NEW" "$MX_RESTORE_ETCD" | awk '{s+=$1} END {printf "%.0f",s+4294967296}')
MX_RESTORE_FREE=$(df -B1 --output=avail /data | tail -n 1 | tr -d ' ')
[ "$MX_RESTORE_FREE" -gt "$MX_RESTORE_NEEDED" ] || fail '备份空间不足；不会自动清理数据。'
mkdir -p /data/mx-recovery
MX_RESTORE_WORK=$(mktemp -d /data/mx-recovery/confirmed-cutover.XXXXXX)
export MX_RESTORE_WORK
echo "私有备份目录：$MX_RESTORE_WORK"
docker image inspect "$MX_RESTORE_IMAGE" --format '{{json .Config}}' > "$MX_RESTORE_WORK/image.before.json"
cp -a /etc/fstab "$MX_RESTORE_WORK/fstab.before"
mxk get deployment mx-launcher-internal -o json > "$MX_RESTORE_WORK/api.before.json"
mxk get statefulset mx-internal-postgres -o json > "$MX_RESTORE_WORK/pg.before.json"
mxk get configmap mx-launcher-internal-config -o json > "$MX_RESTORE_WORK/config.before.json"
mxk get service mx-internal-postgres -o json > "$MX_RESTORE_WORK/service.before.json"
mxk get secret -o json > "$MX_RESTORE_WORK/secrets.before.json"
mxk get jobs -o json > "$MX_RESTORE_WORK/jobs.before.json"
mxk get cronjobs,hpa -o json > "$MX_RESTORE_WORK/controllers.before.json"
mxk get pvc -o json > "$MX_RESTORE_WORK/pvc.before.json"
mxk get pv -o json > "$MX_RESTORE_WORK/pv.before.json"
mxk get nodes -o json > "$MX_RESTORE_WORK/nodes.before.json"
kubectl --request-timeout=20s get pods -A -o json > "$MX_RESTORE_WORK/pods.before.json"
node - "$MX_RESTORE_WORK" <<'CHECK_WORKLOADS'
const fs=require('node:fs'), d=process.argv[2];
const get=n=>JSON.parse(fs.readFileSync(d+'/'+n+'.before.json','utf8'));
const pg=get('pg'),api=get('api'),ns='mx-internal-shadow';
if(api.spec.replicas!==1 || pg.spec.replicas!==1) throw Error('预期单副本 API/PG；不自动更改非标准副本数');
if(get('jobs').items.some(job=>(job.status?.active||0)>0)) throw Error('存在活动 Job；先核实任务状态');
if(get('controllers').items.some(x=>x.kind==='HorizontalPodAutoscaler' || x.spec.suspend!==true)) throw Error('存在自动扩缩容或未暂停的 CronJob');
const nodes=get('nodes').items;
if(nodes.length!==1 || nodes[0].metadata.name!=='mx-internal-server' || !nodes[0].status.conditions.some(x=>x.type==='Ready'&&x.status==='True')) throw Error('预期原单节点且 Ready');
const p=pg.spec.template.spec.containers.find(x=>x.name==='postgres');
if(!p || !/^(docker.io\/library\/)?postgres:16-alpine$/.test(p.image) || pg.spec.template.spec.containers.length!==1 || pg.spec.template.spec.initContainers?.length) throw Error('PostgreSQL 工作负载与预期不符');
if(p.env?.find(x=>x.name==='PGDATA')?.value!=='/var/lib/postgresql/data/pgdata') throw Error('PGDATA 路径与预期不符');
for(const [variable,key] of [['POSTGRES_USER','PG_USER'],['POSTGRES_PASSWORD','PG_PASSWORD'],['POSTGRES_DB','PG_DB']]) {
  const ref=p.env?.find(x=>x.name===variable)?.valueFrom?.secretKeyRef;
  if(ref?.name!=='mx-launcher-db'||ref.key!==key) throw Error('PostgreSQL Secret 引用与预期不符');
}
if(!p.volumeMounts?.some(x=>x.name==='postgres-data'&&x.mountPath==='/var/lib/postgresql/data'&&!x.subPath&&!x.subPathExpr)) throw Error('PGDATA 挂载与预期不符');
const claims=[['postgres-data-mx-internal-postgres-0','mx-internal-postgres-local-pv','postgres'],['mx-launcher-internal-ssh','mx-launcher-internal-ssh-local-pv','internal-ssh'],['mx-launcher-release-artifacts','mx-launcher-release-artifacts-local-pv','release-artifacts'],['mx-launcher-site-slots','mx-launcher-site-slots-local-pv','site-slots']];
for(const [claim,volume,suffix] of claims) {
  const pvc=get('pvc').items.find(x=>x.metadata.name===claim),pv=get('pv').items.find(x=>x.metadata.name===volume);
  if(!pvc||!pv||pvc.status.phase!=='Bound'||pv.status.phase!=='Bound'||pvc.spec.volumeName!==volume||pv.spec.claimRef?.uid!==pvc.metadata.uid||pv.spec.claimRef.namespace!==ns||pv.spec.claimRef.name!==claim||pv.spec.persistentVolumeReclaimPolicy!=='Retain'||pv.metadata.deletionTimestamp||pvc.metadata.deletionTimestamp||pv.spec.hostPath?.path!=='/var/lib/mx-launcher/k8s/'+suffix) throw Error('PV/PVC 绑定或数据路径不符：'+claim);
  if(!fs.statSync(process.env.MX_RESTORE_NEW+'/k8s/'+suffix).isDirectory()) throw Error('最新运行数据目录缺失：'+suffix);
}
const apiClaims=(api.spec.template.spec.volumes||[]).flatMap(x=>x.persistentVolumeClaim?[x.persistentVolumeClaim.claimName]:[]);
if(!claims.slice(1).every(([claim])=>apiClaims.includes(claim))) throw Error('API 没有使用已核对的三个数据卷');
const app=api.spec.template.spec.containers.find(x=>x.name==='internal-api');
if(!app||get('config').data?.INTERNAL_STORE_DRIVER!=='postgres'||app.env?.some(x=>['INTERNAL_STORE_DRIVER','MX_ENVIRONMENT'].includes(x.name))) throw Error('API 数据驱动/环境存在不明覆盖');
for(const key of ['DATABASE_URL','DATABASE_HOST','PG_USER','PG_PASSWORD','PG_DB']) {
  const ref=app.env?.find(x=>x.name===key)?.valueFrom?.secretKeyRef;
  if(ref?.name!=='mx-launcher-db'||ref.key!==key) throw Error('API 数据库 Secret 引用不符');
}
const data=get('secrets').items.find(x=>x.metadata.name==='mx-launcher-db')?.data||{};
const value=k=>Buffer.from(data[k]||'','base64').toString('utf8');
let url;try {url=new URL(value('DATABASE_URL'));} catch {throw Error('数据库 URL 无法校验，未输出凭据');}
const hosts=['mx-internal-postgres','mx-internal-postgres.'+ns,'mx-internal-postgres.'+ns+'.svc','mx-internal-postgres.'+ns+'.svc.cluster.local',get('service').spec.clusterIP];
if(!hosts.includes(url.hostname)||!hosts.includes(value('DATABASE_HOST'))||!['postgres:','postgresql:'].includes(url.protocol)||(url.port&&url.port!=='5432')||url.search||decodeURIComponent(url.username)!==value('PG_USER')||decodeURIComponent(url.password)!==value('PG_PASSWORD')||decodeURIComponent(url.pathname.slice(1))!==value('PG_DB')) throw Error('API 与 PostgreSQL 的数据库指向/凭据不一致，未停止服务');
for(const pod of get('pods').items) {
  if(['Succeeded','Failed'].includes(pod.status.phase)) continue;
  const touches=(pod.spec.volumes||[]).some(v=>(pod.metadata.namespace===ns&&claims.some(([c])=>c===v.persistentVolumeClaim?.claimName)) || (v.hostPath&&['/var/lib/mx-launcher','/data/mx-runtime/mx-launcher','/data/k8s/mx-runtime/mx-launcher'].some(r=>v.hostPath.path===r||v.hostPath.path.startsWith(r+'/'))));
  if(!touches) continue;
  const expected=pod.metadata.namespace===ns&&pod.spec.nodeName==='mx-internal-server'&&pod.metadata.ownerReferences?.some(o=>(o.kind==='StatefulSet'&&o.uid===pg.metadata.uid)||(o.kind==='ReplicaSet'&&pod.metadata.labels?.['app.kubernetes.io/name']==='mx-launcher-internal'));
  if(!expected) throw Error('存在其它数据卷使用者：'+pod.metadata.namespace+'/'+pod.metadata.name);
}
console.log('PV/PVC、单节点和工作负载检查通过；将在停库后补齐启动保护，现有绑定保持不变。');
CHECK_WORKLOADS

node - "$MX_RESTORE_WORK" <<'PLAN_GUARD'
const fs=require('node:fs'),d=process.argv[2];
const read=n=>JSON.parse(fs.readFileSync(d+'/'+n+'.before.json','utf8'));
const p=read('pg').spec.template.spec.containers.find(x=>x.name==='postgres'),image=read('image');
const vector=v=>v==null?[]:Array.isArray(v)&&v.every(x=>typeof x==='string')?v:(()=>{throw Error('启动命令不是合法参数数组');})();
const command=vector(p.command),args=vector(p.args);
// CRI: an explicit command replaces the image entrypoint and its default CMD.
// With no explicit command, retain the image entrypoint and selected/default args.
const original=command.length?[...command,...args]:[...vector(image.Entrypoint),...(args.length?args:vector(image.Cmd))];
if(!original.length || !original[0]) throw Error('无法确定现有启动命令；未停止服务');
const guarded={
  command:['sh','-ec','test "$(cat "$PGDATA/PG_VERSION")" = 16 && test -s "$PGDATA/global/pg_control" && test -d "$PGDATA/base" || { echo "Existing PostgreSQL 16 data missing; initialization refused" >&2; exit 1; }; exec "$@"','mx-existing-data-guard'],
  args:original
};
fs.writeFileSync(d+'/pg-guard.plan.json',JSON.stringify(guarded),{mode:0o600,flag:'wx'});
console.log('已准备启动保护：保留原启动命令和参数，此时不修改工作负载。');
PLAN_GUARD

mx_hash_tree() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum); }
mx_backup_tree() {
  local src="$1" label="$2"
  echo "备份并核验：$label"
  mx_hash_tree "$src" > "$MX_RESTORE_WORK/$label.before.sha256"
  cp -a --reflink=auto "$src" "$MX_RESTORE_WORK/$label"
  mx_hash_tree "$MX_RESTORE_WORK/$label" > "$MX_RESTORE_WORK/$label.copy.sha256"
  mx_hash_tree "$src" > "$MX_RESTORE_WORK/$label.after.sha256"
  cmp -s "$MX_RESTORE_WORK/$label.before.sha256" "$MX_RESTORE_WORK/$label.copy.sha256"
  cmp -s "$MX_RESTORE_WORK/$label.before.sha256" "$MX_RESTORE_WORK/$label.after.sha256"
  sync -f "$MX_RESTORE_WORK/$label"
}
MX_RESTORE_PHASE=backup-latest
mx_backup_tree "$MX_RESTORE_NEW" latest-mx-launcher
mx_backup_tree "$MX_RESTORE_ETCD" latest-etcd

MX_RESTORE_PHASE=pause-internal
MX_RESTORE_RUNNER_ACTIVE=0
if systemctl is-active --quiet mx-internal-host-runner.service; then
  MX_RESTORE_RUNNER_ACTIVE=1
  systemctl stop mx-internal-host-runner.service
fi
mxk scale deployment/mx-launcher-internal --current-replicas=1 --replicas=0
if [ -n "$(mxk get pod -l app.kubernetes.io/name=mx-launcher-internal -o name)" ]; then
  kubectl --request-timeout=200s -n "$MX_RESTORE_NS" wait --for=delete pod \
    -l app.kubernetes.io/name=mx-launcher-internal --timeout=180s
fi
mxk scale statefulset/mx-internal-postgres --current-replicas=1 --replicas=0
if [ -n "$(mxk get pod mx-internal-postgres-0 --ignore-not-found -o name)" ]; then
  kubectl --request-timeout=200s -n "$MX_RESTORE_NS" wait --for=delete pod/mx-internal-postgres-0 --timeout=180s
fi
[ ! -e "$MX_RESTORE_OLD/k8s/postgres/pgdata/postmaster.pid" ] || fail '原 PostgreSQL 未正常停止；不复制运行中的数据。'
MX_RESTORE_PHASE=backup-previous
mx_backup_tree "$MX_RESTORE_OLD" previous-mx-launcher

MX_RESTORE_PHASE=install-postgres-guard
node - "$MX_RESTORE_WORK" <<'INSTALL_GUARD'
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),{isDeepStrictEqual}=require('node:util'),d=process.argv[2];
const before=JSON.parse(fs.readFileSync(d+'/pg.before.json','utf8'));
const guard=JSON.parse(fs.readFileSync(d+'/pg-guard.plan.json','utf8'));
const call=args=>{
  const r=spawnSync('kubectl',['--request-timeout=20s','-n','mx-internal-shadow',...args],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
  if(r.error||r.status!==0) {
    fs.writeFileSync(d+'/pg-guard.private.log',r.stderr||'',{mode:0o600});
    throw Error('PostgreSQL 启动保护读写失败；服务保持停止，未切换挂载');
  }
  return JSON.parse(r.stdout);
};
const current=call(['get','statefulset','mx-internal-postgres','-o','json']);
const expected=JSON.parse(JSON.stringify(before.spec));expected.replicas=0;
if(current.metadata.uid!==before.metadata.uid||current.metadata.deletionTimestamp||!isDeepStrictEqual(current.spec,expected)) throw Error('StatefulSet 未停止或配置被并发更改；不覆盖');
const pods=call(['get','pods','-o','json']).items;
if(pods.some(p=>p.metadata.ownerReferences?.some(o=>o.uid===current.metadata.uid))) throw Error('PostgreSQL Pod 尚未完全退出；不修改模板');
const index=current.spec.template.spec.containers.findIndex(x=>x.name==='postgres');
const patch=[
  {op:'test',path:'/metadata/uid',value:current.metadata.uid},
  {op:'test',path:'/metadata/resourceVersion',value:current.metadata.resourceVersion},
  {op:'test',path:'/spec/replicas',value:0},
  ...Object.entries(guard).map(([key,value])=>({op:'add',path:'/spec/template/spec/containers/'+index+'/'+key,value}))
];
const path=d+'/pg-guard.patch.json';
fs.writeFileSync(path,JSON.stringify(patch),{mode:0o600,flag:'wx'});
const result=call(['patch','statefulset','mx-internal-postgres','--type=json','--patch-file',path,'-o','json']);
fs.writeFileSync(d+'/pg.guarded.json',JSON.stringify(result),{mode:0o600});
Object.assign(expected.template.spec.containers[index],guard);
if(result.metadata.uid!==before.metadata.uid||!isDeepStrictEqual(result.spec,expected)) throw Error('启动保护写后校验失败；未切换挂载');
console.log('PostgreSQL 已在零副本状态补齐启动保护，原启动参数/PVC/Secret 保留。');
INSTALL_GUARD

MX_RESTORE_PHASE=change-mount
umount "$MX_RESTORE_TARGET"
if ! mount --bind "$MX_RESTORE_NEW" "$MX_RESTORE_TARGET"; then
  mount --bind "$MX_RESTORE_OLD" "$MX_RESTORE_TARGET" || true
  fail '新挂载失败；已尝试恢复旧挂载，服务保持停止，请贴输出。'
fi
node <<'UPDATE_FSTAB'
const fs=require('node:fs');
const {MX_RESTORE_NEW:next,MX_RESTORE_TARGET:target,MX_RESTORE_WORK:work}=process.env;
const a=fs.statSync(next),b=fs.statSync(target);
if(a.dev!==b.dev||a.ino!==b.ino) throw Error('新挂载身份未通过');
const original=fs.readFileSync(work+'/fstab.before','utf8');
if(fs.readFileSync('/etc/fstab','utf8')!==original) throw Error('fstab 被并发修改，未覆盖');
const body=original.split('\n').map(line=>{
  if(line.trim().startsWith('#') || line.trim().split(/\s+/)[1]!==target) return line;
  return line.replace(/^(\s*)\S+/,(_,space)=>space+next);
}).join('\n');
const s=fs.statSync('/etc/fstab'),temp='/etc/fstab.mx-cutover-'+process.pid;
const fd=fs.openSync(temp,'wx',s.mode&0o777);
try {fs.writeFileSync(fd,body);fs.fchownSync(fd,s.uid,s.gid);fs.fchmodSync(fd,s.mode&0o777);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
fs.renameSync(temp,'/etc/fstab');
const parent=fs.openSync('/etc','r');try {fs.fsyncSync(parent);} finally {fs.closeSync(parent);}
UPDATE_FSTAB
# Preserve the original SELinux label on the replacement fstab file.
chcon --reference="$MX_RESTORE_WORK/fstab.before" /etc/fstab
systemctl daemon-reload
findmnt -T "$MX_RESTORE_TARGET" -o TARGET,SOURCE,FSTYPE

MX_RESTORE_PHASE=start-postgres
mxk scale statefulset/mx-internal-postgres --current-replicas=0 --replicas=1
kubectl --request-timeout=260s -n "$MX_RESTORE_NS" rollout status statefulset/mx-internal-postgres --timeout=240s
MX_RESTORE_PHASE=verify-business-data
if mxk exec mx-internal-postgres-0 -- sh -ec '
  unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE
  export PGPASSWORD="mx-cutover-intentionally-invalid-${POSTGRES_PASSWORD}"
  export PGCONNECT_TIMEOUT=5 PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000"
  exec psql -X -qAt -w -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"
' > "$MX_RESTORE_WORK/negative-auth.private.log" 2>&1; then
  fail '错误密码也被接受，无法证明原凭据有效；API 保持停止，不修改 pg_hba.conf。'
fi
mxk exec -i mx-internal-postgres-0 -- sh -ec '
  unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE
  export PGPASSWORD="$POSTGRES_PASSWORD"
  export PGCONNECT_TIMEOUT=5 PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000"
  exec psql -X -qAt -w -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1
' > "$MX_RESTORE_WORK/records.json" 2> "$MX_RESTORE_WORK/database-check.private.log" <<'SQL'
BEGIN READ ONLY;
SELECT coalesce(json_agg(s), '[]'::json) FROM (
  SELECT u.environment, count(*) AS users, max(u.updated_at) AS latest_user_row,
    bool_or(lower(u.data->>'account')='smh' OR lower(u.data->>'displayName')='smh') AS has_smh,
    bool_or(lower(u.data->>'account')='sqb' OR lower(u.data->>'displayName')='sqb') AS has_sqb,
    bool_or((lower(u.data->>'account')='smh' OR lower(u.data->>'displayName')='smh') AND c.id IS NOT NULL) AS smh_has_credential,
    bool_or((lower(u.data->>'account')='sqb' OR lower(u.data->>'displayName')='sqb') AND c.id IS NOT NULL) AS sqb_has_credential,
    count(*) FILTER (WHERE c.id IS NOT NULL) AS users_with_credentials
  FROM mx_platform_records u
  LEFT JOIN mx_platform_records c ON c.kind='iam-user-credential' AND c.environment=u.environment AND c.id=u.id
  WHERE u.kind='iam-user' GROUP BY u.environment
) s;
ROLLBACK;
SQL
node - "$MX_RESTORE_WORK" <<'CHECK_MARKERS'
const fs=require('node:fs'),d=process.argv[2];
const config=JSON.parse(fs.readFileSync(d+'/config.before.json','utf8'));
const rows=JSON.parse(fs.readFileSync(d+'/records.json','utf8'));
console.log(JSON.stringify(rows,null,2));
const env=config.data.MX_ENVIRONMENT||'shadow';
if(!rows.some(row=>row.environment===env&&row.has_smh&&row.has_sqb&&row.smh_has_credential&&row.sqb_has_credential)) throw Error('实际 API 环境未同时找到 SMH/SQB 及凭据；API 保持停止，未自动选择其它库');
CHECK_MARKERS

MX_RESTORE_PHASE=start-internal-api
mxk scale deployment/mx-launcher-internal --current-replicas=0 --replicas=1
kubectl --request-timeout=260s -n "$MX_RESTORE_NS" rollout status deployment/mx-launcher-internal --timeout=240s
if [ "$MX_RESTORE_RUNNER_ACTIVE" = 1 ]; then systemctl start mx-internal-host-runner.service; fi
MX_RESTORE_PHASE=complete
echo '最新业务库已挂载，SMH/SQB 已核实，Internal API 已恢复。'
echo "两份原目录都保留；备份：$MX_RESTORE_WORK"
echo '飞书/旧 Ops Token 尚需从 latest-etcd 副本恢复；恢复身份记录也须据此更新。此时不要运行 deploy。'
