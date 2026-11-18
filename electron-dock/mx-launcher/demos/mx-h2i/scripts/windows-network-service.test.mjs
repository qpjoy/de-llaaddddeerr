import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { installDirectoryCommand } from './build-windows-network-service.mjs';
const require = createRequire(import.meta.url);
const workerRequire = createRequire(new URL('../native/windows-network-worker.cjs', import.meta.url));
const { legacyHdoCleanupScript } = require('../native/windows-legacy-hdo.cjs');
const { createWindowsNetworkService } = require('../src/windows-network-service.cjs');
const pluginRequire = createRequire(new URL('../../../../../electron-plugin/packages/electron-plugin-tunnel/package.json', import.meta.url));
const workerModule = { exports: {} };
new Function('require', 'module', 'exports', await readFile(new URL('../native/windows-network-worker.cjs', import.meta.url), 'utf8'))(
  name => name === 'yaml' ? pluginRequire('yaml') : name === '@qpjoy/electron-core-wireguard' ? {} : workerRequire(name), workerModule, workerModule.exports,
);
const { validateWireGuardConfig, safeMihomoConfig, assertOwner, validateAPI } = workerModule.exports;
const SID = 'S-1-5-21-42';
const wireguard = `[Interface]\nAddress = 10.88.1.3/32\nPrivateKey = ${Buffer.alloc(32,1).toString('base64')}\n# HDO DNS Servers = 10.88.0.1\n# HDO DNS Domains = .mxinfo-inc.cn\n# HDO Route Priority CIDRs = 10.88.0.0/16\n[Peer]\nPublicKey = ${Buffer.alloc(32,2).toString('base64')}\nAllowedIPs = 10.88.0.0/16\nEndpoint = office.example.com:51820\nPersistentKeepalive = 25\n`;
const YAML = pluginRequire('yaml');
const proxy = { 'mixed-port':17890, 'external-controller':'127.0.0.1:19090', dns:{listen:'0.0.0.0:15353',nameserver:['https://dns.alidns.com/dns-query']},tun:{stack:'mixed'},proxies:[], 'proxy-groups':[],rules:['MATCH,DIRECT'] };

test('installer embeds its directory validator without treating the selected path as PowerShell code', async () => {
  const script = await readFile(new URL('../build/prepare-install-directory.ps1', import.meta.url), 'utf8');
  const encoded = installDirectoryCommand(script);
  assert.equal(gunzipSync(Buffer.from(encoded.script, 'base64')).toString('utf8'), script);
  const command = Buffer.from(encoded.command, 'base64').toString('utf16le');
  assert.match(command, /FromBase64String\(\$env:MINCAVE_INSTALL_DIRECTORY_SCRIPT\)/);
  assert.doesNotMatch(command, /\$INSTDIR/);
  assert.ok(encoded.command.length < 7400 && encoded.script.length < 7400);
});

