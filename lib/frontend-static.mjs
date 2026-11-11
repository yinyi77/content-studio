import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

const legacyFiles = new Map([
  ['/legacy', 'index.html'], ['/legacy/', 'index.html'], ['/legacy/index.html', 'index.html'],
  ['/app.js', 'app.js'], ['/styles.css', 'styles.css'],
  ['/professional.css', 'professional.css'], ['/style-catalog.js', 'style-catalog.js'],
]);
const entries = new Set(['/', '/index.html', '/admin', '/admin/', '/admin/index.html']);
const assetExtensions = new Set(['.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2']);

export const frontendTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

async function regularFile(filename) {
  try { return (await stat(filename)).isFile(); } catch { return false; }
}

// Only the compiled frontend and the existing public allowlist are reachable.
export async function resolveFrontendAsset(root, pathname) {
  const dist = path.join(root, 'frontend', 'dist');
  if (entries.has(pathname)) {
    const entry = path.join(dist, 'index.html');
    return await regularFile(entry)
      ? { file: entry, kind: 'admin', cacheControl: 'no-cache' }
      : { file: path.join(root, 'public', 'index.html'), kind: 'legacy', cacheControl: 'no-cache' };
  }
  if (legacyFiles.has(pathname)) {
    return { file: path.join(root, 'public', legacyFiles.get(pathname)), kind: 'legacy', cacheControl: 'no-cache' };
  }
  if (!pathname.startsWith('/admin/assets/')) return null;
  let relative;
  try { relative = decodeURIComponent(pathname.slice('/admin/'.length)); } catch { return null; }
  if (relative.includes('\0') || relative.includes('\\') || relative.split('/').some(segment => segment === '.' || segment === '..')) return null;
  if (!assetExtensions.has(path.extname(relative).toLowerCase())) return null;
  try {
    const base = await realpath(path.join(dist, 'assets'));
    const file = await realpath(path.join(dist, relative));
    if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) return null;
    return { file, kind: 'admin', cacheControl: 'public, max-age=31536000, immutable' };
  } catch { return null; }
}

export function frontendPolicy(kind, pathname) {
  if (kind === 'admin') return "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
  const frameAncestors = pathname.startsWith('/legacy') ? "'self'" : "'none'";
  return `default-src 'self'; img-src 'self' data: https://*.xhscdn.com https://*.xiaohongshu.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'self'`;
}
