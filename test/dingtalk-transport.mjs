import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DWClient } from 'dingtalk-stream';
import { DingtalkTransport, DingtalkTransportError, hardenDingtalkStreamClient } from '../lib/dingtalk-transport.mjs';

// Every API and Stream operation below is injected; no real DingTalk requests or messages.
const SECRET = 'MOCK_DINGTALK_CLIENT_SECRET';
const TOKEN = 'MOCK_DINGTALK_ACCESS_TOKEN';
const CODE = 'MOCK_PRIVATE_DOWNLOAD_CODE';
const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=', 'base64');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function mockSocket(readyState = 0) {
  const socket = new EventEmitter();
  socket.readyState = readyState; socket.frames = [];
  socket.send = (payload, callback) => { socket.frames.push(JSON.parse(payload)); callback?.(); };
  socket.terminate = socket.close = () => { socket.readyState = 3; };
  return socket;
}
function mockStreamClient(options = {}) {
  return {
    connected: false, registered: false, options, acks: [], disconnected: 0, socket: mockSocket(),
    registerCallbackListener(topic, listener) { this.topic = topic; this.listener = listener; },
    socketCallBackResponse(id, value) { this.acks.push({ id, value }); },
    async connect() { this.connected = true; this.socket.readyState = 1; },
    async disconnect() { this.disconnected++; this.connected = false; this.registered = false; this.socket.readyState = 3; },
  };
}

function fixture(t, { fetchImpl, onMessage = async () => {}, clientFactory } = {}) {
  let config = { clientId: 'MOCK_APP', clientSecret: SECRET, robotCode: 'MOCK_ROBOT' };
  const requests = [], states = [], clients = [];
  const factory = clientFactory || (async options => {
    const client = mockStreamClient(options);
    clients.push(client);
    return client;
  });
  const transport = new DingtalkTransport({
    getConfig: () => config, onMessage, onStatus: value => states.push(value), clientFactory: factory,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (fetchImpl) return fetchImpl(String(url), options);
      if (String(url).endsWith('/oauth2/accessToken')) return json({ accessToken: TOKEN, expireIn: 7200 });
      throw new Error('Unexpected network call');
    },
  });
  t.after(() => transport.disconnect());
  return { transport, requests, states, clients, setConfig: value => { config = value; } };
}

test('construction is inert and credential testing only fetches authentication, never sends a message', async t => {
  const f = fixture(t);
  assert.equal(f.clients.length, 0);
  assert.equal(f.requests.length, 0);
  const tested = await f.transport.testCredentials();
  assert.equal(tested.ok, true);
  assert.equal(f.clients.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://api.dingtalk.com/v1.0/oauth2/accessToken');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { appKey: 'MOCK_APP', appSecret: SECRET });
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.doesNotMatch(JSON.stringify(tested), /MOCK_DINGTALK/);
});

test('concurrent authentication shares a token and changed credentials invalidate its cache', async t => {
  const gate = deferred();
  let calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; await gate.promise; return json({ accessToken: TOKEN, expireIn: 7200 }); } });
  const pending = Promise.all([f.transport.testCredentials(), f.transport.testCredentials(), f.transport.testCredentials()]);
  gate.resolve(); await pending;
  assert.equal(calls, 1);
  await f.transport.testCredentials(); assert.equal(calls, 1);
  f.setConfig({ clientId: 'MOCK_SECOND_APP', clientSecret: 'MOCK_NEW_SECRET' });
  await f.transport.testCredentials(); assert.equal(calls, 2);
});