test('legacy HDO repair requires a matching account and live collision before stopping or removing rules', { skip: process.platform !== 'win32' }, () => {
  const { execFileSync } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const script = legacyHdoCleanupScript(SID).replace('Global\\QPJoy.MXLauncher.NRPT.v1', 'Local\\MinCaveTest.' + randomUUID());
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const fixture = String.raw`
$root = 'C:\Users\Test\AppData\Roaming\罗盘AI情报系统\plugin-data\qpjoy.electron-plugin-hdo'
$correct = '"{0}\bin\wireguard.exe" /tunnelservice "{0}\wireguard\hdo-client.conf"' -f $root
$script:hdo = 'MX HDO / QPJoy HDO hdo-client'
$script:mx = 'MX-H2I / QPJoy MX-H2I mx-h2i'
function Rule($name, $owner, $namespace, $server) {
  [pscustomobject]@{Name=$name;Comment=$owner;DisplayName=$owner;Namespace=@($namespace);NameServers=@([ipaddress]$server)}
}
function Get-ItemProperty { param($LiteralPath) [pscustomobject]@{ProfileImagePath='C:\Users\Test'} }
function Get-CimInstance { param($ClassName,$Filter) [pscustomobject]@{PathName=$script:registered} }
function Get-DnsClientNrptRule { $script:rules }
function Get-Service {
  param($Name,$ErrorAction)
  $status = if ($Name -eq 'WireGuardTunnel$mx-h2i') { $script:mincaveStatus } else { $script:serviceStatus }
  [pscustomobject]@{Status=$status}
}
function Stop-Service { param($InputObject) $script:events.Add('stop'); $script:serviceStatus='Stopped' }
function Remove-DnsClientNrptRule { param($Name,[switch]$Force) $script:events.Add($Name) }
function Export-Clixml {
  param([Parameter(ValueFromPipeline=$true)]$InputObject,$LiteralPath)
  begin { $script:events.Add('backup') }
  process {}
}
$cleanup = [scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')))
foreach ($scenario in @('wrong-account','mincave-down','no-conflict','confirmed')) {
  $script:events = [Collections.Generic.List[string]]::new()
  $script:serviceStatus = 'Running'
  $script:mincaveStatus = if ($scenario -eq 'mincave-down') { 'Stopped' } else { 'Running' }
  $script:registered = if ($scenario -eq 'wrong-account') { $correct.Replace('C:\Users\Test\','C:\Users\Other\') } else { $correct }
  $script:rules = @(
    (Rule 'overlap' $script:hdo 'mxinfo-inc.cn' '100.88.0.1')
    (Rule 'subdomain' $script:hdo 'hr.mxinfo-inc.cn' '100.88.0.1')
    (Rule 'other' 'Another VPN' 'mxinfo-inc.cn' '100.88.0.1')
  )
  if ($scenario -ne 'no-conflict') { $script:rules += Rule 'mincave' $script:mx 'mxinfo-inc.cn' '10.88.0.1' }
  & $cleanup
  [Console]::Write('|' + ($script:events -join ',') + '|')
}
`;
  const powershell = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const actual = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixture, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(actual, 'failed:verify||no-conflict||no-conflict||cleaned|backup,stop,subdomain,overlap|');
});

