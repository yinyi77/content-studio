import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NotificationService } from '../lib/notifications.mjs';

// Synthetic credentials and injected providers only: no real mail or HTTP sends.
const PASSWORD = 'MOCK_SMTP_SECRET_ONLY', TOKEN = 'MOCK_PUSH_SECRET_ONLY';
const emailConfig = () => ({ channel: 'email', email: { host: 'smtp.example.org', port: 587, secure: false, user: 'sender@example.org', password: PASSWORD, from: 'sender@example.org', to: 'owner@example.org' } });
const opportunity = () => ({ id: 'mock-opportunity-1', title: '<推荐标题>', reason: '产品相关的使用场景', angle: '用户已提供的实际案例', outline: ['内容一', '内容二'], spec: { count: 3 }, expiresAt: '2026-11-07T01:00:00Z', trend: { title: 'MOCK 热点', platform: 'weibo', url: 'https://example.org/mock-trend', sourceUpdatedAt: '2026-11-06T01:00:00Z' }, productSnapshot: { source: 'PRIVATE_FULL_PRODUCT_SOURCE_MUST_NOT_BE_SENT' }, source: 'PRIVATE_FULL_SOURCE' });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-notification-'));
  const sent = [];
  const service = new NotificationService({ dir, sendMailImpl: async (mail, smtp) => { sent.push({ mail, smtp }); return { accepted: ['owner@example.org'], messageId: '<mock-message@example.org>' }; }, fetchImpl: async () => { throw new Error('Unexpected network call'); }, ...options });
  await service.init();
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, service, sent };
}