test('Stream subscribes only to bot messages and ACKs only after durable inbox completion', async t => {
  const saved = deferred();
  const received = [];
  const f = fixture(t, { onMessage: async raw => { received.push(raw); await saved.promise; } });
  const result = await f.transport.connect();
  assert.equal(result.state, 'connected');
  const client = f.clients[0];
  assert.deepEqual(client.options.subscriptions, []);
  assert.equal(client.options.debug, false);
  assert.equal(client.topic, ROBOT_TOPIC);
  const raw = { msgId: 'MOCK_MESSAGE', senderStaffId: 'MOCK_USER', conversationType: '1', text: { content: '做一张宣传图' }, sessionWebhook: 'http://127.0.0.1/private' };
  const callback = client.listener({ headers: { messageId: 'MOCK_FRAME' }, data: JSON.stringify(raw) });
  assert.deepEqual(received, [raw]);
  assert.equal(client.acks.length, 0);
  saved.resolve(); await callback;
  assert.deepEqual(client.acks, [{ id: 'MOCK_FRAME', value: { status: 'SUCCESS' } }]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.states.at(-1).state, 'connected');
});

test('the actual SDK can receive and ACK with an open socket and no REGISTERED system frame', async t => {
  const saved = deferred(), received = [];
  const f = fixture(t, {
    onMessage: async raw => { received.push(raw); await saved.promise; },
    clientFactory: async options => {
      const client = new DWClient(options);
      // Preserve actual SDK connect, subscriptions, callback dispatch and ACK.
      // Replace only network operations, reproducing the production handshake:
      // websocket open succeeds and no optional REGISTERED frame ever arrives.
      client.getEndpoint = async function () { this.dw_url = 'wss://wss-open-connection.dingtalk.com/connect?ticket=MOCK'; return this; };
      client._connect = async function () { this.socket = mockSocket(1); this.connected = true; };
      return client;
    },
  });
  const result = await f.transport.connect(), client = f.transport.client;
  assert.equal(client.connected, true); assert.equal(client.socket.readyState, 1); assert.equal(client.registered, false);
  assert.equal(result.state, 'connected');
  assert.equal(f.states.at(-1).state, 'connected');
  assert.deepEqual(client.config.subscriptions, [{ type:'CALLBACK', topic:ROBOT_TOPIC }]);
  const raw = { msgId:'MOCK_MESSAGE', senderStaffId:'MOCK_USER', conversationType:'1', text:{content:'先分析这份需求'} };
  client.onDownStream(JSON.stringify({ type:'CALLBACK',headers:{topic:ROBOT_TOPIC,messageId:'MOCK_SDK_FRAME'},data:JSON.stringify(raw) }), client.socket);
  assert.deepEqual(received, [raw]); assert.equal(client.socket.frames.length, 0);
  saved.resolve(); await Promise.all([...client.callbackTasks]);
  assert.equal(client.socket.frames.length, 1);
  assert.equal(client.socket.frames[0].headers.messageId, 'MOCK_SDK_FRAME');
  assert.deepEqual(JSON.parse(client.socket.frames[0].data), { response:{status:'SUCCESS'} });
  assert.equal(f.requests.length, 0);
});

test('a closed socket with a stale connected flag is rejected and the incomplete connection is cleaned up', async t => {
  const client = mockStreamClient();
  client.connect = async function () { this.connected = true; this.registered = true; this.socket.readyState = 3; };
  const f = fixture(t, {clientFactory:async () => client});
  await assert.rejects(f.transport.connect(), error => error instanceof DingtalkTransportError);
  assert.equal(f.states.at(-1).state, 'error');
  assert.equal(f.states.some(value => value.state === 'connected'), false);
  assert.equal(client.disconnected, 1); assert.equal(f.transport.client, null); assert.equal(f.transport.monitor, null);
});

test('an SDK connect promise that resolves without opening a socket cannot retain an invisible reconnecting client', async t => {
  const client = mockStreamClient();
  client.connect = async () => {};
  const f = fixture(t, {clientFactory:async () => client});
  await assert.rejects(f.transport.connect(), error => error instanceof DingtalkTransportError);
  assert.equal(client.disconnected, 1); assert.equal(f.transport.client, null); assert.equal(f.transport.monitor, null);
  assert.equal(f.transport.connectPromise, null); assert.equal(f.states.at(-1).state, 'error');
});