test('Windows installation ACL policy accepts safe secondary-drive paths and rejects replaceable parents', { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = require('node:child_process');
  const script = await readFile(new URL('../build/prepare-install-directory.ps1', import.meta.url), 'utf8');
  // Execute the exact installer functions against a deterministic in-memory
  // filesystem/ACL fixture. No real services, folders or permissions change.
  const scenario = `
$script:itemAttributes=[IO.FileAttributes]::Directory
function Get-Item { param($LiteralPath, [switch]$Force) [pscustomobject]@{Attributes=$script:itemAttributes;PSIsContainer=$false} }
function Get-Acl { param($LiteralPath)
  $sddl = if ($LiteralPath -eq 'D:\\Apps') { $script:parentAcl } else { 'O:BAG:BAD:P(A;;FA;;;BA)(A;;GRGX;;;BU)' }
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetSecurityDescriptorSddlForm($sddl);return $acl
}
foreach($sddl in @('O:BAG:BAD:(A;;FA;;;BA)(A;;0x4;;;AU)','O:BAG:BAD:(A;;FA;;;BA)(A;;0x4;;;AU)(A;OICIIO;FA;;;CO)')) {
  $script:parentAcl=$sddl
  Assert-InstallAcl 'D:\\Apps' $true
}
Assert-InstallTree 'D:\\Apps\\MinCave'
$script:itemAttributes=[IO.FileAttributes]([int][IO.FileAttributes]::Directory -bor [int][IO.FileAttributes]::ReparsePoint)
$rejected=$false
try { Assert-InstallAcl 'D:\\Apps\\link' $false } catch {
  if($_.Exception.Message -ne 'Links and junctions are not supported.'){throw}
  $rejected=$true
}
if(-not $rejected){throw 'Reparse-point attributes accepted'}
$script:itemAttributes=[IO.FileAttributes]::Directory
foreach($sddl in @('O:BAG:BAD:(A;;FA;;;BA)(A;;0x40;;;BU)','O:BAG:BAD:(A;;FA;;;BA)(A;;0x100;;;BU)','O:S-1-5-21-1-2-3-1000G:BAD:(A;;FA;;;BA)')) {
  $script:parentAcl=$sddl;$rejected=$false
  try { Assert-InstallAcl 'D:\\Apps' $true } catch { $rejected=$true }
  if(-not $rejected){throw 'Unsafe parent accepted'}
}
foreach($value in @('\\\\server\\share\\MinCave','D:\\','D:\\Apps.\\MinCave','D:\\Apps\\..\\MinCave','D:\\Apps\\NUL')) {
  $rejected=$false;try { Prepare-MinCaveDirectory $value } catch { $rejected=$true }
  if(-not $rejected){throw 'Unsafe path accepted'}
}
[Console]::Out.Write('directory-policy-ok')
`;
  const source = script + '\n' + scenario;
  const env = { ...process.env };
  delete env.MINCAVE_INSTALL_DIRECTORY;
  let result;
  try {
    result = execFileSync(path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // execFileSync's default message includes the entire encoded script.
    // Preserve the actual failure without flooding the packaging log.
    throw new Error(`Windows PowerShell installation ACL policy failed (exit ${error.status ?? error.code}):\n${String(error.stderr || error.stdout || '').slice(-6000)}`);
  }
  assert.equal(result, 'directory-policy-ok');
});

test('privileged profiles allow office networks but reject hooks, default routes and public NRPT', () => {
  assert.match(validateWireGuardConfig(wireguard), /DNS Domains = mxinfo-inc.cn/);
  assert.match(validateWireGuardConfig(wireguard.replaceAll('10.88.0.0/16','100.88.0.0/16')), /100.88/);
  for (const value of [wireguard+'PostUp = calc.exe\n', wireguard.replace('AllowedIPs = 10.88.0.0/16','AllowedIPs = 0.0.0.0/0'),wireguard.replace('.mxinfo-inc.cn','.minsight-ai.com'),wireguard.replace('10.88.0.1','8.8.8.8'),wireguard.replace('10.88.0.0/16','192.168.0.0/16'), wireguard.replace('[Peer]','PrivateKey = '+Buffer.alloc(32,3).toString('base64')+'\n[Peer]')]) assert.throws(() => validateWireGuardConfig(value));
  assert.throws(() => assertOwner({ownerSID:SID},'S-1-5-21-99'), /另一 Windows/);
  assert.doesNotThrow(() => assertOwner({ownerSID:SID},SID));
});

test('service accepts generated employee profiles across the existing office and legacy networks', () => {
  const core = require('../../../../../electron-plugin/packages/electron-core-wireguard/dist/index.js');
  // Synthetic keys and endpoints, with the same lease/route shape as the
  // production launcher. No credentials or diagnostic bundle are embedded.
  for (const network of ['10.88', '10.89', '10.90', '100.88', '100.89', '100.90', '100.91']) {
    const config = core.renderWireGuardInterface({
      addresses: [`${network}.50.8/32`],
      privateKey: Buffer.alloc(32, 1).toString('base64'),
      hdoDnsServers: ['10.88.0.1'],
      hdoDnsDomains: ['mxinfo-inc.cn'],
      hdoRoutePriorityCidrs: [`${network}.0.0/16`, '10.88.88.88/32'],
      peers: [{
        publicKey: Buffer.alloc(32, 2).toString('base64'),
        endpoint: 'office.example.com:51280',
        allowedIps: [`${network}.0.0/16`, '10.88.100.1/32', '10.88.88.88/32', '10.88.0.1/32'],
        persistentKeepalive: 25,
      }],
    });
    const validated = validateWireGuardConfig(config);
    assert.ok(validated.includes(`Address = ${network}.50.8/32`));
    assert.ok(validated.includes(`AllowedIPs = ${network}.0.0/16, 10.88.100.1/32, 10.88.88.88/32, 10.88.0.1/32`));
  }
});

test('service accepts the launcher default split DNS domains without permitting public suffixes', async () => {
  const runtimeSource = await readFile(new URL('../src/main-runtime.cjs', import.meta.url), 'utf8');
  const defaults = /const DEFAULT_SPLIT_DNS_DOMAINS = '([^']+)';/.exec(runtimeSource)?.[1].split(' ');
  assert.ok(defaults?.length, 'use the real launcher defaults to catch policy drift');
  const config = wireguard.replace('.mxinfo-inc.cn', defaults.map(domain => '.' + domain).join(', '));
  assert.ok(validateWireGuardConfig(config).includes(`DNS Domains = ${defaults.join(', ')}`));
  assert.match(validateWireGuardConfig(wireguard.replace('.mxinfo-inc.cn', '.Data.MXINFO-INC.CN')), /DNS Domains = data.mxinfo-inc.cn/);
  for (const domain of ['cn', 'mx', 'com', 'minsight-ai.com', 'evil-mxinfo-inc.cn', 'mxinfo-inc.cn.evil.com']) {
    assert.throws(() => validateWireGuardConfig(wireguard.replace('.mxinfo-inc.cn', domain)));
  }
});

