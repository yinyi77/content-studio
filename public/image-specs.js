const aspectSizes = {
  auto: { '3:4': '1024x1536', '1:1': '1024x1024', '16:9': '1536x1024' },
  exact: { '3:4': '1152x1536', '1:1': '1024x1024', '16:9': '1536x864' },
};

export const imageSizeOptions = {
  auto: '自动（兼容尺寸）',
  exact: '按目标比例请求（需模型支持）',
  '1024x1024': '1024 × 1024',
  '1024x1536': '1024 × 1536',
  '1536x1024': '1536 × 1024',
  '1024x1792': '1024 × 1792',
  '1792x1024': '1792 × 1024',
};

export function requestedImageSize(config, aspect) {
  if (!config || config.mode === 'chat') return null;
  const size = config.size || 'auto';
  return Object.hasOwn(aspectSizes, size) ? aspectSizes[size][aspect] : size;
}

export function formatImageDimensions(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return '';
  let a = width, b = height;
  while (b) [a, b] = [b, a % b];
  return `${width} × ${height} px（${width / a}:${height / a}）`;
}
