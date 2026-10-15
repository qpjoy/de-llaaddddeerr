import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const sha=source=>createHash('sha256').update(source).digest('hex')
const parser=await readFile(new URL('../server/contracts/tikhub-content-search.mjs',import.meta.url))
const diagnostic=await readFile(new URL('../server/ops/diagnose-content-search.mjs',import.meta.url))
const weiboDiagnostic=await readFile(new URL('../server/ops/diagnose-weibo-search.mjs',import.meta.url))
const metadata={implementation:'bundled_local_candidate',parserSha256:sha(parser),diagnosticSha256:sha(diagnostic),weiboDiagnosticSha256:sha(weiboDiagnostic)}
const result=await build({entryPoints:[new URL('../server/ops/diagnose-content-search.mjs',import.meta.url).pathname],
  bundle:true,write:false,platform:'node',format:'esm',target:'node22',external:['pg'],
  define:{__CONTENT_SEARCH_DIAGNOSTIC_BUILD__:JSON.stringify(metadata)},
  plugins:[{name:'diagnostic-entry-only',setup(builder){builder.onLoad({filter:/diagnose-weibo-search\.mjs$/},async({path})=>{
    const source=await readFile(path,'utf8')
    const entry="if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {"
    if(source.split(entry).length!==2) throw new Error('weibo_entry_changed')
    return {contents:source.replace(entry,'if (false) {'),loader:'js'}
  })}}],
  banner:{js:`// Read-only offline candidate. Parser SHA-256: ${sha(parser)}; diagnostic SHA-256: ${sha(diagnostic)}`}})
if(result.outputFiles.length!==1) throw new Error('unexpected_bundle_output')
const source=result.outputFiles[0].text
if(Buffer.byteLength(source)>2097152) throw new Error('bundle_too_large')
process.stderr.write(JSON.stringify({diagnosticRevision:'content-search-diagnostic.v9',...metadata,bundleSha256:sha(source),bundleBytes:Buffer.byteLength(source)})+'\n')
process.stdout.write(source)