test('safe defaults, partial save, blank secret preservation, explicit clearing and 0600 persistence', async t => {
  const f = await fixture(t);
  assert.equal(f.service.getSafeConfig().configured, false);
  const skipped = await f.service.sendOpportunity(opportunity());
  assert.equal(skipped.status, 'skipped');
  assert.equal(f.sent.length, 0);
  await f.service.updateConfig(emailConfig());
  await f.service.updateConfig({ email: { password: '' }, wechat: { token: TOKEN }, publicBaseUrl: 'http://127.0.0.1:4318/' });
  const safe = f.service.getSafeConfig();
  assert.equal(safe.email.hasPassword, true);
  assert.equal(safe.wechat.hasToken, true);
  assert.equal(safe.configured, true);
  assert.equal(safe.publicBaseUrl, 'http://127.0.0.1:4318');
  assert.doesNotMatch(JSON.stringify(safe), /MOCK_.*SECRET/);
  assert.equal((await stat(path.join(f.dir, 'notifications.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(f.dir, 'notification-outbox.json'))).mode & 0o777, 0o600);
  const restarted = await new NotificationService({ dir: f.dir, sendMailImpl: async () => assert.fail('No send during init') }).init();
  assert.equal(restarted.getSafeConfig().email.hasPassword, true);
  await restarted.updateConfig({ email: { clearPassword: true }, clearToken: true });
  assert.equal(restarted.getSafeConfig().email.hasPassword, false);
  assert.equal(restarted.getSafeConfig().wechat.hasToken, false);
});

test('SMTP injection and unsafe connection configuration are rejected before persistence', async t => {
  const { service } = await fixture(t);
  for (const input of [
    { email: { to: 'victim@example.org\r\nBcc: other@example.org' } },
    { email: { from: 'name <owner@example.org>' } },
    { email: { to: 'a@example.org,b@example.org' } },
    { email: { host: 'https://smtp.example.org' } },
    { email: { port: 25 } },
    { email: { secure: false } },
    { email: { port: 587, secure: true } },
    { publicBaseUrl: 'http://public.example.org/' },
    { publicBaseUrl: 'https://user:pass@example.org/' },
    { publicBaseUrl: 'https://example.org/?secret=1' },
    { publicBaseUrl: 'https://example.org/#x' },
    { publicBaseUrl: 'https://example.org/studio/' },
  ]) await assert.rejects(service.updateConfig(input), error => error.status === 400);
  await service.updateConfig({ publicBaseUrl: 'https://studio.example.org/' });
  assert.equal(service.getSafeConfig().publicBaseUrl, 'https://studio.example.org');
});

test('opportunity mail uses enforced STARTTLS and bounded public summary, provider acceptance is not delivery', async t => {
  const f = await fixture(t);
  await f.service.updateConfig(emailConfig());
  const result = await f.service.sendOpportunity(opportunity(), { decisionUrl: 'http://127.0.0.1:4318/decision/MOCK_SIGNED_LINK' });
  assert.equal(result.status, 'accepted');
  assert.equal(f.sent.length, 1);
  const { mail, smtp } = f.sent[0];
  assert.equal(smtp.secure, false);
  assert.equal(smtp.requireTLS, true);
  assert.equal(smtp.tls.rejectUnauthorized, true);
  assert.equal(smtp.tls.minVersion, 'TLSv1.2');
  assert.equal(mail.disableFileAccess, true);
  assert.equal(mail.disableUrlAccess, true);
  assert.match(mail.html, /&lt;推荐标题&gt;/);
  assert.match(mail.text, /3 张/);
  assert.match(mail.text, /2026-11-06T01:00:00Z/);
  assert.match(mail.text, /确认制作后才会/);
  assert.doesNotMatch(JSON.stringify(mail), /PRIVATE_FULL|MOCK_SMTP_SECRET/);
  assert.doesNotMatch(JSON.stringify(result), /MOCK_SMTP_SECRET|MOCK_SIGNED_LINK/);
  await f.service.updateConfig({ email: { port: 465 } });
  await f.service.test();
  assert.equal(f.sent[1].smtp.secure, true);
});

test('concurrent, repeated and restarted notification calls share one durable attempt', async t => {
  const f = await fixture(t);
  await f.service.updateConfig(emailConfig());
  const results = await Promise.all(Array.from({ length: 5 }, () => f.service.sendOpportunity(opportunity())));
  assert.ok(results.every(item => item.status === 'accepted'));
  assert.equal(f.sent.length, 1);
  assert.equal((await f.service.sendOpportunity(opportunity())).duplicate, true);
  const restarted = await new NotificationService({ dir: f.dir, sendMailImpl: async () => assert.fail('Duplicate must not send') }).init();
  assert.equal((await restarted.sendOpportunity(opportunity())).status, 'accepted');
  assert.equal((await restarted.sendOpportunity(opportunity())).duplicate, true);
});

test('unconfigured skipped notification requires an explicit configured retry, ordinary sends never retry', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.sendOpportunity(opportunity())).status, 'skipped');
  assert.equal((await f.service.sendOpportunity(opportunity())).duplicate, true);
  await assert.rejects(f.service.retryOpportunity(opportunity()), error => error.status === 400);
  assert.equal(f.service.getHistory()[0].attempts, 1);
  await f.service.updateConfig(emailConfig());
  assert.equal((await f.service.sendOpportunity(opportunity())).status, 'skipped');
  const retried = await f.service.retryOpportunity(opportunity());
  assert.equal(retried.status, 'accepted');
  assert.equal(retried.attempts, 2);
  assert.equal(retried.manualAttempts, 1);
  assert.deepEqual(retried.attemptHistory.map(item => item.status), ['skipped', 'accepted']);
  await assert.rejects(f.service.retryOpportunity(opportunity()), error => error.status === 409);
  assert.equal(f.sent.length, 1);
});

test('definite SMTP failure and ambiguous network failure remain durable and redact secrets', async t => {
  for (const [code, expected] of [['EAUTH', 'failed'], ['ETIMEDOUT', 'unknown']]) {
    let calls = 0;
    const f = await fixture(t, { sendMailImpl: async () => { calls++; const error = new Error(`MOCK failure ${PASSWORD} Bearer confidential-token`); error.code = code; throw error; } });
    await f.service.updateConfig(emailConfig());
    const result = await f.service.sendOpportunity(opportunity());
    assert.equal(result.status, expected);
    assert.doesNotMatch(result.message, /MOCK_SMTP_SECRET|confidential-token/);
    await f.service.updateConfig({ email: { password: PASSWORD } });
    assert.equal((await f.service.sendOpportunity(opportunity())).duplicate, true);
    if (expected === 'unknown') await assert.rejects(f.service.retryOpportunity(opportunity()), error => error.status === 409);
    assert.equal(calls, 1);
    assert.doesNotMatch(await readFile(path.join(f.dir, 'notification-outbox.json'), 'utf8'), /MOCK_SMTP_SECRET|confidential-token/);
  }
});

test('restart during sending preserves unknown outcome without an automatic resend', async t => {
  const f = await fixture(t);
  await f.service.updateConfig(emailConfig());
  const first = await f.service.sendOpportunity(opportunity());
  const file = path.join(f.dir, 'notification-outbox.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.entries[0].status = 'sending';
  await writeFile(file, JSON.stringify(saved));
  const restarted = await new NotificationService({ dir: f.dir, sendMailImpl: async () => assert.fail('Unknown outcome cannot retry') }).init();
  const next = await restarted.sendOpportunity(opportunity());
  assert.equal(next.id, first.id);
  assert.equal(next.status, 'unknown');
});

test('PushPlus checks business code and never treats HTTP 200 alone as success', async t => {
  for (const [code, expected] of [[200, 'accepted'], [401, 'failed']]) {
    let calls = 0;
    const f = await fixture(t, { fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://www.pushplus.plus/send');
      const payload = JSON.parse(options.body);
      assert.equal(payload.token, TOKEN);
      assert.equal(payload.channel, 'wechat');
      assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, json: async () => ({ code, msg: `MOCK ${TOKEN}`, data: 'MOCK-message-id' }) };
    } });
    await f.service.updateConfig({ channel: 'wechat', wechat: { token: TOKEN } });
    const result = await f.service.sendOpportunity(opportunity());
    assert.equal(result.status, expected);
    assert.doesNotMatch(JSON.stringify(result), /MOCK_PUSH_SECRET/);
    await f.service.sendOpportunity(opportunity());
    assert.equal(calls, 1);
  }
});

