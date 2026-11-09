import test from 'node:test';
import assert from 'node:assert/strict';
import { chatActionMessages, parseChatAction, resolveAppendIntent } from '../lib/chat-creation.mjs';

const page = index => ({ id: `old-${index}`, title: `已有图片${index}`, content: '已经确认的真实文字', prompt: '已有画面', status: 'done', imageUrl: `/media/existing-${index}.png` });
const project = (count = 1, messages = []) => ({ id: 'current', title: '真实工具案例', caption: '现有发布正文', source: '介绍真实案例，不虚构功能', count, mode: count === 1 ? 'cover' : 'cards', style: 'warm', aspect: '3:4', status: 'completed', pages: Array.from({ length: count }, (_, index) => page(index + 1)), chatMessages: messages });
const additions = count => Array.from({ length: count }, (_, index) => ({ title: `新增主题${index + 1}`, content: `新增真实文字${index + 1}`, prompt: `沿用暖色和留白，为第${index + 1}张新图安排独立画面。` }));
const encode = (count, extra = {}) => JSON.stringify({ action: 'append_pages', reply: '补充所需的内容页，保留原图。', pages: additions(count), ...extra });
const pendingMessages = () => [
  { role: 'assistant', action: 'create', status: 'completed', content: '已经生成一张封面。' },
  { role: 'user', requestId: 'append-request', content: '在给我4张配图，一张太少了' },
  { role: 'assistant', action: 'reply', content: '选一种安排：\n· 方案 A：保留1张封面，追加4张内容页，共5张。\n· 方案 B：只做4张，不要封面。\n· 方案 C：保留封面，追加4张氛围配图。' },
];

test('explicit append requests resolve additional and total counts without changing the existing work', () => {
  const work = project(), before = structuredClone(work);
  for (const message of ['在给我4张配图，一张太少了', '再给我4张配图', '请再增加四张图片', '保留原封面，另外生成4张配图', '不要重画已有图片，再补4张']) {
    const intent = resolveAppendIntent(work, message);
    assert.equal(intent.additionalCount, 4, message); assert.equal(intent.totalCount, 5, message); assert.equal(intent.resumedFromHistory, false);
    const result = parseChatAction(encode(4), work, message);
    assert.equal(result.action, 'append_pages'); assert.equal(result.pages.length, 4);
  }
  for (const message of ['补到5张', '把数量改成5张', '将这组增加到五张']) {
    const intent = resolveAppendIntent(work, message);
    assert.equal(intent.additionalCount, 4, message); assert.equal(intent.totalCount, 5, message);
  }
  assert.deepEqual(work, before, 'Parsing cannot mutate existing pages, identity, title or copy');
});

test('the current appended user message is skipped when resolving the latest unfulfilled choice or confirmation', () => {
  const messages = pendingMessages(), work = project(1, messages);
  const selected = resolveAppendIntent(work, 'A');
  assert.equal(selected.additionalCount, 4); assert.equal(selected.resumedFromHistory, true); assert.equal(selected.sourceRequestId, 'append-request');
  work.chatMessages.push({ role: 'user', content: 'A' }, { role: 'assistant', action: 'reply', content: '按A安排，保留封面并追加4张，请确认。' }, { role: 'user', content: '确定' });
  const confirmed = resolveAppendIntent(work, '确定');
  assert.equal(confirmed.additionalCount, 4); assert.equal(confirmed.totalCount, 5); assert.equal(confirmed.resumedFromHistory, true);
  const result = parseChatAction(encode(4), work, '确定');
  assert.equal(result.action, 'append_pages'); assert.equal(result.pages.length, 4);
  assert.equal(resolveAppendIntent(project(1, messages), 'B'), null, 'Removing the cover is not an append authorization');
});

