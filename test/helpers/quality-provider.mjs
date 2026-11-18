// Most HTTP suites exercise another feature. Their mock provider supplies a
// passing review; editorial-review.mjs exercises real grading and repair paths.
export function replyToQualityReview(request, response) {
  const system = request.messages?.[0]?.content;
  if (typeof system !== 'string' || !system.startsWith('CONTENT_QUALITY_')) return false;
  let result;
  if (system.startsWith('CONTENT_QUALITY_REVIEW_V1')) {
    result = { scores: { grounding: 27, information: 22, naturalness: 22, audience: 9, purpose: 9 }, issues: [], summary: '测试编辑已核对素材和本次文案。' };
  } else if (system.startsWith('CONTENT_QUALITY_REWRITE_V1')) {
    const parts = request.messages.at(-1).content;
    const raw = typeof parts === 'string' ? parts : parts.find(part => part.type === 'text').text;
    const { context } = JSON.parse(raw);
    const field = context.editableFields[0];
    result = { edits: [{ field, text: context.draft[field] }] };
  } else return false;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  return true;
}