test('result notifications are once per project while explicit test clicks send individually', async t => {
  const f = await fixture(t);
  await f.service.updateConfig(emailConfig());
  const project = { id: 'MOCK-project', title: '测试作品', pages: [{ imageUrl: '/images/1.png' }, { imageError: 'MOCK failed' }] };
  await f.service.sendResult(project, { resultUrl: 'https://studio.example.org/decision/MOCK' });
  assert.match(f.sent[0].mail.text, /1 \/ 2 张/);
  await f.service.sendResult({ ...project, pages: [{ imageUrl: '/images/1.png' }, { imageUrl: '/images/2.png' }] });
  assert.equal(f.sent.length, 1);
  await f.service.test();
  await f.service.test();
  assert.equal(f.sent.length, 3);
});

test('explicit failed retry is serialized, preserves attempts and remains durable after restart', async t => {
  let calls = 0, release, entered;
  const inProvider = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { sendMailImpl: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('MOCK definite SMTP failure'), { code: 'EAUTH' });
    entered(); await blocked;
    return { accepted: ['owner@example.org'], messageId: 'MOCK-retry-success' };
  } });
  await f.service.updateConfig(emailConfig());
  const first = await f.service.sendOpportunity(opportunity());
  assert.equal(first.status, 'failed');
  const retry = f.service.retryOpportunity(opportunity());
  await inProvider;
  await assert.rejects(f.service.retryOpportunity(opportunity()), error => error.status === 409);
  const ordinaryDuplicate = f.service.sendOpportunity(opportunity());
  release();
  const accepted = await retry;
  assert.equal((await ordinaryDuplicate).id, accepted.id);
  assert.equal(accepted.attempts, 2);
  assert.deepEqual(accepted.attemptHistory.map(item => ({ status: item.status, manual: item.manual })), [{ status: 'failed', manual: false }, { status: 'accepted', manual: true }]);
  assert.equal(calls, 2);
  const restarted = await new NotificationService({ dir: f.dir, sendMailImpl: async () => assert.fail('Accepted retry must remain deduplicated') }).init();
  assert.equal(restarted.getHistory()[0].attempts, 2);
  assert.equal((await restarted.sendOpportunity(opportunity())).duplicate, true);
  await assert.rejects(restarted.retryOpportunity(opportunity()), error => error.status === 409);
});

test('each notification permits at most five explicit retries and preserves the limit across restart', async t => {
  let calls = 0;
  const fail = async () => { calls++; throw Object.assign(new Error('MOCK permanent SMTP failure'), { code: 'EAUTH' }); };
  const f = await fixture(t, { sendMailImpl: fail });
  await f.service.updateConfig(emailConfig());
  await f.service.sendOpportunity(opportunity());
  for (let index = 1; index <= 5; index++) {
    const result = await f.service.retryOpportunity(opportunity());
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts, index + 1);
    assert.equal(result.manualAttempts, index);
    assert.equal(result.attemptHistory.length, index + 1);
  }
  assert.equal(calls, 6);
  await assert.rejects(f.service.retryOpportunity(opportunity()), error => error.status === 429);
  const restarted = await new NotificationService({ dir: f.dir, sendMailImpl: fail }).init();
  await assert.rejects(restarted.retryOpportunity(opportunity()), error => error.status === 429);
  assert.equal(calls, 6);
  assert.equal(restarted.getHistory()[0].attempts, 6);
});