test('disconnect during the pending websocket handshake cannot be overwritten by a late connect resolution', async t => {
  const entered = deferred(), gate = deferred(), client = mockStreamClient();
  client.connect = async function () { entered.resolve(); await gate.promise; this.connected = true; this.socket.readyState = 1; };
  const f = fixture(t, {clientFactory:async () => client});
  const pending = f.transport.connect(); await entered.promise;
  await f.transport.disconnect(); gate.resolve();
  assert.equal((await pending).state, 'disconnected');
  assert.equal(f.states.at(-1).state, 'disconnected');
  assert.equal(f.states.some(value => value.state === 'connected'), false);
  assert.equal(f.transport.client, null); assert.equal(f.transport.monitor, null);
});

test('inbox failures are not ACKed and raw errors never reach status callbacks', async t => {
  const f = fixture(t, { onMessage: async () => { throw new Error(`${SECRET} ${TOKEN} ${CODE}`); } });
  await f.transport.connect();
  await f.clients[0].listener({ headers: { messageId: 'MOCK_FRAME' }, data: '{"msgId":"MOCK_MESSAGE"}' });
  assert.equal(f.clients[0].acks.length, 0);
  assert.equal(f.states.at(-1).state, 'error');
  assert.doesNotMatch(JSON.stringify(f.states), /MOCK_DINGTALK|MOCK_PRIVATE/);
  await f.clients[0].listener({ headers: { messageId: 'MOCK_FRAME' }, data: 'invalid JSON' });
  assert.equal(f.clients[0].acks.length, 0);
});

test('disconnect during SDK loading and message persistence prevents late connections and ACKs', async t => {
  const factory = deferred();
  let disconnects = 0;
  let connects = 0;
  const f = fixture(t, { clientFactory: () => factory.promise });
  const pending = f.transport.connect();
  await f.transport.disconnect();
  factory.resolve({ disconnect: async () => { disconnects++; }, connect: async () => { connects++; } });
  assert.equal((await pending).state, 'disconnected');
  assert.equal(connects, 0); assert.equal(disconnects, 1);
  assert.equal(f.states.at(-1).state, 'disconnected');

  const saved = deferred();
  const g = fixture(t, { onMessage: () => saved.promise });
  await g.transport.connect();
  const callback = g.clients[0].listener({ headers: { messageId: 'MOCK_FRAME' }, data: '{}' });
  await g.transport.disconnect(); saved.resolve(); await callback;
  assert.equal(g.clients[0].acks.length, 0);
  assert.equal(g.clients[0].disconnected, 1);
});

test('direct messages use one fixed official recipient endpoint and require an acceptance receipt', async t => {
  const f = fixture(t, { fetchImpl: async url => url.endsWith('/oauth2/accessToken') ? json({ accessToken: TOKEN, expireIn: 7200 }) : json({ processQueryKey: 'MOCK_PROCESS' }) });
  const result = await f.transport.sendText({ userId: 'MOCK_USER', title: '创作追问', text: '希望几张图片？' });
  assert.deepEqual(result, { accepted: true, processQueryKey: 'MOCK_PROCESS' });
  const request = f.requests[1];
  assert.equal(request.url, 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');
  assert.equal(request.options.headers['x-acs-dingtalk-access-token'], TOKEN);
  assert.deepEqual(JSON.parse(request.options.body), {
    robotCode: 'MOCK_ROBOT', userIds: ['MOCK_USER'], msgKey: 'sampleMarkdown',
    msgParam: JSON.stringify({ title: '创作追问', text: '希望几张图片？' }),
  });
  assert.doesNotMatch(JSON.stringify(result), /MOCK_DINGTALK/);
});

test('image sending uploads multipart binary then embeds its media ID in a direct markdown message', async t => {
  const f = fixture(t, { fetchImpl: async url => {
    if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: TOKEN, expireIn: 7200 });
    if (url.includes('/media/upload?')) return json({ errcode: 0, media_id: '@MOCK_MEDIA_ID' });
    return json({ processQueryKey: 'MOCK_PROCESS' });
  } });
  assert.equal((await f.transport.sendImage({ userId: 'MOCK_USER', bytes: PNG, name: '../图文.png', mime: 'image/png' })).accepted, true);
  const upload = f.requests[1];
  assert.equal(upload.url, `https://oapi.dingtalk.com/media/upload?access_token=${TOKEN}`);
  assert.ok(upload.options.body instanceof FormData);
  assert.equal(upload.options.body.get('type'), 'image');
  const file = upload.options.body.get('media');
  assert.equal(file.name, '图文.png'); assert.equal(file.type, 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  const payload = JSON.parse(f.requests[2].options.body);
  assert.equal(JSON.parse(payload.msgParam).text, '![图文作品](@MOCK_MEDIA_ID)');
});

