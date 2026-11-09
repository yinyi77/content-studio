import path from 'node:path';
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { IMAGE_STYLES } from '../public/style-catalog.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message, status = 403) => { const error = new Error(message); error.status = status; throw error; };
const equal = (a, b) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const digest = opportunity => createHash('sha256').update(JSON.stringify({ id: opportunity.id, productVersion: opportunity.productVersion, source: opportunity.source, spec: opportunity.spec, referenceIds: opportunity.referenceIds || [] })).digest('hex');
export class DecisionLinks {
  constructor({ dir, now = Date.now }) { this.file = path.join(dir, 'decision-link-secret'); this.now = now; }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { this.secret = await readFile(this.file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const secret = randomBytes(32);
      try { await writeFile(this.file, secret, { flag: 'wx', mode: 0o600 }); this.secret = secret; }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; this.secret = await readFile(this.file); }
    }
    if (this.secret.length !== 32) throw new Error('决策链接密钥无效，请检查本地数据目录');
  }
  sign(text) { return createHmac('sha256', this.secret).update(text).digest('base64url'); }
  issue(opportunity) {
    if (!uuid.test(opportunity?.id)) invalid('选题不存在', 404);
    const expires = this.now() + 24 * 60 * 60 * 1000;
    const payload = Buffer.from(JSON.stringify({ id: opportunity.id, digest: digest(opportunity), expires })).toString('base64url');
    return { token: payload + '.' + this.sign(payload), expiresAt: new Date(expires).toISOString() };
  }
  verify(token, opportunity) {
    if (typeof token !== 'string' || token.length > 1600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) invalid('决策链接无效');
    const [encoded, signature] = token.split('.');
    if (!equal(this.sign(encoded), signature)) invalid('决策链接校验失败');
    let payload; try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { invalid('决策链接无效'); }
    if (!uuid.test(payload.id) || !Number.isFinite(payload.expires) || payload.expires <= this.now()) invalid('决策链接已过期，请从选题雷达重新打开', 410);
    if (opportunity && (payload.id !== opportunity.id || payload.digest !== digest(opportunity))) invalid('提案内容已变更，请在选题雷达核对新提案', 409);
    return payload;
  }
  csrf(token) { return this.sign('decision-post:' + token); }
  verifyCsrf(token, value) { if (typeof value !== 'string' || !equal(this.csrf(token), value)) invalid('操作校验失败，请重新打开决策页'); }
}