test('office profile policy still refuses adjacent networks, broad routes, public DNS and hooks', () => {
  for (const network of ['10.87', '10.91', '10.255', '100.87', '100.92', '192.168']) {
    assert.throws(() => validateWireGuardConfig(wireguard.replaceAll('10.88', network)));
  }
  for (const cidr of ['0.0.0.0/0', '10.0.0.0/8', '10.88.0.0/15', '10.89.0.0/15', '::/0']) {
    assert.throws(() => validateWireGuardConfig(wireguard.replace('AllowedIPs = 10.88.0.0/16', `AllowedIPs = ${cidr}`)));
  }
  assert.throws(() => validateWireGuardConfig(wireguard.replace('DNS Servers = 10.88.0.1', 'DNS Servers = 8.8.8.8')));
  assert.throws(() => validateWireGuardConfig(wireguard + 'PostUp = calc.exe\n'));
});

test('TUN reconstructs loopback listeners, secret and provider paths and rejects file access and cycles', () => {
  const raw = structuredClone(proxy);
  raw['allow-lan']=true;raw.secret='client-secret';raw.tun.device='attacker';
  raw['proxy-providers']={overseas:{type:'http',url:'https://example.com/subscription',path:'C:\\Windows\\system.ini'}};
  const result = YAML.parse(safeMihomoConfig(YAML.stringify(raw),'C:\\ProgramData\\MinCave\\mihomo','server-secret').yaml);
  assert.equal(result.secret,'server-secret');assert.equal(result['allow-lan'],false);assert.equal(result.dns.listen,'127.0.0.1:15353');assert.equal(result.tun.device,'MinCave-TUN');
  assert.notEqual(result['proxy-providers'].overseas.path,raw['proxy-providers'].overseas.path);
  for(const overrides of [
    {proxies:[{type:'ss',name:'bad','client-key':'C:\\private.key'}]},
    {proxies:[{type:'ssh',name:'bad'}]},
    {'proxy-providers':{bad:{type:'file',path:'C:\\Windows\\system.ini'}}},
    {'proxy-providers':{bad:{type:'http',url:'file:///C:/secret'}}},
    {proxies:[{name:'bad',payload:{script:'calc.exe'}}]},
  ]) assert.throws(() => safeMihomoConfig(YAML.stringify({...proxy,...overrides}),'/safe','secret'));
  assert.throws(() => safeMihomoConfig(YAML.stringify(proxy)+'\nproxies: &loop [*loop]\n','/safe','secret'));
  assert.throws(() => safeMihomoConfig(YAML.stringify({...proxy,proxies:[JSON.parse('{"__proto__":{"path":"secret"}}')]}),'/safe','secret'));
  assert.throws(() => validateAPI({method:'PUT',path:'/proxies/%2e%2e',body:{name:'x'}}));
  assert.throws(() => validateAPI({method:'PUT',path:'/proxies/%2fconfigs',body:{name:'x'}}));
  assert.throws(() => validateAPI({method:'PUT',path:'/configs',body:{path:'C:/x'}}));
  assert.deepEqual(validateAPI({method:'PUT',path:'/proxies/%E6%B5%B7%E5%A4%96',body:{name:'one'}}),{method:'PUT',endpoint:'/proxies/%E6%B5%B7%E5%A4%96'});
});

