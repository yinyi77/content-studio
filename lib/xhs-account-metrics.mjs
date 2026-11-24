const totals = ['followers', 'following', 'likes_and_favorites'];
const periodMetrics = ['impressions', 'views', 'cover_click_rate', 'average_view_duration', 'total_view_duration',
  'video_completion_rate', 'likes', 'comments', 'favorites', 'shares', 'net_followers', 'new_followers',
  'lost_followers', 'profile_visitors', 'profile_follow_conversion_rate', 'published_notes', 'published_videos', 'published_images'];
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const text = value => typeof value === 'string' && value.length <= 180 ? value : null;

export function metricsSyncInfo(info) {
  if (!info || !['never', 'queued', 'running', 'succeeded', 'failed', 'canceled'].includes(info.status)) return null;
  return { status: info.status, jobId: /^job_[a-f0-9]{32}$/.test(info.latest_job_id) ? info.latest_job_id : null,
    lastSyncedAt: time(info.last_synced_at), snapshotId: /^job_[a-f0-9]{32}$/.test(info.snapshot_id) ? info.snapshot_id : null,
    error: /^[A-Z][A-Z0-9_]{0,79}$/.test(info.error?.code) ? info.error.code : null };
}

function readValues(keys, raw) {
  return Object.fromEntries(keys.map(key => {
    const item = raw?.[key];
    const number = item?.value_status === 'available' && Number.isFinite(item.value) ? item.value : null;
    return [key, { value: number, unit: ['seconds','percent','count'].includes(item?.unit) ? item.unit : null,
      raw: number === null ? null : text(item.raw_value), approximate: item?.is_approximate === true,
      comparison: Number.isFinite(item?.comparison_percent) ? item.comparison_percent : null }];
  }));
}

export async function readMetrics(client, accountId, period) {
  if (!['7d', '30d'].includes(period)) throw Object.assign(new Error('指标周期支持近 7 天和近 30 天。'), { status: 400 });
  const data = await client.request('/v1/accounts/' + encodeURIComponent(accountId) + '/metrics?period=' + period);
  if (data.account_id !== accountId || data.period !== period || typeof data.has_data !== 'boolean'
    || (data.has_data && (!data.totals || !data.metrics))) {
    throw Object.assign(new Error('指标快照与所选账号、周期或预期格式不符。'), { status: 502 });
  }
  const range = data.date_range;
  return { accountId, period, hasData: data.has_data, sync: metricsSyncInfo(data.sync),
    lastSyncedAt: time(data.last_synced_at), observedAt: time(data.observed_at), platformUpdatedAt: time(data.platform_updated_at),
    dateRange: data.has_data && /^\d{4}-\d{2}-\d{2}$/.test(range?.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(range?.end_date)
      ? { start: range.start_date, end: range.end_date } : null,
    totals: data.has_data ? readValues(totals, data.totals) : null,
    metrics: data.has_data ? readValues(periodMetrics, data.metrics) : null };
}

// Only the account management directory requests totals. Other account lookups stay a single lightweight GET.
export async function includeAccountTotals(client, rows) {
  const available = rows.filter(row => row.enabled !== false && (row.metricsSync?.snapshotId || row.metricsSync?.lastSyncedAt));
  for (let index = 0; index < available.length; index += 4) {
    await Promise.all(available.slice(index, index + 4).map(async row => {
      try {
        const { totals } = await readMetrics(client, row.accountId, '7d');
        if (totals) {
          row.metrics = { ...row.metrics, followers: totals.followers.value, following: totals.following.value,
            likesAndSaves: totals.likes_and_favorites.value };
          row.metricLabels = { followers: totals.followers.raw, following: totals.following.raw, likesAndSaves: totals.likes_and_favorites.raw };
        }
      } catch { row.metricsReadFailed = true; }
    }));
  }
}
