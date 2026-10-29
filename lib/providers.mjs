const MAX_IMAGE = 40 * 1024 * 1024;
export function normalizeBase(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请填写有效的 API 地址，例如 https://你的中转站/v1'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址仅支持 HTTP(S)，不能包含账号、密码、查询参数或锚点');
  url.pathname = url.pathname.replace(/\/(chat\/completions|images\/generations|models)\/?$/, '').replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}
async function boundedBody(response, limit) {
  const parts = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel().catch(() => {}); throw new Error('模型返回的数据超过大小限制'); }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
function upstreamMessage(status, raw) {
  const hints = { 401: 'API Key 无效或已过期', 403: 'API 无权限，请检查模型权限或额度', 404: '接口路径或模型不存在，请检查 Base URL 与模型名', 429: '模型限流或额度不足，请稍后重试' };
  let detail = '';
  try { const data = JSON.parse(raw); detail = String(data.error?.message || data.message || '').slice(0, 220); } catch {}
  return `${hints[status] || `模型服务返回 HTTP ${status}`}${detail ? `：${detail}` : ''}`;
}
async function request(config, suffix, body, timeout = 180000) {
  let response;
  try {
    response = await fetch(`${config.baseUrl}/${suffix}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error',
      signal: AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS) || timeout),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('模型请求超时，请检查中转站状态后重试');
    throw new Error('无法连接模型 API，请检查地址、网络和中转站状态');
  }
  const raw = (await boundedBody(response, MAX_IMAGE * 1.5)).toString('utf8');
  if (!response.ok) {
    const sanitized = config.apiKey ? raw.split(config.apiKey).join('[已隐藏]') : raw;
    const message = upstreamMessage(response.status, sanitized);
    throw new Error(message);
  }
  try { return JSON.parse(raw); } catch { throw new Error('接口未返回 JSON，请确认使用的是 API 地址，而不是中转站网页地址'); }
}
export async function textCompletion(config, messages) {
  const result = await request(config, 'chat/completions', { model: config.model, stream: false, messages });
  const content = result.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(x => x.text || '').join('\n') : '';
  if (!text.trim()) throw new Error('文字模型没有返回内容，请检查模型是否支持 /chat/completions');
  return text;
}
export function parsePlan(text, expected) {
  const raw = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('文字模型没有返回有效的拆页 JSON，请重试分析或更换文字模型');
  let plan;
  try { plan = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error('拆页 JSON 格式不正确，请重试分析或更换文字模型'); }
  if (!Array.isArray(plan.pages) || plan.pages.length !== expected) throw new Error(`模型返回的页数不正确：需要 ${expected} 页，请重试分析`);
  const valid = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!valid(plan.title, 200) || !valid(plan.caption, 12000)) throw new Error('模型返回的作品标题或发布文案不完整，请重试分析');
  for (const page of plan.pages) {
    if (!valid(page.title, 200) || !valid(page.content, 4000) || !valid(page.prompt, 16000)) throw new Error('模型返回的页面内容不完整或过长，请重试分析');
  }
  return plan;
}
export async function listModels(config) {
  const result = await request(config, 'models', null, 20000);
  if (!Array.isArray(result.data)) throw new Error('中转站未返回标准模型列表，可直接手动填写模型名称');
  return result.data.map(x => x.id).filter(x => typeof x === 'string').sort();
}
function imageSource(data) {
  if (data.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
  if (data.data?.[0]?.url) return data.data[0].url;
  const msg = data.choices?.[0]?.message;
  const images = msg?.images || [];
  const image = images[0]?.image_url?.url || images[0]?.url;
  if (image) return image;
  const content = msg?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const url = part.image_url?.url || (part.type === 'image' && part.source?.data ? `data:${part.source.media_type || 'image/png'};base64,${part.source.data}` : null);
      if (url) return url;
    }
  }
  if (typeof content === 'string') {
    const inline = content.match(/data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+/);
    if (inline) return inline[0].trim();
    const markdown = content.match(/!\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)\s*\)/);
    if (markdown) return markdown[1];
    if (/^https?:\/\/\S+$/.test(content.trim())) return content.trim();
  }
  throw new Error('接口没有返回图片。可在模型设置切换 Images / Chat 生图协议，或检查生图模型名称');
}
export function identifyImage(bytes) {
  if (bytes.length < 12 || bytes.length > MAX_IMAGE) throw new Error('模型返回的图片为空、无效或过大');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: 'png', type: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: 'jpg', type: 'image/jpeg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', type: 'image/webp' };
  if (bytes.toString('ascii', 0, 3) === 'GIF') return { extension: 'gif', type: 'image/gif' };
  throw new Error('接口返回的内容不是支持的 PNG/JPEG/WebP/GIF 图片');
}
async function resolveImage(source) {
  if (typeof source !== 'string') throw new Error('模型返回的图片地址无效');
  if (source.startsWith('data:')) {
    const match = source.match(/^data:image\/[\w.+-]+;base64,([\s\S]+)$/);
    if (!match || match[1].length > MAX_IMAGE * 1.5 || !/^[A-Za-z0-9+/=\s]+$/.test(match[1])) throw new Error('模型返回的 Base64 图片无效');
    return Buffer.from(match[1], 'base64');
  }
  let url;
  try { url = new URL(source); } catch { throw new Error('模型返回的图片地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('图片下载地址仅支持 HTTP(S)');
  // Image URLs can be signed CDN URLs. Never forward the model API credential.
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(90000) }); }
  catch { throw new Error('图片下载失败，请检查中转站返回的图片地址是否可访问'); }
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
  return boundedBody(response, MAX_IMAGE);
}
export async function generateImage(config, prompt, aspect) {
  const size = config.size === 'auto' ? ({ '3:4': '1024x1536', '1:1': '1024x1024', '16:9': '1536x1024' }[aspect]) : config.size;
  const data = config.mode === 'chat'
    ? await request(config, 'chat/completions', { model: config.model, stream: false, messages: [{ role: 'user', content: prompt }] }, 300000)
    : await request(config, 'images/generations', { model: config.model, prompt, n: 1, size }, 300000);
  const bytes = await resolveImage(imageSource(data));
  return { bytes, ...identifyImage(bytes) };
}