async function fixture(t, {forged=false,wrongSID=false,tamper=false}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'mincave-service-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'network-service'));
  const identity=crypto.generateKeyPairSync('ed25519');
  await writeFile(path.join(root,'network-service','identity.json'),JSON.stringify({protocol:1,publicKey:identity.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')}));
  const requests=[];const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let buffer='',shared;
    socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){
      const incoming=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(!shared){
        const ephemeral=crypto.generateKeyPairSync('x25519');
        const response={protocol:1,version:'1.0.0',ownerSID:wrongSID?'S-1-5-21-99':SID,key:ephemeral.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')};
        response.signature=crypto.sign(null,Buffer.from(`mincave-network/v1\n${incoming.nonce}\n${incoming.key}\n${response.key}\n${response.ownerSID}\n${response.version}`),forged?crypto.generateKeyPairSync('ed25519').privateKey:identity.privateKey).toString('base64');
        const peer=crypto.createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),Buffer.from(incoming.key,'base64')])});
        shared=crypto.createHash('sha256').update(crypto.diffieHellman({privateKey:ephemeral.privateKey,publicKey:peer})).update(Buffer.from(incoming.nonce,'base64')).digest();
        socket.write(JSON.stringify(response)+'\n');
      }else{
        const data=Buffer.from(incoming.data,'base64');const decipher=crypto.createDecipheriv('aes-256-gcm',shared,Buffer.from(incoming.nonce,'base64'));
        decipher.setAAD(Buffer.from('mincave-request/v1'));decipher.setAuthTag(data.subarray(-16));
        requests.push(JSON.parse(Buffer.concat([decipher.update(data.subarray(0,-16)),decipher.final()])));
        const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',shared,iv);cipher.setAAD(Buffer.from('mincave-response/v1'));
        const value=requests.at(-1).operation==='capabilities'?{protocol:1,capabilities:['wireguard']}:{ok:true};
        const encrypted=Buffer.concat([cipher.update(JSON.stringify({ok:true,value})),cipher.final(),cipher.getAuthTag()]);if(tamper)encrypted[0]^=1;
        socket.write(JSON.stringify({nonce:iv.toString('base64'),data:encrypted.toString('base64')})+'\n');
      }
    }});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return {root,requests,client:createWindowsNetworkService({resourcesPath:root,currentSID:()=>SID,connect:()=>net.createConnection(server.address().port,'127.0.0.1')})};
}

test('client authenticates service and encrypts structured requests without an executable path',async t=>{
  const {client,requests}=await fixture(t);
  await client.ensureAvailable();await client.tunnel({action:'up',config:wireguard});
  assert.equal(requests[1].operation,'wireguard');assert.deepEqual(Object.keys(requests[1].input),['action','config']);assert.equal(requests[1].input.config,wireguard);
});
for(const [name,options] of [['forged identity',{forged:true}],['different Windows SID',{wrongSID:true}],['modified ciphertext',{tamper:true}]]){
 test(`client rejects ${name} without retrying a mutation`,async t=>{
   const {client,requests}=await fixture(t,options);
   await assert.rejects(client.tunnel({action:'up',config:wireguard}),e=>e.mincaveServiceError&&e.code==='mincave_windows_service_untrusted');
   assert.equal(requests.length,options.tamper?1:0);
 });
}
test('missing full installation fails before opening IPC; no interactive elevation fallback', async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mincave-no-service-'));t.after(()=>rm(root,{recursive:true,force:true}));let connections=0;
  const client=createWindowsNetworkService({resourcesPath:root,connect:()=>{connections++;throw Error('must not run');},currentSID:()=>SID});
  await assert.rejects(client.ensureAvailable(),e=>e.code==='mincave_windows_service_required');assert.equal(connections,0);
});