test('safe history is recent-first, bounded and strips secrets, content, links and extra legacy fields', async t => {
  let now = Date.parse('2026-11-06T01:00:00Z');
  const f = await fixture(t, { now: () => now });
  await f.service.updateConfig({ ...emailConfig(), wechat: { token: TOKEN } });
  for (let index = 0; index < 33; index++) {
    await f.service.sendOpportunity({ ...opportunity(), id: `MOCK-history-${index}` });
    now += 1000;
  }
  assert.equal(f.service.getHistory().length, 30);
  assert.deepEqual(f.service.getHistory({ limit: 2 }).map(item => item.entityId), ['MOCK-history-32', 'MOCK-history-31']);
  const historyFile = path.join(f.dir, 'notification-outbox.json');
  const saved = JSON.parse(await readFile(historyFile, 'utf8'));
  const latest = saved.entries.at(-1);
  latest.message = `MOCK ${PASSWORD} ${TOKEN} Bearer old-auth-value https://example.org/decision/private-token`;
  latest.body = 'LEGACY_PRIVATE_BODY'; latest.link = 'https://example.org/decision/private-link';
  latest.attemptHistory = [{ attempt: 1, status: 'accepted', channel: 'email', message: `MOCK ${PASSWORD} ${TOKEN}`, body: 'LEGACY_PRIVATE_BODY', secret: PASSWORD }];
  await writeFile(historyFile, JSON.stringify(saved));
  const restarted = await new NotificationService({ dir: f.dir }).init();
  const safe = restarted.getHistory({ limit: 1 });
  assert.deepEqual(Object.keys(safe[0]).sort(), ['id', 'entityId', 'kind', 'status', 'message', 'channel', 'attempts', 'updatedAt'].sort());
  assert.doesNotMatch(JSON.stringify(safe), /MOCK_.*SECRET|old-auth-value|https?:|private-token|private-link|LEGACY_PRIVATE_BODY/);
  assert.doesNotMatch(await readFile(historyFile, 'utf8'), /MOCK_SMTP_SECRET|MOCK_PUSH_SECRET|old-auth-value|LEGACY_PRIVATE_BODY/);
  assert.equal(safe[0].attempts, 1);
  assert.throws(() => restarted.getHistory({ limit: 0 }), error => error.status === 400);
  assert.throws(() => restarted.getHistory({ limit: 101 }), error => error.status === 400);
});

test('legacy missing attempt counters migrate and oversized attempt history stays within ten records', async t => {
  let calls = 0;
  const fail = async () => { calls++; throw Object.assign(new Error('MOCK authentication failure'), { code: 'EAUTH' }); };
  const f = await fixture(t, { sendMailImpl: fail });
  await f.service.updateConfig(emailConfig());
  await f.service.sendOpportunity(opportunity());
  const file = path.join(f.dir, 'notification-outbox.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  delete saved.entries[0].attempts;
  delete saved.entries[0].manualAttempts;
  saved.entries[0].attemptHistory = Array.from({ length: 20 }, (_, index) => ({ attempt: index + 1, status: 'failed', channel: 'email', message: 'MOCK old failure' }));
  await writeFile(file, JSON.stringify(saved));
  const restarted = await new NotificationService({ dir: f.dir, sendMailImpl: fail }).init();
  assert.equal(restarted.getHistory()[0].attempts, 20);
  const retried = await restarted.retryOpportunity(opportunity());
  assert.equal(retried.attempts, 21);
  assert.equal(retried.attemptHistory.length, 10);
  assert.equal(retried.attemptHistory.at(-1).attempt, 21);
  assert.equal(retried.attemptHistory.at(-1).manual, true);
  assert.equal(retried.attemptHistory.at(-1).status, 'failed');
  assert.equal(calls, 2);
});

test('explicit result retry handles first attempts, definite failure, reconfiguration and unknown outcomes', async t => {
  let calls = 0, mode = 'failed';
  const f = await fixture(t, { sendMailImpl: async () => {
    calls++;
    if (mode === 'failed') throw Object.assign(new Error('MOCK failure'), { code: 'EAUTH' });
    if (mode === 'unknown') throw Object.assign(new Error('MOCK timeout'), { code: 'ETIMEDOUT' });
    return { accepted: ['owner@example.org'] };
  } });
  const project = { id: 'MOCK-retry-result', title: 'MOCK 作品', pages: [{ imageUrl: '/image.png' }] };
  await assert.rejects(f.service.retryResult(project), error => error.status === 400);
  assert.equal(f.service.getHistory().length, 0);
  await f.service.updateConfig(emailConfig());
  assert.equal((await f.service.retryResult(project)).status, 'failed');
  await f.service.updateConfig({ channel: 'none' });
  await assert.rejects(f.service.retryResult(project), error => error.status === 400);
  assert.equal(f.service.getHistory()[0].attempts, 1);
  await f.service.updateConfig({ channel: 'email' });
  mode = 'unknown';
  assert.equal((await f.service.retryResult(project)).status, 'unknown');
  mode = 'accepted';
  await assert.rejects(f.service.retryResult(project), error => error.status === 409);
  assert.equal(calls, 2);
});
