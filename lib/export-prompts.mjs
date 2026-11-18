import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderingPrompt } from './prompts.mjs';

async function readSavedPrompt(directory, name) {
  try {
    return await readFile(path.join(directory, name), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function promptForExport(projectDir, project, page) {
  const directory = path.join(projectDir, 'prompts');
  if (page.imageUrl) {
    const image = path.parse(page.imageUrl);
    const exact = await readSavedPrompt(directory, image.name + '.md');
    if (exact !== null) return { text: exact };

    // Older releases saved the last request for each page, including failed retries.
    if (/^[0-9a-f-]{36}$/i.test(page.id)) {
      const legacy = await readSavedPrompt(directory, page.id + '.md');
      if (legacy !== null) return { text: legacy, note: '来自旧版页面生成记录，未按图片版本归档。' };
    }
  }
  return {
    text: await renderingPrompt(project, page),
    note: page.imageUrl ? '实际生成记录缺失，此文件根据当前作品和规则重建。' : '本页尚无成图，此文件是按当前规则预览的提示词。',
  };
}
