import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { requestSnippet } from '../../src/request-snippets.js'
const input = { url: 'https://hub.example/api/v1/data/ip/risk', body: { ip: '1.1.1.1' }, credential: "key'$HOME`printf unsafe`$(printf unsafe)", idempotencyKey: 'ip-risk-test-001' }
test('cURL quoting preserves exact URL, credential, idempotency key and JSON without shell expansion', () => {
 const script = requestSnippet({ ...input, format: 'curl' })
 const result = spawnSync('bash', ['-c', `curl() { printf '%s\\0' "$@"; }\n${script}`], { encoding: 'utf8' })
 assert.equal(result.status, 0)
 const args = result.stdout.split('\0').filter(Boolean)
 assert.deepEqual(args, ['--request','POST',input.url,'--header',`Authorization: Bearer ${input.credential}`,'--header','Content-Type: application/json','--header',`Idempotency-Key: ${input.idempotencyKey}`,'--data-raw',JSON.stringify(input.body)])
})
test('browser and Node fetch snippets execute the same fixed request exactly once', async () => {
 for (const format of ['fetch','node']) {
  const calls=[]
  const code=requestSnippet({...input,format,body:{ips:['1.1.1.1','8.8.8.8']}})
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
  await new AsyncFunction('fetch','console',format==='fetch'?`return ${code}`:code)(async(...args)=>{calls.push(args);return new Response('{}')},{log(){}})
  assert.equal(calls.length,1)
  assert.equal(calls[0][0],input.url)
  assert.equal(calls[0][1].headers.Authorization,`Bearer ${input.credential}`)
  assert.equal(calls[0][1].headers['Idempotency-Key'],input.idempotencyKey)
  assert.deepEqual(JSON.parse(calls[0][1].body),{ips:['1.1.1.1','8.8.8.8']})
 }
})
test('PowerShell escapes apostrophes and transmits UTF-8 JSON; unsupported formats fail', () => {
 const code=requestSnippet({...input,format:'powershell'})
 assert.ok(code.includes("key''$HOME`printf unsafe`$(printf unsafe)"))
 assert.match(code,/UTF8.GetBytes/u)
 assert.ok(code.includes(input.idempotencyKey))
 assert.throws(()=>requestSnippet({...input,format:'arbitrary'}))
})
