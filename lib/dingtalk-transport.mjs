import { createHash } from 'node:crypto';

const API = 'https://api.dingtalk.com';
const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;
const CONNECT_TIMEOUT_MS = 30_000;

// The Stream protocol is ready after the authenticated WebSocket handshake.
// REGISTERED is an optional SDK system event, not a required server response:
// https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/
const streamOpen = client => Boolean(client?.connected && client.socket?.readyState === 1);

export class DingtalkTransportError extends Error {
  constructor(message, { code = 'DINGTALK_ERROR', definiteFailure = false } = {}) {
    super(message);
    this.name = 'DingtalkTransportError';
    this.code = code;
    if (definiteFailure) this.definiteFailure = true;
  }
}

function fail(message, options) {
  return new DingtalkTransportError(message, options);
}

function configuration(raw = {}) {
  const clientId = String(raw.clientId || '').trim();
  const clientSecret = String(raw.clientSecret || '').trim();
  if (!clientId || !clientSecret) {
    throw fail('请先填写钉钉 Client ID 和 Client Secret。', { definiteFailure: true, code: 'NOT_CONFIGURED' });
  }
  return { clientId, clientSecret, robotCode: String(raw.robotCode || clientId).trim() };
}

function credentialKey(config) {
  return createHash('sha256').update(`${config.clientId}\0${config.clientSecret}`).digest('hex');
}

async function readBody(response, limit) {
  const tooLarge = () => fail(limit === MAX_IMAGE_BYTES ? '钉钉返回的图片超过 8 MB。' : '钉钉返回的响应体积超过限制。', { code: 'TOO_LARGE' });
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', extension: 'webp' };
  }
  throw fail('仅支持 PNG、JPEG 或 WebP 图片。', { definiteFailure: true, code: 'INVALID_IMAGE' });
}

function downloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('钉钉未返回有效的图片下载地址。'); }
  const allowed = ['dingtalk.com', 'alicdn.com', 'aliyuncs.com'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !allowed.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw fail('钉钉图片下载地址不在受信任的官方域名内。', { code: 'UNSAFE_DOWNLOAD' });
  }
  url.hash = '';
  return url.href;
}

function recipient(value) {
  const userId = String(value || '').trim();
  if (!userId || userId.length > 256 || /[\s\x00-\x1f\x7f]/u.test(userId)) {
    throw fail('缺少有效的钉钉用户 ID。', { definiteFailure: true, code: 'INVALID_RECIPIENT' });
  }
  return userId;
}

function destination({ userId, openConversationId }) {
  // An explicitly supplied group destination must never fall back to a DM.
  if (openConversationId !== undefined) {
    if (typeof openConversationId !== 'string' || !openConversationId.trim()
        || openConversationId.length > 512 || /[\s\x00-\x1f\x7f]/u.test(openConversationId)) {
      throw fail('缺少有效的原群会话 ID，未改发私聊。', { definiteFailure: true, code: 'INVALID_GROUP_RECIPIENT' });
    }
    return { path: 'groupMessages/send', fields: { openConversationId } };
  }
  return { path: 'oToMessages/batchSend', fields: { userIds: [recipient(userId)] } };
}

async function defaultClientFactory(options) {
  const sdk = await import('dingtalk-stream');
  return new sdk.DWClient(options);
}

const hardenedClient = Symbol('hardenedDingtalkClient');

/**
 * SDK 2.1.7-beta.1 has no logger option and some branches log raw errors even
 * with debug:false. Harden this instance only, before its socket can emit.
 * The socket/dw_url hooks are deliberately isolated here and covered by mocks.
 */