test('cancelled, already executed, unrelated, conditional and generic confirmations do not repeat paid append work', () => {
  for (const tail of [
    [{ role: 'user', content: '先别做了' }, { role: 'assistant', action: 'reply', content: '已暂停。' }],
    [{ role: 'user', content: '换个新主题做猫咪' }, { role: 'assistant', action: 'reply', content: '请补充新主题要求。' }],
    [{ role: 'assistant', action: 'append_pages', status: 'completed', content: '已补好。' }],
    [{ role: 'assistant', action: 'append_pages', status: 'error', content: '新增页已有结果，仅重试失败页。' }],
    [{ role: 'user', content: '帖子标题改成新标题' }, { role: 'assistant', action: 'update_post', status: 'completed', content: '标题已改。' }],
    [{ role: 'user', content: '文案字数限制多少' }, { role: 'assistant', action: 'reply', content: '可以在平台编辑。' }],
  ]) assert.equal(resolveAppendIntent(project(1, [...pendingMessages(), ...tail]), '确定'), null);
  for (const message of ['好的', '好', '可以']) assert.equal(resolveAppendIntent(project(1, pendingMessages()), message), null);
  const conditional = project(1, [{ role: 'user', content: '如果我确认，再补4张' }, { role: 'assistant', action: 'reply', content: '等待确认。' }]);
  assert.equal(resolveAppendIntent(conditional, '确定'), null);
});

test('quoted copy, consultation, reductions and over-budget counts cannot authorize appended images', () => {
  const work = project();
  for (const message of ['怎么再给我4张配图？', '再补4张需要多少钱？', '如果可以，再给我4张', '先别生成，再补4张', '正文改成“再给我4张配图”', '把正文改成以下内容：\n再给我4张配图', '```\n再补4张\n```', '不要追加图片', '再补10张', '补到1张']) {
    assert.equal(resolveAppendIntent(work, message), null, message);
    assert.equal(parseChatAction(encode(4), work, message).action, 'reply', message);
  }
  assert.equal(resolveAppendIntent(project(8), '再补3张'), null);
  assert.equal(resolveAppendIntent(project(8), '补到10张').additionalCount, 2);
  assert.equal(resolveAppendIntent(project(10), '再补1张'), null);
});

test('authorized append replies and mistaken edit actions request one executable repair instead of pretending to change the work', () => {
  const work = project(), message = '再给我4张配图';
  for (const output of [
    JSON.stringify({ action: 'reply', reply: '按方案执行，请新建作品。' }),
    JSON.stringify({ action: 'update_post', reply: '已修改', title: '不应覆盖旧标题' }),
    JSON.stringify({ action: 'regenerate', reply: '已重画', pageIds: ['old-1'] }),
    '我会补好图片，请等待。',
  ]) {
    const action = parseChatAction(output, work, message);
    assert.equal(action.action, 'reply'); assert.equal(action.needsAppendPlan, true); assert.equal(action.appendIntent.additionalCount, 4);
    assert.match(action.reply, /尚未追加/); assert.equal(work.title, '真实工具案例');
  }
  const messages = chatActionMessages(work, message, { repairAppend: true });
  assert.match(messages[0].content, /append_pages/); assert.match(messages[0].content, /唯一一次修复/); assert.match(messages[0].content, /严格追加/);
});

test('append payloads cannot replace old identities, change unrelated fields or expand the authorized count', () => {
  const work = project(), message = '再补4张';
  for (const output of [
    encode(5), encode(3), encode(4, { title: '覆盖旧标题' }), encode(4, { imageUrl: 'https://invalid.example/image.png' }),
    encode(4, { pages: additions(4).map(item => ({ ...item, id: 'old-1' })) }),
    encode(4, { pages: [...additions(3), { title: '', content: '正文', prompt: '画面' }] }),
    encode(4, { pages: [...additions(3), { title: '标题', content: '正'.repeat(4001), prompt: '画面' }] }),
    encode(4, { pages: [...additions(3), { title: '标题', content: '正文', prompt: '画'.repeat(16001) }] }),
  ]) assert.throws(() => parseChatAction(output, work, message), error => error.status === 502);
});

test('reply actions cannot claim to have applied edits while normal advice and factual status remain intact', () => {
  const work = project(), before = structuredClone(work), message = '把帖子标题改得简洁一点';
  for (const reply of ['标题已经替你改成简洁版了。', '已为你生成新的图片。', '好的，按修改方案执行。', '正文修改好了。']) {
    const action = parseChatAction(JSON.stringify({ action: 'reply', reply }), work, message);
    assert.equal(action.action, 'reply'); assert.match(action.reply, /还没有应用修改/); assert.ok(!action.reply.includes(reply));
  }
  const advice = '可以缩短标题的前半句。你希望保留哪个关键词？';
  assert.equal(parseChatAction(JSON.stringify({ action: 'reply', reply: advice }), work, message).reply, advice);
  const status = '这组图片已经生成完成，当前有1张。';
  assert.equal(parseChatAction(JSON.stringify({ action: 'reply', reply: status }), work, '这组图片生成了吗').reply, status);
  assert.deepEqual(work, before);
});

