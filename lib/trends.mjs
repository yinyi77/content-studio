import path from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { activeMemes, reconcileMemeArchive } from './memes.mjs';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ITEMS = 100;
const SOURCE_DELAY_MS = 2 * 60 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 60 * 1000;
const defaults = { enabled: true, intervalMinutes: 30, keywords: [] };
export const PLATFORMS = [
  { id: 'weibo', name: '微博', platformUrl: 'https://s.weibo.com/top/summary?cate=realtimehot', fallbackPath: 'weibo' },
  { id: 'douyin', name: '抖音', platformUrl: 'https://www.douyin.com/hot', fallbackPath: 'douyin' },
  { id: 'xiaohongshu', name: '小红书', platformUrl: 'https://www.xiaohongshu.com/explore', fallbackPath: 'rednote' },
];

function invalid(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
const cleanText = (value, max = 300) => typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
export function safeTrendUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096 ? url.href : '';
  } catch { return ''; }
}
function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!['string', 'number'].includes(typeof value)) return null;
  const numeric = typeof value === 'number' ? value : /^\d{10,13}$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric === null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const titleKey = title => title.normalize('NFKC').replace(/[\s#＃]/g, '').toLowerCase();
const itemId = (platform, title) => createHash('sha256').update(`${platform}:${titleKey(title)}`).digest('hex').slice(0, 24);

export function validateTrendSettings(input, current = defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('热点设置必须是一个对象');
  const next = { ...current, keywords: [...current.keywords] };
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') invalid('定时更新开关格式不正确');
    next.enabled = input.enabled;
  }
  if ('intervalMinutes' in input) {
    if (![15, 30, 60].includes(input.intervalMinutes)) invalid('更新间隔请选择 15、30 或 60 分钟');
    next.intervalMinutes = input.intervalMinutes;
  }
  if ('keywords' in input) {
    if (!Array.isArray(input.keywords) || input.keywords.length > 20 || input.keywords.some(x => typeof x !== 'string' || x.trim().length > 40 || !x.trim())) invalid('最多关注 20 个关键词，每个关键词为 1 到 40 个字符');
    next.keywords = [...new Map(input.keywords.map(x => [x.trim().toLowerCase(), x.trim()])).values()];
  }
  return next;
}

export function normalizeTrendPayload(platform, payload, { provider = 'UAPI', fetchedAt = new Date().toISOString(), previousItems = [] } = {}) {
  if (!PLATFORMS.some(x => x.id === platform)) invalid('不支持的热点平台');
  if (!payload || typeof payload !== 'object') throw new Error('来源返回格式不正确');
  if (payload.code !== undefined && ![0, 200, '200', '0'].includes(payload.code)) throw new Error('来源暂时无法提供热榜');
  if (provider === 'UAPI' && payload.type && payload.type !== platform) throw new Error('来源返回了其他平台的榜单');
  const list = provider === 'UAPI' ? payload.list : Array.isArray(payload.data) ? payload.data : payload.data?.list;
  if (!Array.isArray(list)) throw new Error('来源未返回有效的热榜列表');
  const sourceUpdatedAt = timestamp(payload.update_time ?? payload.updatetime ?? payload.updated_at ?? payload.data?.update_time);
  const previous = new Map(previousItems.map(item => [item.id, item]));
  const seen = new Set();
  const items = [];
  for (const [index, raw] of list.slice(0, MAX_ITEMS * 2).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const title = cleanText(raw.title, 300), key = titleKey(title);
    const url = safeTrendUrl(raw.url || raw.link);
    if (!title || !key || !url || seen.has(key)) continue;
    seen.add(key);
    const rankValue = Number(raw.index ?? raw.rank);
    const rank = Number.isInteger(rankValue) && rankValue > 0 && rankValue <= 10000 ? rankValue : index + 1;
    const id = itemId(platform, title), old = previous.get(id);
    const description = cleanText(raw.description ?? raw.desc, 1000);
    items.push({ id, platform, title, url, rank, heat: cleanText(raw.hot_value ?? raw.score ?? raw.hot, 60), description,
      fetchedAt, sourceUpdatedAt, firstSeenAt: old?.firstSeenAt || fetchedAt,
      rankChange: old ? old.rank - rank : null, isNew: previousItems.length > 0 && !old, provider });
    if (items.length >= MAX_ITEMS) break;
  }
  if (!items.length) throw new Error('来源暂未提供可用的热榜条目');
  items.sort((a, b) => a.rank - b.rank);
  return { items, sourceUpdatedAt };
}

function sourceList(platform, fallbackBase) {
  return [
    { provider: 'UAPI', url: `https://uapis.cn/api/v1/misc/hotboard?type=${platform.id}` },
    { provider: '60s API', url: `${fallbackBase}/v2/${platform.fallbackPath}` },
  ];
}
function fallbackUrl(value = 'https://60s.viki.moe') {
  const checked = safeTrendUrl(value);
  if (!checked) invalid('TRENDS_60S_BASE_URL 必须是有效的 HTTP(S) 地址');
  const url = new URL(checked);
  if (url.search || url.hash) invalid('TRENDS_60S_BASE_URL 不能带查询参数或片段');
  return checked.replace(/\/+$/, '');
}
function blankPlatform(platform) {
  return { id: platform.id, name: platform.name, platformUrl: platform.platformUrl, provider: '', sourceUrl: '',
    lastSuccessAt: null, lastAttemptAt: null, sourceUpdatedAt: null, sourceTimeBasis: '', error: '', items: [] };
}

export class TrendsService {
  constructor({ dir, fetchImpl = globalThis.fetch, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
    autoRefresh = true, fallbackBase = 'https://60s.viki.moe', timeoutMs = 10000 } = {}) {
    if (!dir) throw new Error('热点缓存目录不能为空');
    this.file = path.join(dir, 'trends.json');
    this.fetchImpl = fetchImpl; this.now = now; this.setTimer = setTimeoutImpl; this.clearTimer = clearTimeoutImpl;
    this.autoRefresh = autoRefresh; this.fallbackBase = fallbackUrl(fallbackBase); this.timeoutMs = timeoutMs;
    this.settings = structuredClone(defaults); this.platforms = PLATFORMS.map(blankPlatform);
    this.memes = []; this.memeFirstSeen = [];
    this.lastAttemptAt = null; this.inFlight = null; this.timer = null; this.nextRefreshAt = null;
    this.persistenceError = ''; this.persistenceQueue = Promise.resolve(); this.controllers = new Set(); this.closed = false;
  }
  async init() {
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const raw = await readFile(this.file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES * 16) throw new Error('缓存文件过大');
      const saved = JSON.parse(raw);
      if (saved.version !== 1) throw new Error('缓存版本不正确');
      this.settings = validateTrendSettings(saved.settings);
      this.lastAttemptAt = timestamp(saved.lastAttemptAt);
      this.platforms = PLATFORMS.map(platform => {
        const old = saved.platforms?.find?.(x => x?.id === platform.id);
        if (!old) return blankPlatform(platform);
        const sourceUpdatedAt = timestamp(old.sourceUpdatedAt), fetchedAt = timestamp(old.lastSuccessAt);
        const items = Array.isArray(old.items) ? old.items.slice(0, MAX_ITEMS).flatMap(item => {
          const title = cleanText(item?.title, 300), url = safeTrendUrl(item?.url);
          if (!title || !url || !fetchedAt) return [];
          return [{ id: itemId(platform.id, title), platform: platform.id, title, url, rank: Number.isInteger(item.rank) && item.rank > 0 ? item.rank : 1,
            heat: cleanText(item.heat, 60), description: cleanText(item.description, 1000), fetchedAt, sourceUpdatedAt,
            firstSeenAt: timestamp(item.firstSeenAt) || fetchedAt, rankChange: Number.isInteger(item.rankChange) ? item.rankChange : null,
            isNew: item.isNew === true, provider: cleanText(old.provider, 60) }];
        }) : [];
        return { ...blankPlatform(platform), provider: cleanText(old.provider, 60), sourceUrl: safeTrendUrl(old.sourceUrl),
          lastSuccessAt: fetchedAt, lastAttemptAt: timestamp(old.lastAttemptAt), sourceUpdatedAt,
          sourceTimeBasis: old.sourceTimeBasis === 'previous-identical-list' ? old.sourceTimeBasis : '',
          error: cleanText(old.error, 400), items };
      });
      const archive = reconcileMemeArchive(saved.memes, this.platforms.flatMap(platform => platform.items), {
        now: this.now(), platforms: this.platforms, firstSeenRecords: saved.memeFirstSeen });
      this.memes = archive.memes; this.memeFirstSeen = archive.firstSeenRecords;
    } catch (error) {
      if (error.code !== 'ENOENT') this.persistenceError = '热点缓存读取失败，将尝试重新获取；原文件会在成功保存后更新';
    }
    this.schedule();
    return this.snapshot();
  }
  snapshot() {
    const now = this.now(), cacheLimit = Math.max(60, this.settings.intervalMinutes * 2) * 60 * 1000;
    const platforms = this.platforms.map(platform => {
      const { items, ...meta } = platform;
      const cached = items.length > 0;
      const sourceTime = Date.parse(platform.sourceUpdatedAt), fetchedTime = Date.parse(platform.lastSuccessAt);
      const sourceKnown = Number.isFinite(sourceTime) && sourceTime <= now + 5 * 60 * 1000;
      const sourceDelayed = sourceKnown && now - sourceTime > SOURCE_DELAY_MS;
      const cacheDelayed = !Number.isFinite(fetchedTime) || now - fetchedTime > cacheLimit;
      let freshness = sourceDelayed || cacheDelayed ? 'delayed' : sourceKnown ? 'fresh' : 'unknown';
      let freshnessReason = sourceDelayed ? '来源榜单超过 2 小时未更新' : cacheDelayed ? '本地缓存较旧，等待重新获取' : sourceKnown ? '来源提供了榜单更新时间' : '来源未提供可核验的榜单更新时间';
      if (platform.sourceTimeBasis === 'previous-identical-list') freshnessReason += '；备用来源未提供时间，内容与旧榜单一致，沿用上次来源时间';
      if (platform.error && cached) freshnessReason = `本次获取失败，保留上次成功的缓存；${freshnessReason}`;
      if (!cached) { freshness = 'unknown'; freshnessReason = platform.error ? '暂时无法取得热榜' : '等待首次获取'; }
      const status = !cached ? platform.error ? 'error' : 'empty' : platform.error || sourceDelayed || cacheDelayed ? 'stale' : 'ready';
      return { ...meta, status, freshness, freshnessReason, itemCount: items.length };
    });
    const items = this.platforms.flatMap(platform => platform.items);
    return { items: structuredClone(items), platforms, memes: activeMemes(this.memes, { now, currentItems: items }),
      settings: structuredClone(this.settings), refreshing: Boolean(this.inFlight), lastAttemptAt: this.lastAttemptAt,
      nextRefreshAt: this.nextRefreshAt, schedulerActive: this.autoRefresh && this.settings.enabled && !this.closed,
      persistenceError: this.persistenceError };
  }
  schedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null; this.nextRefreshAt = null;
    if (this.closed || !this.autoRefresh || !this.settings.enabled || this.inFlight) return;
    const last = Date.parse(this.lastAttemptAt);
    const due = Number.isFinite(last) ? Math.max(this.now(), last + this.settings.intervalMinutes * 60000) : this.now();
    this.nextRefreshAt = new Date(due).toISOString();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.startRefresh();
    }, Math.max(0, due - this.now()));
    this.timer?.unref?.();
  }
  startRefresh({ manual = false } = {}) {
    if (this.closed) invalid('热点服务已关闭', 503);
    if (this.inFlight) return this.snapshot();
    const elapsed = this.now() - Date.parse(this.lastAttemptAt);
    if (manual && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MANUAL_COOLDOWN_MS) {
      const error = new Error('刚刚已刷新，请稍等一分钟再试');
      error.status = 429; error.retryAfterMs = MANUAL_COOLDOWN_MS - Math.max(0, elapsed); throw error;
    }
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null; this.nextRefreshAt = null;
    this.lastAttemptAt = new Date(this.now()).toISOString();
    for (const platform of this.platforms) platform.lastAttemptAt = this.lastAttemptAt;
    this.inFlight = Promise.resolve().then(() => this.runRefresh()).catch(() => {
      this.persistenceError = '热点更新未完成，可稍后重试';
    }).finally(() => { this.inFlight = null; this.schedule(); });
    return this.snapshot();
  }
  async refresh(options) {
    this.startRefresh(options);
    await this.inFlight;
    return this.snapshot();
  }
  async runRefresh() {
    await Promise.all(this.platforms.map(async (platform, index) => {
      const failures = [];
      for (const source of sourceList(PLATFORMS[index], this.fallbackBase)) {
        try {
          const payload = await this.fetchJson(source.url);
          const fetchedAt = new Date(this.now()).toISOString();
          const result = normalizeTrendPayload(platform.id, payload, { provider: source.provider, fetchedAt, previousItems: platform.items });
          result.sourceTimeBasis = '';
          // A fallback without a timestamp cannot make an unchanged old board look new.
          if (!result.sourceUpdatedAt && platform.sourceUpdatedAt && result.items.length === platform.items.length && result.items.every((item, i) => item.id === platform.items[i].id && item.rank === platform.items[i].rank)) {
            result.sourceUpdatedAt = platform.sourceUpdatedAt;
            result.sourceTimeBasis = 'previous-identical-list';
            for (const item of result.items) item.sourceUpdatedAt = platform.sourceUpdatedAt;
          }
          Object.assign(platform, { ...result, provider: source.provider, sourceUrl: source.url, lastSuccessAt: fetchedAt, error: '' });
          return;
        } catch (error) {
          if (this.closed) return;
          failures.push(`${source.provider}：${cleanText(error.message, 130)}`);
        }
      }
      platform.error = failures.join('；').slice(0, 400);
    }));
    if (!this.closed) {
      const archive = reconcileMemeArchive(this.memes, this.platforms.flatMap(platform => platform.items), {
        now: this.now(), platforms: this.platforms, firstSeenRecords: this.memeFirstSeen });
      this.memes = archive.memes; this.memeFirstSeen = archive.firstSeenRecords;
      await this.persist();
    }
  }
  async fetchJson(url) {
    const controller = new AbortController(); this.controllers.add(controller);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = this.setTimer(() => { controller.abort(); reject(new Error('请求超时')); }, this.timeoutMs);
      timer?.unref?.();
    });
    const work = async () => {
      let response;
      try { response = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' }); }
      catch (error) { throw new Error(controller.signal.aborted ? '请求已中断或超时' : '网络连接失败'); }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const length = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) { controller.abort(); throw new Error('来源响应过大'); }
      let raw;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('来源响应过大'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        raw = Buffer.concat(chunks).toString('utf8');
      } else {
        raw = await response.text();
        if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error('来源响应过大');
      }
      try { return JSON.parse(raw); } catch { throw new Error('来源未返回有效 JSON'); }
    };
    try { return await Promise.race([work(), timeout]); }
    finally { if (timer !== undefined) this.clearTimer(timer); this.controllers.delete(controller); }
  }
  async persist() {
    this.memes = activeMemes(this.memes, { now: this.now(), currentItems: this.platforms.flatMap(platform => platform.items) });
    const value = JSON.stringify({ version: 1, settings: this.settings, platforms: this.platforms, lastAttemptAt: this.lastAttemptAt,
      memes: this.memes, memeFirstSeen: this.memeFirstSeen }, null, 2);
    const write = async () => {
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, value, { mode: 0o600 }); await rename(temp, this.file); this.persistenceError = '';
      } catch {
        this.persistenceError = '热点缓存保存失败，本次结果只保留在内存中；请检查 data 目录权限和磁盘空间';
        await rm(temp, { force: true }).catch(() => {});
      }
    };
    this.persistenceQueue = this.persistenceQueue.then(write, write);
    await this.persistenceQueue;
  }
  async updateSettings(input) {
    this.settings = validateTrendSettings(input, this.settings);
    this.schedule();
    await this.persist(); return this.snapshot();
  }
  close() {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null; this.nextRefreshAt = null;
    for (const controller of this.controllers) controller.abort();
  }
}
