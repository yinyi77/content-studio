const groups = {
  观看: { impressions:'曝光数', views:'观看数', cover_click_rate:'封面点击率', average_view_duration:'平均观看时长',
    total_view_duration:'观看总时长', video_completion_rate:'视频完播率' },
  互动: { likes:'点赞数', comments:'评论数', favorites:'收藏数', shares:'分享数' },
  粉丝: { net_followers:'净涨粉', new_followers:'新增关注', lost_followers:'取消关注', profile_visitors:'主页访客',
    profile_follow_conversion_rate:'主页转粉率' },
  发布: { published_notes:'总发布', published_videos:'发布视频', published_images:'发布图文' },
};
const diagnostics = {
  METRICS_PERMISSION_REQUIRED:'账号的数据看板尚未开放权限。',
  METRICS_PERIOD_UNKNOWN:'服务未能识别统计周期。', METRICS_PERIOD_MISMATCH:'服务读到的指标周期不一致。',
  METRICS_PAGE_CHANGED:'服务暂时无法识别数据看板。', METRICS_CHANGED_DURING_SYNC:'读取过程中页面数据发生变化。',
};
const activeJob = job => job && ['queued','running'].includes(job.status);

function metricNumber(metric) {
  if (!Number.isFinite(metric?.value)) return '—';
  if (metric.raw) return metric.raw;
  const unit = metric.unit === 'percent' ? '%' : metric.unit === 'seconds' ? ' 秒' : '';
  return (metric.approximate ? '约 ' : '') + metric.value.toLocaleString('zh-CN') + unit;
}

