import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DecisionLinks, decisionPage } from '../lib/decision-links.mjs';

test('decision links bind one immutable proposal, expire, and survive restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-decisions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now(); const links = new DecisionLinks({ dir, now: () => now }); await links.init();
  const opportunity = { id: randomUUID(), productVersion: 1, source: '真实资料', spec: { count: 3 }, referenceIds: [] };
  const { token } = links.issue(opportunity);
  assert.equal(links.verify(token, opportunity).id, opportunity.id);
  assert.throws(() => links.verify(token + 'x', opportunity), error => error.status === 403);
  assert.throws(() => links.verify(token, { ...opportunity, source: '另一份未批准的资料' }), error => error.status === 409);
  assert.throws(() => links.verifyCsrf(token, 'forged'), error => error.status === 403);
  links.verifyCsrf(token, links.csrf(token));
  const restored = new DecisionLinks({ dir, now: () => now }); await restored.init();
  assert.equal(restored.verify(token, opportunity).id, opportunity.id);
  now += 25 * 60 * 60 * 1000;
  assert.throws(() => links.verify(token), error => error.status === 410);
});

test('decision page escapes material and requires a POST for paid approval', () => {
  const page = decisionPage({ opportunity: { id: randomUUID(), state: 'pending', title: '<script>bad</script>', expiresAt: new Date(Date.now() + 3600000).toISOString(), trend: { title: '话题', url: 'https://example.org' }, outline: ['<b>正文</b>'], spec: { count: 3 } }, token: 'abc.def', csrf: 'challenge', nonce: 'nonce' });
  assert.ok(!page.includes('<script>'));
  assert.ok(page.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(page.includes('method="post" action="/decision/abc.def/approve"'));
  assert.ok(!page.includes('http-equiv="refresh"'));
  const invalidSource = decisionPage({ opportunity: { state: 'expired', title: '资料已更新', expiryReason: '产品资料已更新，请重新扫描', trend: { title: '不可信链接', url: 'javascript:alert(1)' } }, token: 'abc.def', nonce: 'nonce' });
  assert.ok(!invalidSource.includes('javascript:'));
  assert.ok(!invalidSource.includes('action="/decision/abc.def/approve"'));
  assert.ok(invalidSource.includes('产品资料已更新，请重新扫描'));
});