test('an explicit group target uses the group endpoint while the following DM keeps its own recipient', async t => {
  const f = fixture(t, { fetchImpl: async url => url.endsWith('/oauth2/accessToken')
    ? json({ accessToken: TOKEN, expireIn: 7200 }) : json({ processQueryKey: 'MOCK_PROCESS' }) });
  const groupId = 'cidMOCK_GROUP_A==';
  const result = await f.transport.sendText({ userId: 'MOCK_SENDER_NOT_RECIPIENT', openConversationId: groupId, title: '群内创作追问', text: '请一次补充创作偏好。' });
  assert.deepEqual(result, { accepted: true, processQueryKey: 'MOCK_PROCESS' });
  const request = f.requests[1];
  assert.equal(request.url, 'https://api.dingtalk.com/v1.0/robot/groupMessages/send');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['x-acs-dingtalk-access-token'], TOKEN);
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(payload, {
    robotCode: 'MOCK_ROBOT', openConversationId: groupId, msgKey: 'sampleMarkdown',
    msgParam: JSON.stringify({ title: '群内创作追问', text: '请一次补充创作偏好。' }),
  });
  assert.equal(Object.hasOwn(payload, 'userIds'), false);
  assert.ok(!request.options.body.includes('MOCK_SENDER_NOT_RECIPIENT'));
  assert.doesNotMatch(JSON.stringify(result), /MOCK_DINGTALK|MOCK_PRIVATE/);

  await f.transport.sendText({ userId: 'MOCK_PRIVATE_USER', text: '私聊仍回到原用户。' });
  assert.equal(f.requests.length, 3, 'same application credentials share the cached token across destinations');
  assert.equal(f.requests[2].url, 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');
  const direct = JSON.parse(f.requests[2].options.body);
  assert.deepEqual(direct.userIds, ['MOCK_PRIVATE_USER']);
  assert.equal(Object.hasOwn(direct, 'openConversationId'), false);
});

test('group images upload first and reuse the application token for a markdown image in the same group', async t => {
  const f = fixture(t, { fetchImpl: async url => {
    if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: TOKEN, expireIn: 7200 });
    if (url.includes('/media/upload?')) return json({ errcode: 0, media_id: '@MOCK_GROUP_MEDIA' });
    return json({ processQueryKey: 'MOCK_GROUP_PROCESS' });
  } });
  const groupId = 'cidMOCK_GROUP_B==';
  await f.transport.sendText({ openConversationId: groupId, text: '以下是完成的图文。' });
  const result = await f.transport.sendImage({ userId: 'MOCK_SENDER_NOT_RECIPIENT', openConversationId: groupId, bytes: PNG, name: '群图文.png', mime: 'image/png' });
  assert.deepEqual(result, { accepted: true, processQueryKey: 'MOCK_GROUP_PROCESS' });
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests.filter(request => request.url.endsWith('/oauth2/accessToken')).length, 1);
  const upload = f.requests[2];
  assert.equal(upload.url, `https://oapi.dingtalk.com/media/upload?access_token=${TOKEN}`);
  assert.equal(upload.options.body.get('type'), 'image');
  const image = upload.options.body.get('media');
  assert.equal(image.name, '群图文.png'); assert.equal(image.type, 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  const send = f.requests[3];
  assert.equal(send.url, 'https://api.dingtalk.com/v1.0/robot/groupMessages/send');
  assert.equal(send.options.headers['x-acs-dingtalk-access-token'], TOKEN);
  assert.deepEqual(JSON.parse(send.options.body), {
    robotCode: 'MOCK_ROBOT', openConversationId: groupId, msgKey: 'sampleMarkdown',
    msgParam: JSON.stringify({ title: '图文作品', text: '![图文作品](@MOCK_GROUP_MEDIA)' }),
  });
  assert.ok(!f.requests.some(request => request.url.includes('/oToMessages/')));
  assert.doesNotMatch(JSON.stringify(result), /MOCK_DINGTALK|MOCK_PRIVATE/);
});

