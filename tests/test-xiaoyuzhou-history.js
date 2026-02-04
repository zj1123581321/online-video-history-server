/**
 * 小宇宙历史记录 API 测试脚本
 *
 * 用法: node tests/test-xiaoyuzhou-history.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取配置
const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const xiaoyuzhouConfig = config.providers.xiaoyuzhou;

if (!xiaoyuzhouConfig || (!xiaoyuzhouConfig.accessToken && !xiaoyuzhouConfig.refreshToken)) {
  console.error('错误: 未找到小宇宙配置，需要至少配置 accessToken 或 refreshToken');
  process.exit(1);
}

console.log('=== 小宇宙历史记录 API 测试 ===\n');

// 测试模式：只使用 refreshToken
const REFRESH_ONLY_MODE = process.argv.includes('--refresh-only');

if (REFRESH_ONLY_MODE) {
  console.log('【测试模式】只使用 refreshToken，不使用 accessToken\n');
  xiaoyuzhouConfig.accessToken = null;
}

console.log('配置信息:');
console.log(`  - accessToken: ${xiaoyuzhouConfig.accessToken ? xiaoyuzhouConfig.accessToken.slice(0, 50) + '...' : '(未配置)'}`);
console.log(`  - refreshToken: ${xiaoyuzhouConfig.refreshToken ? xiaoyuzhouConfig.refreshToken.slice(0, 50) + '...' : '(未配置)'}`);
console.log(`  - deviceId: ${xiaoyuzhouConfig.deviceId || '(自动生成)'}`);
console.log(`  - pageSize: ${xiaoyuzhouConfig.pageSize || 25}`);
console.log('');

/**
 * 生成随机设备 ID
 */
function generateDeviceId() {
  const segments = [8, 4, 4, 4, 12];
  const chars = '0123456789abcdef';
  return segments.map(len => {
    let str = '';
    for (let i = 0; i < len; i++) {
      str += chars[Math.floor(Math.random() * chars.length)];
    }
    return str;
  }).join('-');
}

/**
 * 构建请求头
 */
function buildHeaders() {
  const deviceId = xiaoyuzhouConfig.deviceId || generateDeviceId();

  // 使用 iOS 设备模拟 (与 xyz 项目一致)
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': 'okhttp/4.7.2',
    'Host': 'api.xiaoyuzhoufm.com',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
    'x-jike-device-id': deviceId,
    'x-jike-access-token': xiaoyuzhouConfig.accessToken,
    'Local-Time': new Date().toISOString(),
    'Timezone': 'Asia/Shanghai',
    'App-BuildNo': '611',
    'App-Version': '2.67.1',
    'OS-Version': '17.4.1',
    'BundleID': 'app.podcast.cosmos',
    'Manufacturer': 'Apple',
    'Model': 'iPhone14,2',
  };

  console.log('请求头:');
  Object.entries(headers).forEach(([k, v]) => {
    if (k === 'x-jike-access-token') {
      console.log(`  ${k}: ${v.slice(0, 30)}...`);
    } else {
      console.log(`  ${k}: ${v}`);
    }
  });
  console.log('');

  return headers;
}

/**
 * 获取历史记录
 */
async function fetchHistory(loadMoreKey = null) {
  const url = 'https://api.xiaoyuzhoufm.com/v1/episode-played/list-history';
  const body = {
    limit: xiaoyuzhouConfig.pageSize || 25,
  };

  if (loadMoreKey) {
    body.loadMoreKey = loadMoreKey;
  }

  console.log(`请求 URL: ${url}`);
  console.log(`请求体: ${JSON.stringify(body)}`);
  console.log('');

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });

  console.log(`响应状态: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const text = await response.text();
    console.error(`错误响应: ${text}`);
    throw new Error(`API 请求失败 (${response.status})`);
  }

  return response.json();
}

/**
 * 格式化单集信息
 */
function formatEpisode(item, index) {
  const episode = item.episode || item;
  const podcast = episode.podcast || {};

  return `${index + 1}. [${podcast.title || '未知播客'}] ${episode.title || '未知标题'}
     EID: ${episode.eid}
     时长: ${Math.floor((episode.duration || 0) / 60)} 分钟
     链接: https://www.xiaoyuzhoufm.com/episode/${episode.eid}`;
}

/**
 * 尝试刷新 token
 */
async function refreshToken() {
  if (!xiaoyuzhouConfig.refreshToken) {
    console.log('没有配置 refreshToken，无法刷新');
    return null;
  }

  console.log('--- 尝试刷新 Token ---\n');

  const url = 'https://api.xiaoyuzhoufm.com/app_auth_tokens.refresh';
  const deviceId = xiaoyuzhouConfig.deviceId || generateDeviceId();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'User-Agent': 'Xiaoyuzhou/2.102.2(android 36)',
      'x-jike-device-id': deviceId,
      'x-jike-refresh-token': xiaoyuzhouConfig.refreshToken,
    },
    body: JSON.stringify({}),
  });

  console.log(`刷新响应状态: ${response.status} ${response.statusText}`);

  if (response.ok) {
    const data = await response.json();
    console.log('刷新成功！');
    console.log(`新 accessToken: ${data['x-jike-access-token']?.slice(0, 50)}...`);
    return data;
  } else {
    const text = await response.text();
    console.log(`刷新失败: ${text}`);
    return null;
  }
}

// 执行测试
async function main() {
  try {
    // 如果没有 accessToken，先刷新获取
    if (!xiaoyuzhouConfig.accessToken) {
      console.log('--- 无 accessToken，先刷新获取 ---\n');
      const tokens = await refreshToken();
      if (tokens && tokens['x-jike-access-token']) {
        xiaoyuzhouConfig.accessToken = tokens['x-jike-access-token'];
        console.log('获取 accessToken 成功！\n');
      } else {
        throw new Error('无法获取 accessToken');
      }
    }

    console.log('--- 发起 API 请求 ---\n');

    const result = await fetchHistory();

    console.log('\n--- 响应结果 ---\n');
    console.log(`返回记录数: ${result.data?.length || 0}`);
    console.log(`loadMoreKey: ${result.loadMoreKey || '(无)'}`);
    console.log('');

    if (result.data && result.data.length > 0) {
      console.log('--- 历史记录列表 (前5条) ---\n');
      result.data.slice(0, 5).forEach((item, index) => {
        console.log(formatEpisode(item, index));
        console.log('');
      });
    } else {
      console.log('没有获取到历史记录');
    }

    console.log('=== 测试完成 ===');

  } catch (error) {
    console.error(`\n获取历史失败: ${error.message}`);

    // 尝试刷新 token
    console.log('\n');
    const newTokens = await refreshToken();

    if (newTokens && newTokens['x-jike-access-token']) {
      console.log('\n请更新 config.json 中的 accessToken:');
      console.log(`"accessToken": "${newTokens['x-jike-access-token']}"`);
      if (newTokens['x-jike-refresh-token']) {
        console.log(`"refreshToken": "${newTokens['x-jike-refresh-token']}"`);
      }
    } else {
      console.log('\nToken 刷新失败，需要重新获取 accessToken');
      console.log('可以通过抓包小宇宙 APP 的请求来获取新的 token');
    }

    process.exit(1);
  }
}

main();
