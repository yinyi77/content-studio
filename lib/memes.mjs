export const MEME_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const platformIds = new Set(['weibo', 'douyin', 'xiaohongshu']);
const candidatePattern = /热梗|玩梗|梗图|挑战|魔性|名场面|整活|表情包|抽象|发疯文学|显眼包|同款舞|舞蹈|神曲|闪身步/;
const text = (value, max) => typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
const titleKey = title => text(title, 300).normalize('NFKC').replace(/[\s#＃]/g, '').toLowerCase();
const clock = value => { const result = Number(typeof value === 'function' ? value() : value); return Number.isFinite(result) ? result : Date.now(); };
function stamp(value, now) {
  if (typeof value !== 'string') return null;
  const date = Date.parse(value);
  return Number.isFinite(date) && date <= now + FUTURE_TOLERANCE_MS ? new Date(date).toISOString() : null;
}
function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096 ? url.href : ''; }
  catch { return ''; }
}
export const isMemeCandidateTitle = title => typeof title === 'string' && candidatePattern.test(title);

function firstSeenRecord(value, now) {
  const id = text(value?.id, 128), platform = value?.platform;
  const key = titleKey(value?.titleKey || value?.title);
  const firstSeenAt = stamp(value?.firstSeenAt, now);
  if (!/^[\w:-]{1,128}$/.test(id) || !platformIds.has(platform) || !key || !firstSeenAt) return null;
  return { id, platform, titleKey: key, firstSeenAt, expiresAt: new Date(Date.parse(firstSeenAt) + MEME_TTL_MS).toISOString(),
    lastSeenAt: stamp(value.lastSeenAt, now) || firstSeenAt };
}
function archiveItem(value, now) {
  const record = firstSeenRecord(value, now);
  const title = text(value?.title, 300), url = safeUrl(value?.url);
  const sourceUpdatedAt = stamp(value?.sourceUpdatedAt, now), fetchedAt = stamp(value?.fetchedAt, now);
  if (!record || !isMemeCandidateTitle(title) || !url || !sourceUpdatedAt || !fetchedAt) return null;
  if (Date.parse(sourceUpdatedAt) < Date.parse(record.firstSeenAt) - MEME_TTL_MS) return null;
  return { id: record.id, platform: record.platform, title, url,
    rank: Number.isInteger(value.rank) && value.rank > 0 ? value.rank : 1, heat: text(value.heat, 60),
    description: text(value.description, 1000), provider: text(value.provider, 60), fetchedAt, sourceUpdatedAt,
    firstSeenAt: record.firstSeenAt, expiresAt: record.expiresAt, lastSeenAt: record.lastSeenAt,
    kind: 'meme', category: 'meme' };
}

export function activeMemes(memes = [], { now = Date.now(), currentItems = [] } = {}) {
  const nowMs = clock(now), current = new Set((Array.isArray(currentItems) ? currentItems : []).map(item => item?.id));
  const seen = new Set();
  return (Array.isArray(memes) ? memes : []).flatMap(value => {
    const item = archiveItem(value, nowMs);
    if (!item || Date.parse(item.expiresAt) <= nowMs || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ ...item, inCurrentBoard: current.has(item.id) }];
  }).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 500);
}

export function reconcileMemeArchive(previousMemes = [], items = [], { now = Date.now(), platforms = [], firstSeenRecords = [] } = {}) {
  const nowMs = clock(now);
  const metadata = new Map((Array.isArray(platforms) ? platforms : []).map(platform => [platform?.id, platform]));
  const records = new Map();
  const saveRecord = value => {
    const record = firstSeenRecord(value, nowMs); if (!record) return null;
    const key = `${record.platform}:${record.titleKey}`, previous = records.get(key);
    const first = previous && previous.firstSeenAt <= record.firstSeenAt ? previous : record;
    const latest = previous?.lastSeenAt > record.lastSeenAt ? previous.lastSeenAt : record.lastSeenAt;
    const merged = { ...first, lastSeenAt: latest };
    records.set(key, merged); return merged;
  };
  for (const record of Array.isArray(firstSeenRecords) ? firstSeenRecords : []) saveRecord(record);
  const archive = new Map();
  for (const raw of Array.isArray(previousMemes) ? previousMemes : []) {
    const item = archiveItem(raw, nowMs); if (!item) continue;
    const record = saveRecord(item);
    archive.set(`${item.platform}:${titleKey(item.title)}`, { ...item, id: record.id, firstSeenAt: record.firstSeenAt, expiresAt: record.expiresAt });
  }
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !platformIds.has(item.platform) || !isMemeCandidateTitle(item.title)) continue;
    const platform = metadata.get(item.platform);
    if (platform?.error || platform?.status === 'error') continue;
    const observedAt = stamp(item.fetchedAt, nowMs);
    const key = `${item.platform}:${titleKey(item.title)}`, old = archive.get(key), known = records.get(key);
    if (!observedAt) continue;
    if (old) archive.set(key, { ...old, lastSeenAt: observedAt > old.lastSeenAt ? observedAt : old.lastSeenAt });
    if (known) saveRecord({ ...known, lastSeenAt: observedAt > known.lastSeenAt ? observedAt : known.lastSeenAt });
    const sourceUpdatedAt = stamp(item.sourceUpdatedAt, nowMs);
    if (!sourceUpdatedAt || nowMs - Date.parse(sourceUpdatedAt) > MEME_TTL_MS || platform?.sourceTimeBasis === 'previous-identical-list') continue;
    const firstSeenAt = known?.firstSeenAt || stamp(item.firstSeenAt, nowMs) || observedAt;
    const record = saveRecord({ id: known?.id || item.id, platform: item.platform, title: item.title, firstSeenAt, lastSeenAt: observedAt });
    if (!record || Date.parse(record.expiresAt) <= nowMs) continue;
    const candidate = archiveItem({ ...item, id: record.id, sourceUpdatedAt, firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt }, nowMs);
    if (candidate) archive.set(key, candidate);
  }
  const memes = activeMemes([...archive.values()], { now: nowMs, currentItems: items });
  // Expired content is removed; a bounded first-seen index prevents the same
  // topic from receiving another 14 days just because it was fetched again.
  const retainedRecords = [...records.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 2000);
  return { memes, firstSeenRecords: retainedRecords };
}
