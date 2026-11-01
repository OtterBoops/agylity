import type http from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, methodNotAllowed } from '../http.js';
import { MIME_TYPES } from '../types.js';

export const resolvePublicFilePath = (relative: string): string | null => {
  if (relative.includes('\0')) {
    return null;
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    // 1. Production bundle: dist/web/public (when running compiled dist/web/controllers/static.js)
    path.resolve(currentDir, '..', 'public'),
    // 2. Dev mode with tsx: <root>/dist/web/public (relative to src/web/controllers/static.ts)
    path.resolve(currentDir, '..', '..', '..', 'dist', 'web', 'public'),
    // 3. Process CWD fallback
    path.resolve(process.cwd(), 'dist', 'web', 'public'),
  ];

  for (const root of candidateRoots) {
    const candidate = path.resolve(root, relative);
    if ((candidate === root || candidate.startsWith(root + path.sep)) && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

export const resolveIndexHtmlPath = (): string | null => resolvePublicFilePath('index.html');

export const loadIndexHtml = async (): Promise<string | null> => {
  const p = resolveIndexHtmlPath();
  if (!p) {
    return null;
  }
  return fs.readFile(p, 'utf-8');
};

export const handleStaticAsset = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string
): Promise<void> => {
  if (method !== 'GET') return methodNotAllowed(res);

  const fullPath = resolvePublicFilePath(pathname.slice(1));
  if (!fullPath) return sendJson(res, 404, { error: 'Asset not found' });

  try {
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = await fs.readFile(fullPath);
    res
      .writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      })
      .end(content);
  } catch (err: any) {
    res
      .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end(`Error loading asset: ${err?.message}`);
  }
};

export const handleIndexHtml = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string
): Promise<void> => {
  if (method !== 'GET') return methodNotAllowed(res);

  try {
    const html = await loadIndexHtml();
    if (html === null) {
      return sendJson(res, 503, { error: 'Frontend bundle not built. Run npm run build:client.' });
    }
    res
      .writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      .end(html);
  } catch (err: any) {
    return sendJson(res, 503, { error: 'Frontend bundle not built. Run npm run build:client.' });
  }
};
