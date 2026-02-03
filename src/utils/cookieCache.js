/**
 * Cookie 缓存管理
 *
 * 负责将 cookie 缓存到本地 JSON 文件，支持过期检测
 */

import fs from 'fs';
import path from 'path';
import logger from './logger.js';

// 缓存格式版本
const CACHE_VERSION = 1;

// 提前 5 分钟刷新，避免临界过期
const REFRESH_BUFFER_SECONDS = 300;

// 默认缓存有效期：24 小时（秒）
const DEFAULT_CACHE_TTL = 24 * 60 * 60;

/**
 * Cookie 缓存管理类
 */
export class CookieCache {
  /**
   * @param {string} cachePath - 缓存文件路径
   */
  constructor(cachePath = './data/cookie_cache.json') {
    this.cachePath = cachePath;
  }

  /**
   * 加载缓存
   * @returns {object|null} 缓存数据，不存在或格式错误返回 null
   */
  load() {
    try {
      if (!fs.existsSync(this.cachePath)) {
        logger.debug('[CookieCache] 缓存文件不存在');
        return null;
      }

      const content = fs.readFileSync(this.cachePath, 'utf8');
      const data = JSON.parse(content);

      // 检查版本兼容性
      if (data.version !== CACHE_VERSION) {
        logger.warn(`[CookieCache] 缓存版本不匹配: ${data.version} !== ${CACHE_VERSION}`);
        return null;
      }

      return data;
    } catch (err) {
      logger.error(`[CookieCache] 加载缓存失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 保存缓存
   * @param {object} data - 缓存数据
   * @returns {boolean} 是否保存成功
   */
  save(data) {
    try {
      // 确保目录存在
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 添加版本号
      const cacheData = {
        version: CACHE_VERSION,
        ...data,
      };

      fs.writeFileSync(this.cachePath, JSON.stringify(cacheData, null, 2), 'utf8');
      logger.debug(`[CookieCache] 缓存已保存: ${this.cachePath}`);
      return true;
    } catch (err) {
      logger.error(`[CookieCache] 保存缓存失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 获取指定平台的缓存
   * @param {string} platform - 平台名称
   * @returns {object|null} 平台缓存数据
   */
  getPlatformCache(platform) {
    const cache = this.load();
    if (!cache || !cache.platforms) {
      return null;
    }
    return cache.platforms[platform] || null;
  }

  /**
   * 设置指定平台的缓存
   * @param {string} platform - 平台名称
   * @param {object} data - 缓存数据
   * @returns {boolean} 是否保存成功
   */
  setPlatformCache(platform, data) {
    const cache = this.load() || { platforms: {} };

    if (!cache.platforms) {
      cache.platforms = {};
    }

    cache.platforms[platform] = {
      ...data,
      cachedAt: Math.floor(Date.now() / 1000),
    };

    return this.save(cache);
  }

  /**
   * 检查平台缓存是否有效
   * @param {string} platform - 平台名称
   * @returns {boolean} 是否有效
   */
  isValid(platform) {
    const platformCache = this.getPlatformCache(platform);

    if (!platformCache) {
      logger.debug(`[CookieCache] ${platform} 无缓存`);
      return false;
    }

    const currentTime = Math.floor(Date.now() / 1000);
    let expireTime;

    if (platformCache.expires) {
      // 使用 cookie 的过期时间
      expireTime = platformCache.expires - REFRESH_BUFFER_SECONDS;
    } else if (platformCache.cachedAt) {
      // 使用默认 TTL
      expireTime = platformCache.cachedAt + DEFAULT_CACHE_TTL - REFRESH_BUFFER_SECONDS;
    } else {
      logger.warn(`[CookieCache] ${platform} 缓存缺少时间信息`);
      return false;
    }

    if (currentTime > expireTime) {
      const remaining = platformCache.expires
        ? platformCache.expires - currentTime
        : platformCache.cachedAt + DEFAULT_CACHE_TTL - currentTime;
      logger.debug(`[CookieCache] ${platform} 缓存已过期或即将过期，剩余 ${remaining} 秒`);
      return false;
    }

    const remaining = expireTime - currentTime;
    logger.debug(`[CookieCache] ${platform} 缓存有效，距离刷新还有 ${remaining} 秒`);
    return true;
  }

  /**
   * 使指定平台的缓存失效
   * @param {string} platform - 平台名称
   * @returns {boolean} 是否成功
   */
  invalidate(platform) {
    const cache = this.load();

    if (!cache || !cache.platforms || !cache.platforms[platform]) {
      return true;
    }

    delete cache.platforms[platform];
    logger.info(`[CookieCache] ${platform} 缓存已清除`);
    return this.save(cache);
  }

  /**
   * 清除所有缓存
   * @returns {boolean} 是否成功
   */
  clear() {
    try {
      if (fs.existsSync(this.cachePath)) {
        fs.unlinkSync(this.cachePath);
        logger.info(`[CookieCache] 所有缓存已清除`);
      }
      return true;
    } catch (err) {
      logger.error(`[CookieCache] 清除缓存失败: ${err.message}`);
      return false;
    }
  }
}

export default CookieCache;
