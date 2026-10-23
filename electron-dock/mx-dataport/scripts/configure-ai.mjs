#!/usr/bin/env node
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function compassDeltaToken(source) {
  // Existing Compass application.yml uses ${DELTA_API_TOKEN:<default>}.
  // Read that exact credential; never infer a model key or another API token.
  const values = [...source.matchAll(/^\s*api-token:\s*["']?\$\{DELTA_API_TOKEN:([^}\r\n]+)\}/gm)].map(m=>m[1]);
  if (values.length !== 1 || !/^[A-Za-z0-9._~+-]{20,4096}$/.test(values[0])) throw Error('未找到唯一有效的罗盘 Delta Token 默认配置（配置值隐藏）。');
  return values[0];
}
export function secretDocument(token, environment = 'prod') {
  if (!['prod','dev'].includes(environment)) throw Error('环境只能为 prod 或 dev。');
  return {apiVersion:'v1',kind:'Secret',metadata:{name:'mx-dataport-ai',namespace:'mx-insight-hub'},type:'Opaque',
    data:{token:Buffer.from(token).toString('base64'),environment:Buffer.from(environment).toString('base64')}};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for(let i=0;i<args.length;i+=2) {
      if (!['--from-compass','--out','--environment'].includes(args[i]) || !args[i+1] || options[args[i]]) throw Error('参数不正确。');
      options[args[i]]=args[i+1];
    }
    if (!options['--from-compass'] || !options['--out']) throw Error('用法：node scripts/configure-ai.mjs --from-compass /path/application.yml --out /private/path/dataport-ai-secret.json [--environment prod]');
    const out = resolve(options['--out']), repo = fileURLToPath(new URL('../../../',import.meta.url));
    if (out === repo || out.startsWith(repo.endsWith(sep)?repo:repo+sep)) throw Error('Secret 输出必须位于 Git 仓库之外。');
    const token = compassDeltaToken(readFileSync(options['--from-compass'],'utf8'));
    writeFileSync(out,JSON.stringify(secretDocument(token,options['--environment'] || 'prod'))+'\n',{mode:0o600,flag:'wx'});
    chmodSync(out,0o600);
    console.log('已生成权限为 0600 的数港 AI Secret 文件，未输出 Token，未访问集群。');
  } catch(error) {
    console.error(error.code === 'EEXIST' ? '目标文件已存在，未覆盖既有 Secret。' : error.code ? '无法读取配置或写入私密文件（路径及值隐藏）。' : error.message);
    process.exitCode=1;
  }
}
