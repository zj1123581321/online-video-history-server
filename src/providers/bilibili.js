import fetch from 'node-fetch';
import { BaseProvider } from './base.js';
import db from '../db/index.js';
import { getCookieService } from '../services/cookie.js';

// Bilibili API 认证相关的错误码
const AUTH_ERROR_CODES = [
  -101,  // 账号未登录
  -6,    // 请先登录
];

// 认证相关的错误消息关键词
const AUTH_ERROR_KEYWORDS = ['未登录', '请先登录', '登录'];

// 网络请求配置
const REQUEST_CONFIG = {
  maxRetries: 3,           // 最大重试次数
  retryDelay: 2000,        // 重试间隔（毫秒）
  requestInterval: 1500,   // 请求间隔（毫秒），避免过于频繁
};

/**
 * 延时函数
 * @param {number} ms - 毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的 fetch 请求
 * @param {string} url - 请求 URL
 * @param {object} options - fetch 选项
 * @param {number} retries - 剩余重试次数
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, retries = REQUEST_CONFIG.maxRetries) {
  try {
    const response = await fetch(url, options);
    return response;
  } catch (error) {
    if (retries > 0) {
      console.log(`[Bilibili] 网络请求失败 (${error.message})，${REQUEST_CONFIG.retryDelay / 1000}秒后重试，剩余 ${retries} 次...`);
      await sleep(REQUEST_CONFIG.retryDelay);
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
}

// 预编译 SQL 语句
const stmts = {
  getById: db.prepare('SELECT id, view_time FROM history WHERE id = ? AND platform = ?'),
  insert: db.prepare(`
    INSERT INTO history
    (id, platform, business, bvid, cid, title, tag_name, cover, view_time, uri, author_name, author_mid, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateViewTime: db.prepare('UPDATE history SET view_time = ?, timestamp = ? WHERE id = ? AND platform = ?'),
};

/**
 * Bilibili 历史记录提供者
 */
