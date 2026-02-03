import { BilibiliProvider } from '../providers/bilibili.js';
import { YouTubeProvider } from '../providers/youtube.js';
import { YouTubeCDPProvider } from '../providers/youtube-cdp.js';
import logger from '../utils/logger.js';

// Provider 注册表
const providerRegistry = {
  bilibili: BilibiliProvider,
  youtube: YouTubeProvider,
  'youtube-cdp': YouTubeCDPProvider,
};

// 已初始化的 Provider 实例
let providers = {};

/**
 * 初始化所有 Provider
 * @param {object} config - 配置对象
 */
export function initProviders(config) {
  providers = {};

  // 兼容旧配置格式
  const providersConfig = config.providers || {
    bilibili: {
      enabled: true,
      cookie: config.bilibili?.cookie
    }
  };

  for (const [name, ProviderClass] of Object.entries(providerRegistry)) {
    const providerConfig = providersConfig[name];
    if (providerConfig) {
      const provider = new ProviderClass(providerConfig);
      if (provider.isEnabled() && provider.validateConfig()) {
        providers[name] = provider;
        logger.info(`[Provider] ${name} 已启用`);
      } else {
        logger.info(`[Provider] ${name} 未启用或配置无效`);
      }
    }
  }

  return providers;
}

/**
 * 获取指定平台的 Provider
 * @param {string} platform - 平台名称
 * @returns {BaseProvider|null}
 */
export function getProvider(platform) {
  return providers[platform] || null;
}

/**
 * 获取所有已启用的 Provider
 * @returns {object}
 */
export function getEnabledProviders() {
  return providers;
}

/**
 * 根据 platform 属性值查找对应的 Provider
 * 因为配置 key（如 'youtube-cdp'）可能与 Provider 的 platform 属性值（如 'youtube'）不同
 * @param {string} platformValue - platform 属性值（数据库中存储的值）
 * @returns {object} 匹配的 providers，key 为配置名
 */
function getProvidersByPlatformValue(platformValue) {
  const matched = {};
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.platform === platformValue) {
      matched[name] = provider;
    }
  }
  return matched;
}

/**
 * 同步历史记录
 * @param {string} [platform] - 可选，指定平台（platform 属性值）；不传则同步所有已启用平台
 * @returns {Promise<{results: object, totalNew: number, totalUpdate: number}>}
 */
export async function syncHistory(platform = null) {
  const results = {};
  let totalNew = 0;
  let totalUpdate = 0;

  // 根据 platform 值查找对应的 providers
  const targetProviders = platform
    ? getProvidersByPlatformValue(platform)
    : providers;

  for (const [name, provider] of Object.entries(targetProviders)) {
    if (!provider) {
      results[name] = { error: '平台未启用' };
      continue;
    }

    try {
      logger.info(`[Sync] 开始同步 ${name}...`);
      const result = await provider.sync();
      results[name] = result;
      totalNew += result.newCount;
      totalUpdate += result.updateCount;
      logger.info(`[Sync] ${name} 同步完成: 新增 ${result.newCount}, 更新 ${result.updateCount}`);
    } catch (error) {
      logger.error(`[Sync] ${name} 同步失败: ${error.message}`, error);
      results[name] = { error: error.message };
    }
  }

  return { results, totalNew, totalUpdate };
}

/**
 * 删除远程历史记录
 * @param {object} item - 历史记录项（需包含 platform 字段）
 * @returns {Promise<boolean>}
 */
export async function deleteRemoteHistory(item) {
  // 根据 platform 值查找对应的 Provider
  const matchedProviders = getProvidersByPlatformValue(item.platform);
  const providerEntries = Object.entries(matchedProviders);

  if (providerEntries.length === 0) {
    throw new Error(`平台 ${item.platform} 未启用`);
  }

  // 使用第一个匹配的 Provider 删除
  const [, provider] = providerEntries[0];
  return provider.deleteRemote(item);
}
