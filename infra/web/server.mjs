import { createServer, request as proxyRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEmbedHeaders } from './frame-policy.mjs';

const consoleHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://connect.facebook.net; connect-src 'self' https://www.facebook.com https://graph.facebook.com; frame-src https://www.facebook.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.facebook.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
};
function resolveEmbedPolicy(upstream, id) {
  return new Promise((resolvePolicy, reject) => {
    // Fixed upstream/path only, no caller headers, no redirect, bounded body and total time.
    const request = proxyRequest({ hostname: upstream.hostname, port: upstream.port || 80,
      path: `/v1/embed/apps/${id}/policy`, method: 'GET', headers: { Accept: 'application/json' } }, reply => {
      reply.on('error', reject);
      if (reply.statusCode !== 200) { reply.resume(); reject(new Error('EMBED_UNAVAILABLE')); return; }
      const chunks = []; let size = 0;
      reply.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) { reject(new Error('EMBED_UNAVAILABLE')); reply.destroy(); request.destroy(); }
        else chunks.push(chunk);
      });
      reply.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body.origin !== 'string' || Object.keys(body).length !== 1) throw new Error('EMBED_UNAVAILABLE');
          resolvePolicy(buildEmbedHeaders(body.origin));
        } catch { reject(new Error('EMBED_UNAVAILABLE')); }
      });
    });
    const timer = setTimeout(() => { reject(new Error('EMBED_UNAVAILABLE')); request.destroy(); }, 2000);
    timer.unref(); request.once('close', () => clearTimeout(timer));
    request.on('error', reject); request.end();
  });
}

export function createWebServer({ root = resolve('public'), apiOrigin = 'http://api:3000' } = {}) {
  const upstream = new URL(apiOrigin);
  if (upstream.protocol !== 'http:' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('Invalid API upstream');
  return createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/') || req.url === '/health') {
      const headers = { ...req.headers };
      // The edge is authoritative for proxy identity. Never relay a browser-supplied chain.
      delete headers['forwarded']; delete headers['x-forwarded-for']; delete headers['x-real-ip'];
      headers.host = upstream.host;
      const forwarded = proxyRequest({ hostname: upstream.hostname, port: upstream.port || 80,
        path: req.url, method: req.method, headers, timeout: 35_000 }, reply => {
        res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res);
      });
      forwarded.on('timeout', () => forwarded.destroy());
      forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' }); res.end(); });
      req.on('aborted', () => forwarded.destroy()); req.pipe(forwarded); return;
    }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return; }
    let pathname, parsedUrl;
    try { parsedUrl = new URL(req.url ?? '/', 'http://local'); pathname = decodeURIComponent(parsedUrl.pathname); }
    catch { res.writeHead(400); res.end(); return; }
    if (pathname.startsWith('/embed/chatwoot') || pathname === '/embed.html') {
      try {
        const match = /^\/embed\/chatwoot\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(pathname);
        if (!match || parsedUrl.search) throw new Error('INVALID_EMBED');
        const headers = await resolveEmbedPolicy(upstream, match[1]);
        const data = await readFile(resolve(root, 'embed.html'));
        res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch {
        res.writeHead(403, { ...consoleHeaders, 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : '<!doctype html><html lang="pt-BR"><title>JRC</title><p>Painel indisponível. Abra o portal JRC para continuar.</p><a href="/conexoes" target="_blank" rel="noopener noreferrer">Abrir portal JRC</a></html>');
      }
      return;
    }
    const candidate = resolve(root, `.${pathname}`);
    if ((candidate !== root && !candidate.startsWith(root + sep)) || pathname.includes('\\') || pathname.includes('\0')) { res.writeHead(404); res.end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
    let data; let extension = extname(candidate);
    try { data = await readFile(candidate); }
    catch {
      if (extension) { res.writeHead(404); res.end(); return; }
      try { data = await readFile(resolve(root, 'index.html')); extension = '.html'; }
      catch { res.writeHead(503); res.end(); return; }
    }
    res.writeHead(200, { 'Content-Type': types[extension] ?? 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600',
      ...consoleHeaders });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createWebServer({ apiOrigin: process.env.API_ORIGIN ?? 'http://api:3000' });
  server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
  process.once('SIGTERM', () => server.close()); process.once('SIGINT', () => server.close());
}
