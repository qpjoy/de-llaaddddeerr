import { ArchiveCatalog } from './archive-catalog.mjs'
const catalog=new ArchiveCatalog(process.env.MX_STATIC_STATE_DIR||'/state')
try {
  const action=process.argv[2]||'status'
  if(action==='attach') catalog.setEnabled(true,process.argv[3])
  else if(action==='detach') catalog.setEnabled(false)
  else if(action!=='status') throw Error('Unknown storage action')
  const projects=catalog.db.prepare('SELECT DISTINCT project FROM objects').all()
  console.log(JSON.stringify({backend:catalog.backend(),projects:projects.map(({project})=>({project,...catalog.status(project)}))},null,2))
} finally {catalog.close()}
