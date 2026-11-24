import path from 'node:path';
import { readFile } from 'node:fs/promises';
import * as util from 'node:util';
import { XhsLanMedia } from './xhs-lan-media.mjs';
import { XhsPublisherService } from './xhs-publisher.mjs';

function endpoint(value, field) {
  let url;
  try { url = new URL(value); } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || ['0.0.0.0', '[::]'].includes(url.hostname)) {
    throw new Error(`${field} 需要可访问的 HTTP(S) 地址，可含路径前缀；请移除凭证、查询参数和片段。`);
  }
  return url;
}

function loopback(url) {
  const host = url.hostname.replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]'
    || /^127\.\d+\.\d+\.\d+$/.test(host) || /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(host);
}

function deliverySettings(base, config, dir, port) {
  try {
    const mediaUrl = config.XHS_PUBLISHER_MEDIA_BASE_URL?.trim();
    const origin = config.XHS_PUBLISHER_LAN_MEDIA_ORIGIN?.trim();
    if (origin) {
      if (mediaUrl) throw new Error('请在内网临时链接和已有图片站点中选择一种图源，并重启工作台。');
      const media = endpoint(origin, 'XHS_PUBLISHER_LAN_MEDIA_ORIGIN');
      if (!loopback(base) && loopback(media)) throw new Error('异机取图请将 XHS_PUBLISHER_LAN_MEDIA_ORIGIN 设为工作台电脑的内网 IPv4 地址。');
      const workerIp = config.XHS_PUBLISHER_WORKER_IP?.trim() || base.hostname;
      return { lanMedia: new XhsLanMedia({ dir, origin, workerIp }), mediaBaseUrl: media.origin };
    }
    const media = endpoint(mediaUrl || `http://127.0.0.1:${port}`, 'XHS_PUBLISHER_MEDIA_BASE_URL');
    if (!loopback(base) && loopback(media)) {
      throw new Error('当前仅支持查询。送稿前请设置内网临时图源 XHS_PUBLISHER_LAN_MEDIA_ORIGIN，或已有图片站点 XHS_PUBLISHER_MEDIA_BASE_URL，并重启工作台。');
    }
    return { mediaBaseUrl: media.href };
  } catch (error) {
    return { deliveryConfigurationError: error.message };
  }
}

export async function createXhsConnector({ root, dir, port, env = process.env }) {
  let file;
  try { file = await readFile(path.join(root, '.env.xhs-publisher'), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') return new XhsPublisherService({ dir, configurationError: '无法读取 .env.xhs-publisher，请检查文件权限。' });
  }
  try {
    if (file !== undefined && !util.parseEnv) throw new Error('读取 .env.xhs-publisher 需要 Node.js 20.12 或更新版本。');
    const config = { ...(file === undefined ? {} : util.parseEnv(file)), ...env };
    if (config.XHS_PROVIDER && config.XHS_PROVIDER !== 'publisher') throw new Error('请移除旧的 XHS_PROVIDER 配置，并填写小红书微服务的连接信息。');
    const token = (config.XHS_PUBLISHER_TOKEN || config.XHS_API_TOKEN || '').trim();
    if (/\s/.test(token)) throw new Error('XHS_PUBLISHER_TOKEN 只需填写服务令牌原值。');
    const base = endpoint(config.XHS_PUBLISHER_BASE_URL || 'http://127.0.0.1:8000', 'XHS_PUBLISHER_BASE_URL');
    const accountId = config.XHS_PUBLISHER_ACCOUNT_ID ?? 'xhs_account_001';
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(accountId)) throw new Error('请检查 XHS_PUBLISHER_ACCOUNT_ID。');
    return new XhsPublisherService({ dir, baseUrl: base.href, token, accountId,
      ...deliverySettings(base, config, dir, port) });
  } catch (error) {
    return new XhsPublisherService({ dir, configurationError: error.message });
  }
}
