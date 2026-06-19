import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDir = fileURLToPath(new URL('.', import.meta.url));
const root = normalize(join(demoDir, '../..'));
const port = Number(process.env.PORT || 18130);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

const demoRoutePrefix = '/demos/ui-design-neon-void';

function safePath(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, `http://127.0.0.1:${port}`).pathname);
  const requested = pathname === '/' ? '/demos/ui-design-neon-void/index.html' : pathname;
  const resolved = normalize(join(root, requested));
  return resolved.startsWith(root) ? resolved : null;
}

const server = createServer(async (request, response) => {
  const filePath = safePath(request.url || '/');
  if (!filePath) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    const finalPath = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const finalInfo = info.isDirectory() ? await stat(finalPath) : info;
    response.writeHead(200, {
      'content-length': finalInfo.size,
      'content-type': contentTypes[extname(finalPath)] || 'application/octet-stream'
    });
    createReadStream(finalPath).pipe(response);
  } catch {
    const pathname = new URL(request.url || '/', `http://127.0.0.1:${port}`).pathname;
    const isDemoRoute = pathname === demoRoutePrefix || pathname.startsWith(`${demoRoutePrefix}/`);
    const hasExtension = Boolean(extname(pathname));
    if (isDemoRoute && !hasExtension) {
      const indexPath = join(root, 'demos/ui-design-neon-void/index.html');
      const indexInfo = await stat(indexPath);
      response.writeHead(200, {
        'content-length': indexInfo.size,
        'content-type': contentTypes['.html']
      });
      createReadStream(indexPath).pipe(response);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Neon Void demo: http://127.0.0.1:${port}/demos/ui-design-neon-void/`);
});