test('invalid explicit group recipients fail before authentication or media upload and never fall back to DM', async t => {
  const f = fixture(t);
  for (const openConversationId of [null, '', ' ', 'cidBAD GROUP', 'cidBAD\nGROUP', 'cidBAD\u0000GROUP', 'g'.repeat(513), 123, {}, ['cidGROUP']]) {
    for (const send of [
      () => f.transport.sendText({ userId: 'MOCK_VALID_DM', openConversationId, text: '不能改发私聊。' }),
      () => f.transport.sendImage({ userId: 'MOCK_VALID_DM', openConversationId, bytes: PNG, mime: 'image/png' }),
    ]) {
      await assert.rejects(send(), error => {
        assert.equal(error.code, 'INVALID_GROUP_RECIPIENT');
        assert.equal(error.definiteFailure, true);
        assert.doesNotMatch(error.message, /MOCK_DINGTALK|MOCK_PRIVATE/);
        return true;
      });
      assert.equal(f.requests.length, 0);
    }
  }
});

test('group rejection is definite while uncertain sends are not retried or redirected to a private recipient', async t => {
  for (const mode of ['text', 'image']) {
    for (const [failureResponse, definite] of [
      [() => json({ code: 'Forbidden', message: `${SECRET} ${TOKEN} ${CODE}` }, 403), true],
      [() => json({ message: `${SECRET} ${TOKEN} ${CODE}` }, 502), false],
      [() => { throw new Error(`network failed ${SECRET} ${TOKEN} ${CODE}`); }, false],
      [() => json({}), false],
    ]) {
      const f = fixture(t, { fetchImpl: async url => {
        if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: TOKEN, expireIn: 7200 });
        if (url.includes('/media/upload?')) return json({ errcode: 0, media_id: '@MOCK_GROUP_MEDIA' });
        return failureResponse();
      } });
      const target = { userId: 'MOCK_VALID_DM', openConversationId: 'cidMOCK_ORIGINAL_GROUP==' };
      const send = mode === 'text' ? f.transport.sendText({ ...target, text: '群创作结果' })
        : f.transport.sendImage({ ...target, bytes: PNG, name: 'result.png', mime: 'image/png' });
      await assert.rejects(send, error => {
        assert.ok(error instanceof DingtalkTransportError);
        assert.equal(error.definiteFailure === true, definite);
        assert.doesNotMatch(error.message, /MOCK_DINGTALK|MOCK_PRIVATE/);
        return true;
      });
      assert.equal(f.requests.length, mode === 'text' ? 2 : 3);
      const sends = f.requests.filter(request => request.url.includes('/robot/') && !request.url.includes('/messageFiles/'));
      assert.equal(sends.length, 1, 'ambiguous POST must not be silently sent again');
      assert.equal(sends[0].url, 'https://api.dingtalk.com/v1.0/robot/groupMessages/send');
      const payload = JSON.parse(sends[0].options.body);
      assert.equal(payload.openConversationId, target.openConversationId);
      assert.equal(Object.hasOwn(payload, 'userIds'), false);
      assert.ok(!f.requests.some(request => request.url.includes('/oToMessages/')));
    }
  }
});