const h = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '待确认';
const stateLabel = state => ({ pending: '待你决策', approved: '已批准', skipped: '已跳过', expired: '已过期' }[state] || state);
const projectState = value => ({ completed: '已完成', partial: '部分完成', error: '生成未完成', interrupted: '运行已中断', analyzing: '正在策划', generating: '正在生成', draft: '方案已准备好' }[value] || '处理中');
const sourceLink = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
export function decisionPage({ opportunity: o, project, token, csrf, nonce, message = '', error = '' }) {
  const expired = Date.parse(o.expiresAt) <= Date.now(), pending = o.state === 'pending' && !expired;
  const spec = o.spec || {}, complete = project && !['analyzing', 'generating'].includes(project.status) && !['thinking', 'analyzing', 'generating'].includes(project.chatStatus);
  const link = sourceLink(o.trend?.url), styleName = IMAGE_STYLES.find(style => style.id === spec.style)?.name || spec.style;
  const rendered = project ? `<section class="result"><div class="eyebrow">创作结果 · ${h(projectState(project.status))} · ${(project.pages || []).filter(page => page.status === 'done' && page.imageUrl).length} / ${project.pages?.length || project.count || 0} 张</div><h2>${h(project.title)}</h2>${project.error ? `<p class="error">${h(project.error)}</p>` : ''}<div class="images">${(project.pages || []).map((page, index) => page.imageUrl ? `<figure><img src="/decision/${encodeURIComponent(token)}/media/${encodeURIComponent(page.imageUrl.split('/').pop())}" alt="${h(page.title)}"><figcaption>${index + 1} · ${h(page.title)} · <a download href="/decision/${encodeURIComponent(token)}/media/${encodeURIComponent(page.imageUrl.split('/').pop())}">保存图片</a></figcaption></figure>` : `<div class="placeholder">第${index + 1}张 · ${page.status === 'error' ? '生成未完成' : '等待生成'}${page.error ? `<p class="error">${h(page.error)}</p>` : ''}</div>`).join('')}</div><p class="copy">${h(project.caption)}</p>${!complete ? '<p>任务正在后台处理。稍后刷新本页查看进度；刷新不会重新生成。</p>' : '<p>可回到图文工坊的作品记录中下载整组内容或继续修改。</p>'}</section>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${h(o.title)} · 图文工坊</title><style nonce="${h(nonce)}">*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#202733;font:15px/1.8 system-ui,-apple-system,"PingFang SC",sans-serif}main{max-width:850px;margin:auto;padding:32px 20px 60px}header{color:#244b76;font-weight:650;margin-bottom:30px}article,.result{background:white;border:1px solid #dfe5ed;border-radius:16px;padding:28px;margin-bottom:24px}.eyebrow,small{color:#6b7890;font-size:12px}h1{font-size:27px;line-height:1.45;margin:10px 0 18px}h2{font-size:20px}p,.copy{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#244b76}dl{display:grid;grid-template-columns:90px 1fr;gap:12px;margin:22px 0}dt{color:#6b7890}dd{margin:0;overflow-wrap:anywhere}.actions{display:flex;gap:12px;flex-wrap:wrap}.actions form{margin:0}button{cursor:pointer;border:1px solid #c9d5e4;border-radius:9px;background:white;color:#244b76;padding:12px 22px;font:inherit}.primary{background:#244b76;color:white;border-color:#244b76}details{margin:12px 0}summary{cursor:pointer;color:#244b76}label{display:block;margin:10px 0;color:#6b7890;font-size:13px}select,textarea{display:block;width:100%;max-width:360px;padding:10px;border:1px solid #c9d5e4;border-radius:8px;background:white;color:#202733;font:inherit}textarea{resize:vertical}.notice{padding:13px 16px;border-radius:9px;background:#eaf0f8;margin:14px 0}.error{color:#a73632;background:#fff0ef;padding:12px;border-radius:8px}.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px}.images img{width:100%;height:auto;border-radius:8px}.images figure{margin:0}.images figcaption{font-size:12px;color:#6b7890}.placeholder{padding:32px 12px;background:#f5f7fa;text-align:center}@media(max-width:500px){article,.result{padding:20px}main{padding:20px 14px}h1{font-size:23px}dl{grid-template-columns:72px 1fr}}</style></head><body><main><header>图文工坊 · 选题决策</header><article><div class="eyebrow">${h(expired && o.state === 'pending' ? '已过期' : stateLabel(o.state))} · 提案有效至 ${h(date(o.expiresAt))}</div><h1>${h(o.title)}</h1>${message ? `<p class="notice" role="status">${h(message)}</p>` : ''}${error ? `<p class="error" role="alert">${h(error)}</p>` : ''}<dl><dt>热点来源</dt><dd>${link ? `<a href="${h(link)}" target="_blank" rel="noopener noreferrer">${h(o.trend?.title)}</a>` : h(o.trend?.title)}<br><small>来源更新：${h(date(o.trend?.sourceUpdatedAt))}（北京时间）</small></dd><dt>推荐理由</dt><dd>${h(o.reason)}</dd><dt>创作角度</dt><dd>${h(o.angle)}</dd><dt>内容结构</dt><dd>${(o.outline || []).map(h).join('<br>')}</dd><dt>制作规格</dt><dd>${h(spec.count)}张 · ${h(spec.aspect)} · ${h(styleName)}</dd></dl>${o.expiryReason ? `<p class="notice">${h(o.expiryReason)}</p>` : ''}${o.factNotes ? `<p class="notice">素材说明：${h(o.factNotes)}</p>` : ''}<p class="eyebrow">这是基于热点标题与已有资料提出的创作建议，不代表流量保证。批准后会调用文字与图片模型。</p>${pending ? `<div class="actions"><form method="post" action="/decision/${encodeURIComponent(token)}/approve"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="primary" type="submit">批准并生成</button></form><form method="post" action="/decision/${encodeURIComponent(token)}/skip"><input type="hidden" name="csrf" value="${h(csrf)}"><details><summary>这次不做（可选原因）</summary><label>跳过原因<select name="reason"><option value="">暂不填写</option><option value="not_relevant">话题关联弱</option><option value="not_product_fit">不符合产品定位</option><option value="repeated">已经做过了</option><option value="timing">时机不合适</option><option value="other">其他</option></select></label><label>补充说明<textarea name="note" maxlength="300" rows="3" placeholder="告诉我下次如何选得更准，选填"></textarea></label></details><button type="submit">跳过这条</button></form></div>` : ''}</article>${rendered}<small>本链接仅授权查看及决策这份提案。打开页面、刷新页面均不会触发生成。</small></main></body></html>`;
}