export function createAccountMetrics({api, escape, redraw, updateTotals, formatDate, providerKey}) {
  let page = null, pollTimer;
  const retryKeys = new Map();
  function savedKey(key) {
    let value=retryKeys.get(key);
    try { value ||= sessionStorage.getItem(key); } catch {}
    return typeof value==='string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  }
  function remember(key, value) {
    if (value) retryKeys.set(key,value); else retryKeys.delete(key);
    try { if (value) sessionStorage.setItem(key,value); else sessionStorage.removeItem(key); } catch {}
  }
  const base = id => '/api/xhs/accounts/' + encodeURIComponent(id) + '/metrics';
  const button = (kind, label, disabled = false) => '<button type="button" class="button button-secondary" data-action="xhs-metrics-' + kind +
    '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';

  function reset() {
    clearTimeout(pollTimer);
    page = null;
  }

  function panel(row) {
    if (!row.metricsSync) return '';
    const here = page?.id === row.accountId ? page : null;
    const period = here?.period || '7d', data = here?.data;
    const sync = here?.job || data?.sync || row.metricsSync;
    const pending = activeJob(sync), busy = !here || here.loading || here.submitting;
    const tabs = ['7d','30d'].map(key => '<button type="button" data-action="xhs-metrics-period" data-kind="' + key +
      '" aria-pressed="' + (period===key) + '" class="' + (period===key?'is-active':'') + '"' + (here?.submitting ? ' disabled' : '') + '>近 ' + key.slice(0,-1) + ' 天</button>').join('');
    let summary = '';
    if (data?.hasData) {
      if (data.dateRange) summary += '<span>统计周期 ' + escape(data.dateRange.start) + ' 至 ' + escape(data.dateRange.end) + '</span>';
      if (data.lastSyncedAt) summary += '<span>最近同步 ' + escape(formatDate(data.lastSyncedAt)) + '</span>';
    }
    let status = '';
    if (here?.error) status += '<p class="xhs-inline-error" role="alert">' + escape(here.error) + '</p>';
    if (here?.submitting) status += '<p class="xhs-list-footnote" role="status">正在提交同步任务…</p>';
    else if (pending) status += '<p class="xhs-list-footnote" role="status">' + (sync.status==='queued' ? '指标同步已排队。' : '正在同步账号指标。') + (row.paused?' 账号已暂停，恢复后继续。':'') + '</p>';
    else if (sync?.status === 'failed' || sync?.status === 'canceled') {
      const reason = diagnostics[sync.error] || (sync.status==='canceled' ? '指标同步已取消。' : '本次指标同步失败。');
      status += '<p class="xhs-inline-error" role="status">' + escape(reason + (data?.hasData ? ' 当前显示上次同步的快照。' : '')) + '</p>';
    }
    let main = '';
    if (data?.hasData) {
      main = Object.entries(groups).map(([group, keys]) => {
        const cells = Object.entries(keys).map(([key, label]) => {
          const metric = data.metrics[key], change = metric?.comparison;
          return '<div><dt>' + label + '</dt><dd>' + escape(metricNumber(metric)) +
            (Number.isFinite(change) ? ' <small>环比 ' + (change>0?'+':'') + escape(change) + '%</small>' : '') + '</dd></div>';
        }).join('');
        return '<section class="xhs-metric-group"><h3>' + group + '</h3><dl class="xhs-runtime-fields">' + cells + '</dl></section>';
      }).join('');
    } else if (busy) main = '<div class="xhs-data-empty" role="status">正在读取指标…</div>';
    else if (!here.error) main = '<div class="xhs-data-empty">暂无指标快照。点击「同步指标」读取账号主页与数据看板。</div>';
    return '<section class="panel" aria-label="周期指标"><div class="xhs-section-heading"><h2>周期指标</h2><div class="xhs-row-actions">' +
      (here?.error ? button('read', '重新读取', busy) : '') +
      button('sync', here && savedKey(here.key) ? '重试本次同步' : '同步指标', Boolean(busy || pending || row.enabled===false)) +
      '</div></div><div class="xhs-draft-toolbar"><div class="xhs-draft-source" role="group" aria-label="统计周期">' + tabs +
      '</div></div>' + status + (summary?'<div class="xhs-official-summary">' + summary + '</div>':'') + main + '</section>';
  }

  async function poll(here) {
    if (here !== page || !activeJob(here.job)) return;
    const id = here.job.jobId;
    try {
      const {job} = await api(base(here.id) + '/sync/' + encodeURIComponent(id));
      if (here !== page) return;
      if (job?.accountId!==here.id || job.jobId!==id || job.action!=='sync_metrics') throw Error('指标任务与当前账号不匹配。');
      here.job = job;
      if (!activeJob(job)) return read(here);
      redraw();
      watch(here);
    } catch (e) {
      if (here !== page) return;
      here.error = e.message;
      redraw();
    }
  }

  function watch(here) {
    clearTimeout(pollTimer);
    if (activeJob(here.job) && here.job.jobId) pollTimer=setTimeout(() => poll(here), 3500);
  }

  async function read(here) {
    clearTimeout(pollTimer);
    here.loading = true;
    here.error = '';
    redraw();
    try {
      const data = await api(base(here.id) + '?period=' + here.period);
      if (page !== here) return;
      if (data.accountId!==here.id || data.period!==here.period || typeof data.hasData!=='boolean') throw Error('指标快照与所选账号或周期不一致。');
      here.data = data;
      here.job = data.sync;
      updateTotals(here.id, data);
      watch(here);
    } catch (e) {
      if (page !== here) return;
      here.error = e.message;
    } finally {
      if (page === here) { here.loading = false; redraw(); }
    }
  }

  function show(row, period = '7d', refresh = false) {
    if (!row?.metricsSync || !['7d','30d'].includes(period)) return;
    const same = page?.id === row.accountId && page.period === period;
    if (same && (!refresh || page.loading || page.submitting)) return;
    clearTimeout(pollTimer);
    page = { id:row.accountId, key:'xhs-metrics-sync:' + providerKey() + ':' + row.accountId,
      period, data:same?page.data:null, job:same?page.job:null };
    return read(page);
  }

  async function sync() {
    const here = page;
    if (!here || here.loading || here.submitting || activeJob(here.job)) return;
    const requestId = savedKey(here.key) || crypto.randomUUID();
    remember(here.key, requestId);
    here.submitting=true; here.error=''; redraw();
    try {
      const {job} = await api(base(here.id) + '/sync', {method:'POST', body:{requestId}});
      if (job?.accountId!==here.id || job.action!=='sync_metrics' || !job.jobId) throw Error('指标任务与当前账号不匹配。');
      remember(here.key, null);
      if (here!==page) return;
      here.job=job;
      if (activeJob(job)) watch(here); else await read(here);
    } catch(e) {
      if (here!==page) return;
      here.error=e.message;
    } finally {
      if (here===page) { here.submitting=false; redraw(); }
    }
  }

  return { reset, panel, sync, show, currentPeriod: () => page?.period || '7d' };
}