test('a failed group authentication or media upload stops before any group or private message is dispatched', async t => {
  const f = fixture(t, { fetchImpl: async () => { throw new Error(`${SECRET} ${TOKEN}`); } });
  await assert.rejects(f.transport.sendText({ userId: 'MOCK_VALID_DM', openConversationId: 'cidMOCK_GROUP==', text: '群回复' }), error => {
    assert.equal(error.definiteFailure, true); assert.doesNotMatch(error.message, /MOCK_DINGTALK/); return true;
  });
  assert.equal(f.requests.length, 1);
  const g = fixture(t, { fetchImpl: async url => {
    if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: TOKEN, expireIn: 7200 });
    throw new Error(`${SECRET} ${TOKEN} ${CODE}`);
  } });
  await assert.rejects(g.transport.sendImage({ userId: 'MOCK_VALID_DM', openConversationId: 'cidMOCK_GROUP==', bytes: PNG, mime: 'image/png' }), error => {
    assert.equal(error.definiteFailure, true); assert.doesNotMatch(error.message, /MOCK_DINGTALK|MOCK_PRIVATE/); return true;
  });
  assert.equal(g.requests.length, 2);
  assert.ok(![...f.requests,...g.requests].some(request => request.url.includes('/robot/groupMessages/') || request.url.includes('/oToMessages/')));
});

test('known rejection is retryable but an ambiguous message network failure is never marked unaccepted', async t => {
  for (const [response, definite] of [
    [() => json({ code: 'Forbidden', message: SECRET }, 403), true],
    [() => json({ errcode: 400, errmsg: SECRET }), true],
    [() => json({ invalidStaffIdList: ['MOCK_USER'] }), true],
    [() => json({}), false],
    [() => json({ message: SECRET }, 502), false],
    [() => { throw new Error(`socket failed ${TOKEN}`); }, false],
  ]) {
    const f = fixture(t, { fetchImpl: async url => url.endsWith('/oauth2/accessToken') ? json({ accessToken: TOKEN, expireIn: 7200 }) : response() });
    await assert.rejects(f.transport.sendText({ userId: 'MOCK_USER', text: '作品生成完毕' }), error => {
      assert.ok(error instanceof DingtalkTransportError);
      assert.equal(error.definiteFailure === true, definite);
      assert.doesNotMatch(error.message, /MOCK_DINGTALK/);
      return true;
    });
    assert.equal(f.requests.length, 2); // No silent retry of an ambiguous POST.
  }
});

test('authentication and image upload failures are definitively before the message send', async t => {
  const f = fixture(t, { fetchImpl: async () => { throw new Error(SECRET); } });
  await assert.rejects(f.transport.sendText({ userId: 'MOCK_USER', text: '作品' }), error => error.definiteFailure === true);
  assert.equal(f.requests.length, 1);
  const g = fixture(t, { fetchImpl: async url => {
    if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: TOKEN, expireIn: 7200 });
    throw new Error(TOKEN);
  } });
  await assert.rejects(g.transport.sendImage({ userId: 'MOCK_USER', bytes: PNG }), error => error.definiteFailure === true);
  assert.equal(g.requests.length, 2);
});

test('downloadCode exchanges for an official HTTPS file and binary is returned without secrets', async t => {
  const f = fixture(t, { fetchImpl: async url => {
    if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: TOKEN, expireIn: 7200 });
    if (url.endsWith('/messageFiles/download')) return json({ downloadUrl: `https://static.dingtalk.com/mock-image.png?signature=${CODE}` });
    return new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } });
  } });
  const result = await f.transport.downloadImage({ downloadCode: CODE });
  assert.equal(result.name, 'dingtalk-reference.png');
  assert.equal(result.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { robotCode: 'MOCK_ROBOT', downloadCode: CODE });
  assert.equal(f.requests[2].options.headers, undefined); // App token never goes to the signed download URL.
  assert.equal(f.requests[2].options.redirect, 'error');
  assert.doesNotMatch(JSON.stringify(result), /MOCK_DINGTALK|MOCK_PRIVATE/);
});

