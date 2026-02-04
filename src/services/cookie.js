/**
 * Cookie 服务
 *
 * 统一管理各平台 cookie 的获取，支持：
 * - CookieCloud 自动获取（启用时优先）
 * - 本地缓存（避免频繁请求）
 * - 静态配置降级
 */

import { CookieCloudClient } from '../utils/cookiecloud.js';
import { CookieCache } from '../utils/cookieCache.js';
import { writeCookieNetscapeFile, removeCookieFile } from '../utils/cookieNetscape.js';
import logger from '../utils/logger.js';

// 平台域名映射（默认值）
const DEFAULT_DOMAINS = {
  bilibili: '.bilibili.com',
};

/**
 * Cookie 服务类
 */
export class CookieService {
  /**
   * @param {object} config - 完整配置对象
   */
  constructor(config) {
    this.config = config;
    this.cache = new CookieCache('./data/cookie_cache.json');
    this.cookieCloudClient = null;

    // 初始化 CookieCloud 客户端
    const ccConfig = config.cookiecloud;
    if (ccConfig?.enabled) {
      this.cookieCloudClient = new CookieCloudClient({
        url: ccConfig.url,
        uuid: ccConfig.uuid,
        password: ccConfig.password,
      });
      logger.info('[CookieService] CookieCloud 已启用');
    } else {
      logger.info('[CookieService] CookieCloud 未启用，将使用静态配置');
    }
  }

  /**
   * 检查 CookieCloud 是否启用
   * @returns {boolean}
   */
  isCookieCloudEnabled() {
    return this.cookieCloudClient !== null;
  }

  /**
   * 获取指定平台的 cookie
   * @param {string} platform - 平台名称，如 "bilibili"
   * @returns {Promise<string>} cookie 字符串
   */
  async getCookie(platform) {
    // CookieCloud 未启用，直接使用静态配置
    if (!this.isCookieCloudEnabled()) {
      return this._getStaticCookie(platform);
    }

    // 1. 检查缓存是否有效
    if (this.cache.isValid(platform)) {
      const cached = this.cache.getPlatformCache(platform);
      if (cached?.cookie) {
        logger.debug(`[CookieService] ${platform} 使用缓存的 cookie`);
        return cached.cookie;
      }
    }

    // 2. 从 CookieCloud 获取
    try {
      const cookie = await this._fetchFromCookieCloud(platform);
      return cookie;
    } catch (err) {
      logger.error(`[CookieService] CookieCloud 获取失败: ${err.message}`);

      // 3. 降级到静态配置
      logger.warn(`[CookieService] ${platform} 降级到静态配置`);
      return this._getStaticCookie(platform);
    }
  }

  /**
   * 刷新指定平台的 cookie
   * @param {string} platform - 平台名称
   * @param {boolean} force - 是否强制刷新（忽略缓存）
   * @returns {Promise<string>} cookie 字符串
   */
  async refreshCookie(platform, force = false) {
    if (force) {
      logger.info(`[CookieService] 强制刷新 ${platform} cookie`);
      this.cache.invalidate(platform);
    }

    return this.getCookie(platform);
  }

  /**
   * 使指定平台的缓存失效
   * @param {string} platform - 平台名称
   */
  invalidateCache(platform) {
    this.cache.invalidate(platform);
  }

  /**
   * 获取静态配置的 cookie
   * @param {string} platform - 平台名称
   * @returns {string} cookie 字符串
   */
  _getStaticCookie(platform) {
    const providerConfig = this.config.providers?.[platform];

    if (!providerConfig?.cookie) {
      throw new Error(`${platform}: 未配置 cookie，请在 config.json 中配置 providers.${platform}.cookie`);
    }

    return providerConfig.cookie;
  }

  /**
   * 从 CookieCloud 获取 cookie
   * @param {string} platform - 平台名称
   * @returns {Promise<string>} cookie 字符串
   */
  async _fetchFromCookieCloud(platform) {
    // 获取目标域名
    const domain = this._getDomain(platform);
    logger.info(`[CookieService] 从 CookieCloud 获取 ${platform} cookie (域名: ${domain})`);

    // 获取 cookie
    const result = await this.cookieCloudClient.getCookiesForDomain(domain);

    // 保存到缓存
    this.cache.setPlatformCache(platform, {
      cookie: result.cookie,
      expires: result.expires,
      source: 'cookiecloud',
    });

    logger.info(`[CookieService] ${platform} cookie 已更新，共 ${result.count} 个`);
    return result.cookie;
  }

  /**
   * 获取平台对应的域名
   * @param {string} platform - 平台名称
   * @returns {string} 域名
   */
  _getDomain(platform) {
    // 优先使用配置中的域名
    const ccPlatformConfig = this.config.cookiecloud?.platforms?.[platform];
    if (ccPlatformConfig?.domain) {
      return ccPlatformConfig.domain;
    }

    // 使用默认域名
    if (DEFAULT_DOMAINS[platform]) {
      return DEFAULT_DOMAINS[platform];
    }

    throw new Error(`${platform}: 未知平台，请在配置中指定域名`);
  }

  /**
   * 获取 Netscape 格式的 cookie 文件路径
   * 用于需要 cookie 文件的工具
   * @param {string} platform - 平台名称
   * @param {string} [filePath] - 可选，指定输出文件路径
   * @returns {Promise<string>} cookie 文件路径
   */
  async getCookieNetscapeFile(platform, filePath = null) {
    const cookie = await this.getCookie(platform);
    const domain = this._getDomain(platform);
    const outputPath = filePath || `./data/tmp_${platform}_cookie.txt`;

    return writeCookieNetscapeFile(cookie, outputPath, domain);
  }

  /**
   * 删除临时 cookie 文件
   * @param {string} filePath - 文件路径
   */
  removeCookieFile(filePath) {
    removeCookieFile(filePath);
  }
}

// 单例实例
let instance = null;

/**
 * 初始化 Cookie 服务（单例）
 * @param {object} config - 配置对象
 * @returns {CookieService}
 */
export function initCookieService(config) {
  instance = new CookieService(config);
  return instance;
}

/**
 * 获取 Cookie 服务实例
 * @returns {CookieService}
 */
export function getCookieService() {
  if (!instance) {
    throw new Error('CookieService 未初始化，请先调用 initCookieService');
  }
  return instance;
}

export default CookieService;