export class BilibiliProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.platform = 'bilibili';
    // 缓存当前 cookie，避免每次请求都获取
    this._cachedCookie = null;
  }

  /**
   * 验证配置
   * @returns {boolean}
   */
  validateConfig() {
    if (!this.enabled) return false;
    // CookieCloud 模式下不需要检查静态 cookie 配置
    try {
      const cookieService = getCookieService();
      if (cookieService.isCookieCloudEnabled()) {
        return true;
      }
    } catch {
      // CookieService 未初始化，检查静态配置
    }
    if (!this.config.cookie) {
      console.warn('Bilibili: cookie 未配置');
      return false;
    }
    return true;
  }

  /**
   * 获取当前 cookie（优先从 CookieService 获取）
   * @param {boolean} forceRefresh - 是否强制从云端刷新
   * @returns {Promise<string>}
   */
  async getCookie(forceRefresh = false) {
    try {
      const cookieService = getCookieService();
      if (forceRefresh) {
        console.log('[Bilibili] 强制刷新 cookie...');
        return await cookieService.refreshCookie(this.platform, true);
      }
      return await cookieService.getCookie(this.platform);
    } catch {
      // CookieService 未初始化，使用静态配置
      if (!this.config.cookie) {
        throw new Error('Bilibili: cookie 未配置');
      }
      return this.config.cookie;
    }
  }

  /**
   * 检查是否是认证失败的错误
   * @param {object} data - API 响应数据
   * @returns {boolean}
   */
  isAuthError(data) {
    // 检查错误码
    if (AUTH_ERROR_CODES.includes(data.code)) {
      return true;
    }
    // 检查错误消息关键词
    if (data.message) {
      return AUTH_ERROR_KEYWORDS.some(keyword => data.message.includes(keyword));
    }
    return false;
  }

  /**
   * 检查 CookieCloud 是否可用于刷新
   * @returns {boolean}
   */
  canRefreshFromCloud() {
    try {
      const cookieService = getCookieService();
      return cookieService.isCookieCloudEnabled();
    } catch {
      return false;
    }
  }

  /**
   * 从 cookie 中提取 bili_jct
   * @param {string} cookie - cookie 字符串
   * @returns {string|null}
   */
  getBiliJct(cookie) {
    const cookieStr = cookie || this.config.cookie;
    const match = cookieStr?.match(/bili_jct=([^;]+)/);
    return match ? match[1] : null;
  }

  /**
   * 标准化数据格式
   * @param {object} rawItem - B站 API 返回的原始数据
   * @returns {object}
   */
  normalizeItem(rawItem) {
    return {
      id: rawItem.history.oid,
      platform: this.platform,
      business: rawItem.history.business,
      bvid: rawItem.history.bvid,
      cid: rawItem.history.cid,
      title: rawItem.title,
      tag_name: rawItem.tag_name,
      cover: rawItem.cover || (rawItem.covers && rawItem.covers[0]) || '',
      viewTime: rawItem.view_at,
      uri: rawItem.uri || '',
      author_name: rawItem.author_name || '',
      author_mid: rawItem.author_mid || 0,
      timestamp: Date.now(),
    };
  }

  /**
   * 同步历史记录
   * @param {boolean} isRetry - 是否是重试请求（内部使用）
   * @returns {Promise<{newCount: number, updateCount: number}>}
   */
  async sync(isRetry = false) {
    if (!this.validateConfig()) {
      throw new Error('Bilibili: 配置无效');
    }

    // 获取 cookie（优先从 CookieCloud 获取）
    const cookie = await this.getCookie();
    console.log('[Bilibili] 已获取 cookie');

    let hasMore = true;
    let max = 0;
    let view_at = 0;
    const type = 'all';
    const ps = 30;
    let newCount = 0;
    let updateCount = 0;
    let processedIds = new Set();
    let noUpdateCount = 0;  // 连续无新增的记录数

    // 使用事务批量处理
    const batchInsert = db.transaction((items) => {
      for (const item of items) {
        const existing = stmts.getById.get(item.id, this.platform);

        if (!existing) {
          stmts.insert.run(
            item.id,
            item.platform,
            item.business,
            item.bvid,
            item.cid,
            item.title,
            item.tag_name,
            item.cover,
            item.viewTime,
            item.uri,
            item.author_name,
            item.author_mid,
            item.timestamp
          );
          newCount++;
        } else if (existing.view_time !== item.viewTime) {
          stmts.updateViewTime.run(item.viewTime, item.timestamp, item.id, this.platform);
          updateCount++;
        }
      }
    });

    while (hasMore) {
      const response = await fetchWithRetry(
        `https://api.bilibili.com/x/web-interface/history/cursor?max=${max}&view_at=${view_at}&type=${type}&ps=${ps}`,
        {
          headers: {
            Cookie: cookie,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Bilibili: 获取历史记录失败');
      }

      const data = await response.json();

      if (data.code !== 0) {
        // 检查是否是认证失败
        if (this.isAuthError(data)) {
          // 如果已经是重试请求，或者无法从云端刷新，则直接抛出错误
          if (isRetry || !this.canRefreshFromCloud()) {
            throw new Error(data.message || 'Bilibili: 获取历史记录失败');
          }

          // 首次请求遇到认证失败，尝试刷新 cookie 并重试
          console.log(`[Bilibili] 检测到认证失败 (${data.message})，尝试从云端刷新 cookie...`);

          // 强制刷新 cookie
          await this.getCookie(true);

          // 重试同步（标记为重试，避免无限循环）
          console.log('[Bilibili] 使用新 cookie 重试同步...');
          return this.sync(true);
        }

        throw new Error(data.message || 'Bilibili: 获取历史记录失败');
      }

      hasMore = data.data.list.length > 0;
      max = data.data.cursor.max;
      view_at = data.data.cursor.view_at;

      if (data.data.list.length > 0) {
        const prevNewCount = newCount;
        const prevUpdateCount = updateCount;

        // 转换数据格式
        const items = [];
        for (const rawItem of data.data.list) {
          if (processedIds.has(rawItem.history.oid)) {
            continue;
          }
          processedIds.add(rawItem.history.oid);
          items.push(this.normalizeItem(rawItem));
        }

        batchInsert(items);

        console.log(`[Bilibili] 同步了 ${data.data.list.length} 条历史记录`);

        const hasNewOrUpdated = newCount > prevNewCount || updateCount > prevUpdateCount;
        if (hasNewOrUpdated) {
          noUpdateCount = 0;  // 有新增/更新，重置计数
        } else {
          noUpdateCount += items.length;  // 累加无新增的记录数
          if (noUpdateCount >= 30) {
            console.log(`[Bilibili] 连续 ${noUpdateCount} 条无新增，同步结束`);
            break;
          }
        }

        // 延时避免请求过于频繁
        await sleep(REQUEST_CONFIG.requestInterval);
      }
    }

    return { newCount, updateCount };
  }

  /**
   * 删除远程历史记录
   * @param {object} item - 历史记录项
   * @param {boolean} isRetry - 是否是重试请求（内部使用）
   * @returns {Promise<boolean>}
   */
  async deleteRemote(item, isRetry = false) {
    // 获取 cookie
    const cookie = await this.getCookie();
    const biliJct = this.getBiliJct(cookie);

    if (!biliJct) {
      throw new Error('Bilibili: 未找到 bili_jct，请检查 cookie 配置');
    }

    const kid = `${item.business}_${item.id}`;
    const response = await fetchWithRetry('https://api.bilibili.com/x/v2/history/delete', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': cookie
      },
      body: new URLSearchParams({
        'kid': kid,
        'csrf': biliJct
      })
    });

    const data = await response.json();
    if (data.code !== 0) {
      // 检查是否是认证失败
      if (this.isAuthError(data)) {
        // 如果已经是重试请求，或者无法从云端刷新，则直接抛出错误
        if (isRetry || !this.canRefreshFromCloud()) {
          throw new Error(data.message || 'Bilibili: 删除远程记录失败');
        }

        // 首次请求遇到认证失败，尝试刷新 cookie 并重试
        console.log(`[Bilibili] 删除操作检测到认证失败 (${data.message})，尝试从云端刷新 cookie...`);

        // 强制刷新 cookie
        await this.getCookie(true);

        // 重试删除（标记为重试，避免无限循环）
        console.log('[Bilibili] 使用新 cookie 重试删除...');
        return this.deleteRemote(item, true);
      }

      throw new Error(data.message || 'Bilibili: 删除远程记录失败');
    }

    return true;
  }
}

export default BilibiliProvider;
