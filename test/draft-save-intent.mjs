import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSaveIntent } from '../lib/chat-creation.mjs';

test('explicit draft commands distinguish delivery from editing, questions and quoted copy', () => {
  for (const message of ['把修改后的版本存到草稿箱', '把修改版存到草稿箱', '把这一版存到草稿箱', '把改好的版本存到草稿箱', '请帮我将当前版本另存草稿', '直接存入小红书电脑草稿吧', '把这篇帖子放到小红书草稿箱里', '再存一份草稿', '帮我存到草稿箱，可以吗？']) {
    assert.deepEqual(draftSaveIntent(message), { only: true }, message);
  }
  for (const message of ['帖子标题改成“开发工具新体验”，然后存到草稿箱', '只修改帖子正文，图片不动，并且把当前版本另存草稿', '不要改标题，正文缩短一点，存到草稿箱']) {
    assert.deepEqual(draftSaveIntent(message), { only: false }, message);
  }
  for (const message of ['怎么存到小红书草稿箱？', '现在已经存到草稿箱了吗？', '文案里加上“存入草稿箱”', '标题改成「存到草稿箱」', '不要存入草稿箱', '存入草稿箱，然后先别存到小红书', '重画第1张图片', '自动保存是什么意思？']) {
    assert.equal(draftSaveIntent(message), null, message);
  }
  for (const message of ['把正文改成下面这段文字：\n存到草稿箱', '标题改成“新标题”，正文改成以下内容：\n```\n存到草稿箱\n```', '正文加上这段：\n> 存到草稿箱', '标题先改短，如果我同意，存到草稿箱', '标题改短，等我确认后，存到草稿箱', '标题先改短，暂时不要保存，存到草稿箱', '标题改短，先别上传，然后存到草稿箱', '文案改成“新正文\n存到草稿箱', '```\n存到草稿箱']) {
    assert.equal(draftSaveIntent(message), null, message);
  }
});
