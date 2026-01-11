import fetch from 'node-fetch';
import { BaseProvider } from './base.js';
import db from '../db/index.js';
import { getCookieService } from '../services/cookie.js';

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
   * @returns {Promise<string>}
   */
  async getCookie() {
    try {
      const cookieService = getCookieService();
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
   * @returns {Promise<{newCount: number, updateCount: number}>}
   */
  async sync() {
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
      const response = await fetch(
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
        if (!hasNewOrUpdated && processedIds.size >= 100) {
          console.log('[Bilibili] 没有新的更新，同步结束');
          break;
        }

        // 延时避免请求过于频繁
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return { newCount, updateCount };
  }

  /**
   * 删除远程历史记录
   * @param {object} item - 历史记录项
   * @returns {Promise<boolean>}
   */
  async deleteRemote(item) {
    // 获取 cookie
    const cookie = await this.getCookie();
    const biliJct = this.getBiliJct(cookie);

    if (!biliJct) {
      throw new Error('Bilibili: 未找到 bili_jct，请检查 cookie 配置');
    }

    const kid = `${item.business}_${item.id}`;
    const response = await fetch('https://api.bilibili.com/x/v2/history/delete', {
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
      throw new Error(data.message || 'Bilibili: 删除远程记录失败');
    }

    return true;
  }
}

export default BilibiliProvider;