test('signed downloads reject nonofficial hosts, credentials, redirects, oversized streams and nonimages', async t => {
  for (const url of ['http://static.dingtalk.com/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://dingtalk.com.attacker.example/a', 'https://user:pass@static.dingtalk.com/a', 'https://static.dingtalk.com:8443/a']) {
    const f = fixture(t, { fetchImpl: async endpoint => endpoint.endsWith('/oauth2/accessToken') ? json({ accessToken: TOKEN, expireIn: 7200 }) : json({ downloadUrl: url }) });
    await assert.rejects(f.transport.downloadImage({ downloadCode: CODE }));
    assert.equal(f.requests.length, 2);
  }
  for (const response of [
    () => new Response('not an image'),
    () => new Response(PNG, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    () => new Response(PNG, { headers: { 'content-length': String(9 * 1024 * 1024) } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9 * 1024 * 1024)); controller.close(); } })),
  ]) {
    const f = fixture(t, { fetchImpl: async endpoint => {
      if (endpoint.endsWith('/oauth2/accessToken')) return json({ accessToken: TOKEN, expireIn: 7200 });
      if (endpoint.endsWith('/messageFiles/download')) return json({ downloadUrl: 'https://static.dingtalk.com/image.png' });
      return response();
    } });
    await assert.rejects(f.transport.downloadImage({ downloadCode: CODE }));
    assert.equal(f.requests.length, 3);
  }
});

test('missing config and invalid input fail before any API call', async t => {
  const f = fixture(t);
  f.setConfig({});
  await assert.rejects(f.transport.testCredentials(), error => error.code === 'NOT_CONFIGURED');
  f.setConfig({ clientId: 'MOCK_APP', clientSecret: SECRET });
  await assert.rejects(f.transport.sendText({ userId: '', text: '作品' }), error => error.definiteFailure === true);
  await assert.rejects(f.transport.sendText({ userId: 'MOCK_USER', text: '' }));
  await assert.rejects(f.transport.sendImage({ userId: 'MOCK_USER', bytes: Buffer.from('invalid') }));
  await assert.rejects(f.transport.sendImage({ userId: 'MOCK_USER', bytes: PNG, mime: 'image/jpeg' }));
  assert.equal(f.requests.length, 0);
});

test('SDK instance hardening sanitizes raw socket/API errors without hooking global console', async () => {
  const recorded = [], parsed = [];
  const client = {
    dw_url: `wss://wss-open-connection.dingtalk.com/connect?ticket=${TOKEN}`,
    printDebug: value => recorded.push(value),
    async getEndpoint() { throw Object.assign(new Error(SECRET), { config: { headers: { Authorization: TOKEN } } }); },
    _connect() {
      this.socket = new EventEmitter();
      this.socket.on('error', error => recorded.push(error));
      this.socket.send = (data, callback) => callback(Object.assign(new Error(CODE), { cause: TOKEN }));
      return Promise.resolve();
    },
    onDownStream(data) { parsed.push(JSON.parse(data)); },
  };
  hardenDingtalkStreamClient(client);
  hardenDingtalkStreamClient(client); // Idempotent on reconnects.
  await assert.rejects(client.getEndpoint(), error => {
    assert.doesNotMatch(error.message, /MOCK_/); assert.equal(error.config, undefined); return true;
  });
  client.printDebug({ secret: SECRET });
  await client._connect();
  client.socket.emit('error', Object.assign(new Error(SECRET), { config: { Authorization: TOKEN } }));
  client.socket.send('ACK', error => recorded.push(error));
  assert.equal(recorded.length, 2);
  for (const error of recorded) {
    assert.ok(error instanceof DingtalkTransportError);
    assert.doesNotMatch(error.message, /MOCK_/);
    assert.equal(error.config, undefined); assert.equal(error.cause, undefined);
  }
  client.onDownStream(`{"private":"${CODE}"`);
  assert.equal(parsed.length, 0);
  client.onDownStream('{"type":"CALLBACK","headers":{"topic":"MOCK_TOPIC"},"data":"{}"}');
  assert.equal(parsed.length, 1);
  client.dw_url = `http://127.0.0.1/?ticket=${TOKEN}`;
  assert.throws(() => client._connect(), error => !error.message.includes(TOKEN));
});