test('completed append request records block stale confirmations even if an old assistant message lacks action metadata', () => {
  const work = project(1, pendingMessages());
  work.chatRequests = [{ requestId: 'append-request', action: 'append_pages', status: 'completed' }];
  assert.equal(resolveAppendIntent(work, '确定'), null);
});

test('append suitability questions, literal-copy requests, pending approvals and contradictory totals are not image authorization', () => {
  const work = project();
  for (const message of [
    '再补3张会不会太多？', '增加3张图片是否合适？', '再补3张，这句话写进正文里', '增加3张配图这句话放在正文末尾',
    '追加3张，先出方案等确认', '追加3张，确认后开始', '追加3张，前提是我批准', '再补3张，整组共3张',
    '再补3张图片，总共3张', '增加3张，然后先给方案',
  ]) {
    assert.equal(resolveAppendIntent(work, message), null, message);
    assert.equal(parseChatAction(encode(3), work, message).action, 'reply', message);
  }
  assert.equal(resolveAppendIntent(work, '再补3张，整组共4张').additionalCount, 3);
});

test('choice recovery uses exactly the selected option and requires matching append scope', () => {
  const message = '再补3张', pending = reply => [
    { role: 'user', content: message }, { role: 'assistant', action: 'reply', content: reply },
  ];
  for (const selection of ['A', '选A', '按方案A执行']) {
    const work = project(1, pending('方案A：只改文案，不生成图片。\n方案B：保留原图，追加3张图片，共4张。'));
    assert.equal(resolveAppendIntent(work, selection), null, selection);
    assert.equal(resolveAppendIntent(work, 'B').additionalCount, 3);
  }
  const separate = project(1, pending('A. 保留原封面，追加3张配图，共4张\nB. 只改文案，不生成图片'));
  assert.equal(resolveAppendIntent(separate, 'A').additionalCount, 3, 'A cannot swallow the following B line');
  assert.equal(resolveAppendIntent(separate, 'C'), null, 'An absent choice cannot authorize a remembered count');
  assert.equal(resolveAppendIntent(separate, '确定'), null, 'Unselected alternatives need a choice');
  const legacy = project(1, pending('方案 A：1 张封面（保持现在的暖色画面）+ 3 张内容页，共 4 张。\n方案 B：只做3张，不要封面。'));
  assert.equal(resolveAppendIntent(legacy, 'A').additionalCount, 3, 'Explicit retained-cover arithmetic supports old conversations');
  const noOptions = project(1, pending('可以保留原图，按你刚才的数量补图。请确认。'));
  assert.equal(resolveAppendIntent(noOptions, '确定').additionalCount, 3);
});

test('Chinese update requests can edit their stated post or page scope without authorizing a vague full rewrite', () => {
  const work = project(2);
  const post = parseChatAction(JSON.stringify({ action: 'update_post', reply: '更新正文', caption: '更具体的发布正文', title: '不应改标题' }), work, '更新一下帖子正文，写得具体些');
  assert.equal(post.action, 'update_post'); assert.equal(post.caption, '更具体的发布正文'); assert.equal(post.title, undefined);
  const image = parseChatAction(JSON.stringify({ action: 'revise_pages', reply: '更新第二张', pages: [{ id: 'old-2', content: '第二张的新文字' }] }), work, '更新第2张文案，让它更简洁');
  assert.equal(image.action, 'revise_pages'); assert.deepEqual(image.pages, [{ id: 'old-2', content: '第二张的新文字' }]);
  for (const message of ['更新一下', '请帮我更新一下', '更新这篇作品']) {
    const unscoped = parseChatAction(JSON.stringify({ action: 'update_post', reply: '全改', title: '不应覆盖的标题', caption: '不应覆盖的正文' }), work, message);
    assert.equal(unscoped.action, 'reply'); assert.match(unscoped.reply, /具体改动/);
  }
});