test('Launcher delegates every Windows tunnel operation and never retries through legacy elevation', async () => {
  const uiRequire=createRequire(new URL('../ui/package.json',import.meta.url));
  const {transform}=createRequire(uiRequire.resolve('vite'))('esbuild');
  const source=await readFile(new URL('../../../packages/electron-launcher/src/wireguard.ts',import.meta.url),'utf8');
  const compiled=await transform(source+'\nexport {runLauncherWireGuardCommand as serviceExecutor};',{loader:'ts',format:'cjs',target:'node20'});
  const calls=[];let legacyCalls=0;
  const compiledModule={exports:{}};
  new Function('require','module','exports',compiled.code)(name=>{
    if(name==='@qpjoy/electron-core-wireguard')return {setWireGuardTunnelState:async()=>{legacyCalls++;return {ok:true};}};
    if(name.startsWith('@qpjoy/')||name.startsWith('./'))return {};
    return require(name);
  },compiledModule,compiledModule.exports);
  const directory=await mkdtemp(path.join(os.tmpdir(),'mincave-launcher-service-'));
  try{
    const profile=path.join(directory,'mx-h2i.conf');await writeFile(profile,wireguard);
    const input={windowsNetworkService:{tunnel:async value=>{calls.push(value);return {ok:true};}}};
    for(const action of ['up','down','restart','repair']){
      const result=await compiledModule.exports.serviceExecutor(input,{runtime:{platform:'win32',method:'windows-service'},configPath:profile,action});assert.equal(result.ok,true);
    }
    assert.deepEqual(calls.map(v=>v.action),['up','down','restart','repair']);assert.equal(legacyCalls,0);
    input.windowsNetworkService.tunnel=async()=>{throw Error('service unavailable');};
    assert.equal((await compiledModule.exports.serviceExecutor(input,{runtime:{platform:'win32',method:'windows-service'},configPath:profile,action:'up'})).ok,false);
    assert.equal(legacyCalls,0);
    await compiledModule.exports.serviceExecutor(input,{runtime:{platform:'darwin',method:'darwin-userspace'},configPath:profile,action:'up'});
    assert.equal(legacyCalls,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('the existing runtime renderer produces a usable service TUN profile with corporate bypass rules', () => {
  const {renderRuntimeConfig}=pluginRequire('@qpjoy/electron-core-mihomo');
  for(const useGeoRules of [false,true]){
    const rendered=renderRuntimeConfig({baseYaml:'proxies: []\nproxy-groups: []\n',settings:{mode:'system-tun',tunInstalled:true,controllerSecret:'user-secret',ports:{mixed:17890,controller:19090,dns:15353,admin:17891}},rules:[],platform:'win32',useGeoRules,directDomains:['mxinfo-inc.cn'],directIps:['10.88.0.0/16']});
    const safe=YAML.parse(safeMihomoConfig(rendered.yaml,'/protected','service-secret').yaml);
    assert.equal(safe.tun.enable,true);assert.equal(safe.secret,'service-secret');
    assert.ok(safe.rules.includes('IP-CIDR,10.88.0.0/16,DIRECT,no-resolve'));
    assert.ok(safe.rules.includes('DOMAIN-SUFFIX,mxinfo-inc.cn,DIRECT'));
  }
});

test('Mihomo lifecycle and controller calls use the installed service without an elevated process fallback', async () => {
  const uiRequire=createRequire(new URL('../ui/package.json',import.meta.url));
  const {transform}=createRequire(uiRequire.resolve('vite'))('esbuild');
  const source=await readFile(new URL('../../../../../electron-plugin/packages/electron-plugin-tunnel/src/mihomo/MihomoManager.ts',import.meta.url),'utf8');
  const compiled=await transform(source,{loader:'ts',format:'cjs',target:'node20'});
  const module={exports:{}};let spawned=0;
  const fakeProcess={platform:'win32',getuid:()=>1000,kill:()=>{}};
  new Function('require','module','exports','process',compiled.code)(name=>{
    if(name==='child_process')return {spawn(){spawned++;throw Error('legacy elevation must not execute');}};
    if(name==='@qpjoy/electron-core-mihomo')return pluginRequire(name);
    if(name.startsWith('../')||name.startsWith('./'))return {};
    return require(name);
  },module,module.exports,fakeProcess);
  const methods=module.exports.MihomoManager.prototype;
  const directory=await mkdtemp(path.join(os.tmpdir(),'mincave-tun-service-'));
  try{
    const configPath=path.join(directory,'config.yaml');await writeFile(configPath,YAML.stringify(proxy));
    const calls=[];
    const runtime={start:async config=>{calls.push(['start',config]);return {running:true,pid:77};},status:async()=>({running:true,pid:77}),stop:async()=>{calls.push(['stop']);}};
    const context={options:{windowsPrivilegedRuntime:runtime},serviceManaged:false,rememberElevatedPid(pid){this.pid=pid;},clearElevatedPid(){this.pid=null;},readElevatedPid(){return this.pid;},log(){}};
    await methods.startElevatedWindows.call(context,'untrusted-core-path',configPath);
    assert.equal(context.pid,77);assert.equal(context.serviceManaged,true);assert.equal(spawned,0);
    await methods.stopUnlocked.call(context,{allowElevatedPrompt:false});assert.equal(calls.at(-1)[0],'stop');assert.equal(context.pid,null);
    context.pid=88;context.serviceManaged=true;
    await assert.rejects(methods.stopUnlocked.call(context),/旧版代理/);assert.equal(spawned,0);
    runtime.start=async()=>{throw Error('service unavailable');};
    await assert.rejects(methods.startElevatedWindows.call(context,'ignored',configPath),/service unavailable/);assert.equal(spawned,0);
    context.pid=77;context.serviceManaged=false;context.isRunning=()=>false;
    context.db={getSettings:()=>({mode:'app-global',tunInstalled:false}),getActiveSubscription:()=>null};
    await assert.rejects(methods.startUnlocked.call(context),/订阅/);
    assert.equal(calls.at(-1)[0],'stop');assert.equal(context.pid,null);assert.equal(context.serviceManaged,false);assert.equal(spawned,0);
  }finally{await rm(directory,{recursive:true,force:true});}
  const apiModule={exports:{}};
  const apiSource=await readFile(new URL('../../../../../electron-plugin/packages/electron-plugin-tunnel/src/mihomo/MihomoApi.ts',import.meta.url),'utf8');
  new Function('module','exports',(await transform(apiSource,{loader:'ts',format:'cjs'})).code)(apiModule,apiModule.exports);
  const requests=[];
  const api=new apiModule.exports.MihomoApi(()=>{throw Error('user controller secret must not be used');},async (path,init)=>{requests.push({path,init});return {ok:true,status:200,data:{}};});
  await api.proxies();await api.selectProxy('海外','node-one');
  assert.equal(requests[1].path,'/proxies/%E6%B5%B7%E5%A4%96');assert.equal(requests[1].init.method,'PUT');
});

test('core Windows commands select the direct protected script for service execution and preserve legacy RunAs elsewhere', async () => {
  const core=require('../../../../../electron-plugin/packages/electron-core-wireguard/dist/index.js');
  const directory=await mkdtemp(path.join(os.tmpdir(),'mincave-service-direct-script-'));
  try{
    const configPath=path.join(directory,'mx-h2i.conf');await writeFile(configPath,wireguard);
    const runtime={platform:'win32',method:'windows-service',available:true,windowsWireGuard:{command:'C:\\Program Files\\MinCave\\resources\\wireguard\\win32-x64\\wireguard.exe'}};
    for(const action of ['up','down','restart']){
      const direct=core.buildWireGuardTunnelCommand({runtime,configPath,action,windowsServiceExecution:true});
      const script=await readFile(direct.args.at(-1),'utf8');assert.doesNotMatch(script,/-Verb RunAs/);
      const legacy=core.buildWireGuardTunnelCommand({runtime,configPath,action});
      assert.notEqual(direct.args.at(-1),legacy.args.at(-1));assert.match(await readFile(legacy.args.at(-1),'utf8'),/-Verb RunAs/);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('legacy handoff proves the Windows owner and key, runs only protected scripts and preserves a failed cleanup for retry', async t => {
  for(const failFirst of [false,true]){
    const root=await mkdtemp(path.join(os.tmpdir(),'mincave-legacy-service-'));t.after(()=>rm(root,{recursive:true,force:true}));
    const stateDir=path.join(root,'state');await mkdir(stateDir);
    const legacyPath=path.join(root,'old-user-profile.conf');await writeFile(legacyPath,wireguard);
    const calls=[];let cleanupFails=failFirst;
    const fakeExec=()=>{throw Error('unexpected child spawn');};
    fakeExec[require('node:util').promisify.custom]=async(_file,args)=>{
      const script=args.at(-1);
      if(script.includes('Get-CimInstance'))return {stdout:`old-wireguard.exe /tunnelservice "${legacyPath}"`,stderr:''};
      if(script.includes('Get-Acl'))return {stdout:SID,stderr:''};
      throw Error('unexpected PowerShell operation');
    };
    const core={resolveWireGuardConnectionRuntime:()=>({platform:'win32'}),setWireGuardTunnelState:async input=>{
      calls.push(input);
      assert.equal(input.configPath,path.join(stateDir,'wireguard','mx-h2i.conf'));
      assert.equal(input.windowsServiceExecution,true);
      assert.equal(await readFile(input.configPath,'utf8'),validateWireGuardConfig(wireguard));
      if(cleanupFails){cleanupFails=false;return {ok:false};}return {ok:true};
    }};
    const module={exports:{}};
    new Function('require','module','exports','process',(await readFile(new URL('../native/windows-network-worker.cjs',import.meta.url),'utf8'))+'\nmodule.exports.execute=execute;')(
      name=>name==='yaml'?YAML:name==='@qpjoy/electron-core-wireguard'?core:name==='node:child_process'?{execFile:fakeExec,spawn:()=>{throw Error('must not spawn user code');}}:workerRequire(name),module,module.exports,{platform:'win32',env:{SystemRoot:'C:\\Windows'}},
    );
    const request={operation:'wireguard',ownerSID:SID,root,stateDir,input:{action:'up',config:wireguard}};
    if(failFirst){
      await assert.rejects(module.exports.execute(request),e=>e.code==='legacy_cleanup_failed');
      assert.equal(JSON.parse(await readFile(path.join(stateDir,'state.json'),'utf8')).legacyPath,legacyPath);
    }
    await module.exports.execute(request);
    assert.deepEqual(calls.slice(-2).map(c=>c.action),['down','up']);
    assert.equal(calls.at(-2).windowsEndpointBypassOwnerPath,legacyPath);
    assert.equal(calls.at(-1).windowsEndpointBypassOwnerPath,undefined);
    assert.equal(JSON.parse(await readFile(path.join(stateDir,'state.json'),'utf8')).legacyPath,undefined);
  }
});
