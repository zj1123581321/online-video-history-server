import { BilibiliProvider } from '../providers/bilibili.js';

// Provider 注册表
const providerRegistry = {
  bilibili: BilibiliProvider,
  // youtube: YouTubeProvider,  // 未来扩展
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
        console.log(`[Provider] ${name} 已启用`);
      } else {
        console.log(`[Provider] ${name} 未启用或配置无效`);
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
 * 同步历史记录
 * @param {string} [platform] - 可选，指定平台；不传则同步所有已启用平台
 * @returns {Promise<{results: object, totalNew: number, totalUpdate: number}>}
 */
export async function syncHistory(platform = null) {
  const results = {};
  let totalNew = 0;
  let totalUpdate = 0;

  const targetProviders = platform
    ? { [platform]: providers[platform] }
    : providers;

  for (const [name, provider] of Object.entries(targetProviders)) {
    if (!provider) {
      results[name] = { error: '平台未启用' };
      continue;
    }

    try {
      console.log(`[Sync] 开始同步 ${name}...`);
      const result = await provider.sync();
      results[name] = result;
      totalNew += result.newCount;
      totalUpdate += result.updateCount;
      console.log(`[Sync] ${name} 同步完成: 新增 ${result.newCount}, 更新 ${result.updateCount}`);
    } catch (error) {
      console.error(`[Sync] ${name} 同步失败:`, error.message);
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
  const provider = providers[item.platform];
  if (!provider) {
    throw new Error(`平台 ${item.platform} 未启用`);
  }
  return provider.deleteRemote(item);
}
