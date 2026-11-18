export function projectPlatform(project) {
  if (project.targetPlatform === 'xhs' || project.targetPlatform === 'generic') return project.targetPlatform;
  return (project.xhsAutoDelivery ?? project.xhsDelivery?.enabled) ? 'xhs' : 'generic';
}

export const XHS_COPY_LIMITS = { title: 20, caption: 1000 };

export function xhsCopyProblem(title, caption) {
  const titleLength = Array.from(title ?? '').length, captionLength = Array.from(caption ?? '').length;
  const problems = [];
  if (titleLength > XHS_COPY_LIMITS.title) problems.push(`标题超过20个字符（${titleLength}/20）`);
  if (captionLength > XHS_COPY_LIMITS.caption) problems.push(`正文超过1000个字符（${captionLength}/1000）`);
  return problems.length ? `小红书${problems.join('，')}，请编辑送稿文案后再保存` : '';
}