export function hardenDingtalkStreamClient(client) {
  if (client[hardenedClient]) return client;
  client[hardenedClient] = true;
  client.printDebug = () => {};
  const safeError = () => fail('钉钉 Stream 网络操作失败。', { code: 'STREAM_NETWORK_ERROR' });
  const validateEndpoint = () => {
    let url;
    try { url = new URL(client.dw_url); } catch { throw safeError(); }
    if (url.protocol !== 'wss:' || url.username || url.password || (url.port && url.port !== '443')
        || !['dingtalk.com', 'aliyuncs.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw safeError();
    }
  };
  if (typeof client.getEndpoint === 'function') {
    const getEndpoint = client.getEndpoint;
    client.getEndpoint = async function (...args) {
      try {
        const result = await getEndpoint.apply(this, args);
        validateEndpoint();
        return result;
      } catch { throw safeError(); }
    };
  }
  if (typeof client._connect === 'function') {
    const connectSocket = client._connect;
    client._connect = function (...args) {
      // Invalid URL constructor errors include the signed URL in the SDK log.
      validateEndpoint();
      const pending = connectSocket.apply(this, args);
      const socket = this.socket;
      if (socket?.listeners && socket?.removeListener && socket?.on) {
        for (const listener of socket.listeners('error')) {
          socket.removeListener('error', listener);
          socket.on('error', function () { listener.call(this, safeError()); });
        }
        if (typeof socket.send === 'function') {
          const send = socket.send;
          socket.send = function (...sendArgs) {
            const last = sendArgs.length - 1;
            if (typeof sendArgs[last] === 'function') {
              const callback = sendArgs[last];
              sendArgs[last] = error => callback(error ? safeError() : undefined);
            }
            try { return send.apply(this, sendArgs); } catch { throw safeError(); }
          };
        }
      }
      return pending;
    };
  }
  if (typeof client.onDownStream === 'function') {
    const onDownStream = client.onDownStream;
    client.onDownStream = function (data, socket) {
      // JSON.parse errors in newer Node versions can include a raw data excerpt.
      try {
        if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_JSON_BYTES) return;
        const frame = JSON.parse(data);
        if (!frame || !frame.headers || typeof frame.headers.topic !== 'string') return;
      } catch { return; }
      return onDownStream.call(this, data, socket);
    };
  }
  return client;
}

/** Fixed official endpoints only; incoming sessionWebhook URLs are never used. */
export class DingtalkTransport {
  constructor({ getConfig, onMessage, onStatus = () => {}, fetchImpl = globalThis.fetch, clientFactory = defaultClientFactory }) {
    if (typeof getConfig !== 'function' || typeof onMessage !== 'function') {
      throw new TypeError('getConfig and onMessage are required');
    }
    this.getConfig = getConfig;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.fetchImpl = fetchImpl;
    this.clientFactory = clientFactory;
    this.client = null;
    this.connectionGeneration = 0;
    this.token = null;
    this.tokenRequest = null;
    this.monitor = null;
    this.connectPromise = null;
    this.status = { state: 'disconnected', message: '尚未连接钉钉。' };
  }

  _status(state, message) {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    try { Promise.resolve(this.onStatus({ ...this.status })).catch(() => {}); } catch { /* A UI listener cannot break delivery. */ }
  }

