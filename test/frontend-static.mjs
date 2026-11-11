import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveFrontendAsset, frontendPolicy } from '../lib/frontend-static.mjs';

test('compiled admin entry and legacy entry remain separate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-studio-static-'));
  try {
    await mkdir(path.join(root, 'public'), { recursive: true });
    await writeFile(path.join(root, 'public', 'index.html'), 'legacy');
    assert.equal((await resolveFrontendAsset(root, '/')).kind, 'legacy');
    await mkdir(path.join(root, 'frontend', 'dist', 'assets'), { recursive: true });
    await writeFile(path.join(root, 'frontend', 'dist', 'index.html'), 'admin');
    for (const entry of ['/', '/index.html', '/admin/', '/admin/index.html']) {
      const asset = await resolveFrontendAsset(root, entry);
      assert.equal(asset.kind, 'admin');
      assert.equal(asset.cacheControl, 'no-cache');
    }
    assert.equal((await resolveFrontendAsset(root, '/legacy')).file, path.join(root, 'public', 'index.html'));
    assert.equal((await resolveFrontendAsset(root, '/professional.css')).kind, 'legacy');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('admin assets cannot expose server files through traversal or symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-studio-static-'));
  try {
    const assets = path.join(root, 'frontend', 'dist', 'assets');
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, 'index-123.js'), 'export{}');
    await writeFile(path.join(root, 'private.js'), 'private');
    await symlink(path.join(root, 'private.js'), path.join(assets, 'escape.js'));
    assert.ok((await resolveFrontendAsset(root, '/admin/assets/index-123.js')).cacheControl.includes('immutable'));
    for (const invalid of ['/admin/assets/../private.js', '/admin/assets/%2e%2e/private.js', '/admin/assets/%2e%2e%2fprivate.js', '/admin/assets/escape.js', '/admin/assets/index.map', '/admin/assets/%00.js', '/data/config.json', '/server.mjs']) {
      assert.equal(await resolveFrontendAsset(root, invalid), null, invalid);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('embedding is restricted to same-origin legacy pages', () => {
  const shell = frontendPolicy('admin', '/');
  assert.ok(shell.includes("frame-src 'self'"));
  assert.ok(shell.includes("frame-ancestors 'none'"));
  assert.ok(frontendPolicy('legacy', '/legacy').includes("frame-ancestors 'self'"));
  assert.ok(frontendPolicy('legacy', '/app.js').includes("frame-ancestors 'none'"));
  assert.ok(shell.includes("script-src 'self'"));
  assert.ok(!shell.includes('unsafe-eval'));
});