  async _request(url, options, consume, { timeoutMs = REQUEST_TIMEOUT_MS, delivery = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) this.token = null;
        const guidance = response.status === 401 ? '应用凭证无效或已过期，请检查 Client ID 和 Client Secret。'
          : response.status === 403 ? '权限不足，请检查机器人权限与应用可见范围。'
            : response.status === 429 ? '请求过于频繁，请稍后重试。' : '请求未完成，请检查钉钉应用配置后重试。';
        throw fail(`钉钉接口返回 HTTP ${response.status}：${guidance}`, {
          code: `HTTP_${response.status}`,
          definiteFailure: !delivery || (response.status >= 400 && response.status < 500),
        });
      }
      return await consume(response);
    } catch (error) {
      if (error instanceof DingtalkTransportError) throw error;
      // Never expose raw fetch/SDK errors: they may contain a signed URL or token.
      throw fail(controller.signal.aborted ? '钉钉请求超时，请稍后检查处理结果。' : '无法连接钉钉服务，请检查网络后重试。', {
        code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', definiteFailure: !delivery,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async _json(url, options, requestOptions) {
    return this._request(url, options, async (response) => {
      const bytes = await readBody(response, MAX_JSON_BYTES);
      let result;
      try { result = JSON.parse(bytes.toString('utf8')); } catch {
        throw fail('钉钉返回了无法解析的响应，请稍后检查处理结果。', { code: 'INVALID_RESPONSE' });
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw fail('钉钉返回了无效响应，请稍后检查处理结果。', { code: 'INVALID_RESPONSE' });
      }
      if ((result.errcode !== undefined && Number(result.errcode) !== 0)
          || (result.code !== undefined && !['0', '200', 'OK'].includes(String(result.code)))) {
        throw fail('钉钉拒绝了此次请求，请检查应用权限、机器人配置和用户可见范围。', {
          definiteFailure: true, code: 'API_REJECTED',
        });
      }
      return result;
    }, requestOptions);
  }

  async _accessToken(config = configuration(this.getConfig())) {
    const key = credentialKey(config);
    if (this.token?.key === key && Date.now() < this.token.expiresAt) return this.token.value;
    if (this.tokenRequest?.key === key) return this.tokenRequest.promise;
    const promise = (async () => {
      const result = await this._json(`${API}/v1.0/oauth2/accessToken`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appKey: config.clientId, appSecret: config.clientSecret }),
      });
      const seconds = Number(result.expireIn);
      if (typeof result.accessToken !== 'string' || !result.accessToken || !Number.isFinite(seconds) || seconds <= 0) {
        throw fail('钉钉未返回有效的应用令牌，请检查应用凭证。', { definiteFailure: true, code: 'INVALID_TOKEN' });
      }
      const reserve = Math.min(300, seconds / 10);
      // A config change during authentication must not cache credentials for the new app.
      if (credentialKey(configuration(this.getConfig())) === key) {
        this.token = { key, value: result.accessToken, expiresAt: Date.now() + (seconds - reserve) * 1000 };
      }
      return result.accessToken;
    })();
    this.tokenRequest = { key, promise };
    try { return await promise; } finally {
      if (this.tokenRequest?.promise === promise) this.tokenRequest = null;
    }
  }

  async testCredentials() {
    await this._accessToken();
    return { ok: true, message: '应用凭证验证通过，尚未发送消息。' };
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    if (this.client) return Promise.resolve({ ok: true, ...this.status });
    const config = configuration(this.getConfig());
    const generation = ++this.connectionGeneration;
    this._status('connecting', '正在连接钉钉 Stream。');
    const promise = this._connect(config, generation);
    this.connectPromise = promise;
    void promise.finally(() => {
      if (this.connectPromise === promise) this.connectPromise = null;
    }).catch(() => {});
    return promise;
  }

  async _connect(config, generation) {
    let client;
    try {
      client = hardenDingtalkStreamClient(await this.clientFactory({
        clientId: config.clientId, clientSecret: config.clientSecret, debug: false,
        keepAlive: true, autoReconnect: true, subscriptions: [], maxPendingCallbackHandlers: 20,
      }));
      if (generation !== this.connectionGeneration) {
        await client.disconnect();
        return { ok: false, state: 'disconnected' };
      }
      this.client = client;
      client.registerCallbackListener(ROBOT_TOPIC, async (frame) => {
        if (generation !== this.connectionGeneration || this.client !== client) return;
        const messageId = frame?.headers?.messageId;
        if (typeof messageId !== 'string' || !messageId) return;
        try {
          if (typeof frame.data !== 'string' || Buffer.byteLength(frame.data) > MAX_JSON_BYTES) {
            this._status('error', '收到无效的钉钉消息，等待平台重试。');
            return;
          }
          const raw = JSON.parse(frame.data);
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
          // This callback persists the inbox only. Model work runs in a separate worker.
          await this.onMessage(raw);
          if (generation === this.connectionGeneration && this.client === client) {
            client.socketCallBackResponse(messageId, { status: 'SUCCESS' });
          }
        } catch {
          // No ACK until inbox persistence succeeds; never pass raw errors to SDK logging.
          this._status('error', '消息接收暂未完成，钉钉会自动重试。');
        }
      });
      const updateStatus = () => {
        if (generation !== this.connectionGeneration || this.client !== client) return;
        if (streamOpen(client)) this._status('connected', '已连接钉钉，正在接收创作消息。');
        else if (this.status.state === 'connected') this._status('connecting', '连接已中断，正在自动重连。');
      };
      this.monitor = setInterval(updateStatus, 500);
      this.monitor.unref?.();
      let connectionTimer;
      try {
        await Promise.race([
          client.connect(),
          new Promise((_, reject) => {
            connectionTimer = setTimeout(() => reject(fail('钉钉 Stream 连接超时，请检查网络后重试。', { code: 'STREAM_TIMEOUT' })), CONNECT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(connectionTimer);
      }
      if (generation !== this.connectionGeneration) return { ok: false, state: 'disconnected' };
      updateStatus();
      if (!streamOpen(client)) {
        throw fail('Stream 连接失败，请检查钉钉应用的 Stream 模式与网络。', { code: 'STREAM_CONNECT_FAILED' });
      }
      return { ok: true, ...this.status };
    } catch (error) {
      if (generation !== this.connectionGeneration) return { ok: false, state: 'disconnected' };
      // SDK connect() may resolve after swallowing an opening failure. Clean up
      // both rejected and resolved-but-closed clients so retries start afresh.
      clearInterval(this.monitor);
      this.monitor = null;
      if (this.client === client) this.client = null;
      try { await client?.disconnect(); } catch { /* Never log raw SDK errors. */ }
      if (generation !== this.connectionGeneration) return { ok: false, state: 'disconnected' };
      this._status('error', '无法启动钉钉 Stream，请检查依赖安装、应用配置与网络。');
      if (error instanceof DingtalkTransportError) throw error;
      throw fail('无法连接钉钉 Stream，请检查应用配置与网络。', { code: 'STREAM_CONNECT_FAILED' });
    }
  }

  async disconnect() {
    ++this.connectionGeneration;
    clearInterval(this.monitor);
    this.monitor = null;
    this.connectPromise = null;
    const client = this.client;
    this.client = null;
    try { await client?.disconnect(); } catch { /* Stop locally even if SDK cleanup fails. */ }
    this._status('disconnected', '已断开钉钉连接。');
    return { ok: true };
  }

  async _sendMarkdown({ target, text, title }, config) {
    let token;
    try { token = await this._accessToken(config); } catch (error) {
      // Authentication happens before sending, so no chat message was accepted.
      if (error instanceof DingtalkTransportError) error.definiteFailure = true;
      throw error;
    }
    const result = await this._json(`${API}/v1.0/robot/${target.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        robotCode: config.robotCode, ...target.fields, msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title, text }),
      }),
    }, { delivery: true });
    if (result.invalidStaffIdList?.length || result.flowControlledStaffIdList?.length) {
      throw fail('钉钉未接受该用户的消息，请检查应用可见范围或稍后重试。', { definiteFailure: true, code: 'RECIPIENT_REJECTED' });
    }
    if (typeof result.processQueryKey !== 'string' || !result.processQueryKey) {
      throw fail('钉钉未返回消息受理凭据，请先检查钉钉中的处理结果。', { code: 'DELIVERY_UNKNOWN' });
    }
    return { accepted: true, processQueryKey: result.processQueryKey };
  }

  async sendText({ userId, openConversationId, text, title = '图文工坊' }) {
    const config = configuration(this.getConfig());
    const content = String(text || '').trim();
    if (!content || Buffer.byteLength(content) > 18_000) {
      throw fail('发送的消息为空或过长，请分段后重试。', { definiteFailure: true, code: 'INVALID_TEXT' });
    }
    return this._sendMarkdown({ target: destination({ userId, openConversationId }), text: content, title: String(title || '图文工坊').slice(0, 100) }, config);
  }

  async sendImage({ userId, openConversationId, bytes, name = 'image.png', mime }) {
    const config = configuration(this.getConfig());
    const target = destination({ userId, openConversationId });
    const image = bytes instanceof Uint8Array ? Buffer.from(bytes) : null;
    if (!image?.length || image.length > MAX_IMAGE_BYTES) {
      throw fail('图片为空或超过 8 MB，无法发送到钉钉。', { definiteFailure: true, code: 'INVALID_IMAGE_SIZE' });
    }
    const type = imageType(image);
    if (mime && mime !== type.mime) {
      throw fail('图片格式与文件内容不一致。', { definiteFailure: true, code: 'INVALID_IMAGE' });
    }
    let mediaId;
    try {
      const token = await this._accessToken(config);
      const body = new FormData();
      body.set('type', 'image');
      const filename = String(name).split(/[\\/]/u).pop().replace(/[\x00-\x1f\x7f]/gu, '').slice(0, 100) || `image.${type.extension}`;
      body.set('media', new Blob([image], { type: type.mime }), filename);
      const result = await this._json(`https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(token)}`, { method: 'POST', body });
      mediaId = result.media_id;
      if (typeof mediaId !== 'string' || !/^@[a-zA-Z0-9_-]+$/u.test(mediaId)) {
        throw fail('钉钉未返回有效的图片媒体标识。', { code: 'INVALID_MEDIA' });
      }
    } catch (error) {
      // Uploading media cannot itself send a chat message, so retrying this stage is safe.
      if (error instanceof DingtalkTransportError) error.definiteFailure = true;
      throw error;
    }
    return this._sendMarkdown({ target, title: '图文作品', text: `![图文作品](${mediaId})` }, config);
  }

  async downloadImage({ downloadCode }) {
    const config = configuration(this.getConfig());
    if (typeof downloadCode !== 'string' || !downloadCode || downloadCode.length > 8192) {
      throw fail('缺少有效的钉钉图片下载凭据。', { code: 'INVALID_DOWNLOAD_CODE' });
    }
    const token = await this._accessToken(config);
    const result = await this._json(`${API}/v1.0/robot/messageFiles/download`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ robotCode: config.robotCode, downloadCode }),
    });
    const url = downloadUrl(result.downloadUrl);
    const bytes = await this._request(url, { method: 'GET' }, async (response) => readBody(response, MAX_IMAGE_BYTES));
    const type = imageType(bytes);
    return { name: `dingtalk-reference.${type.extension}`, dataUrl: `data:${type.mime};base64,${bytes.toString('base64')}` };
  }
}
