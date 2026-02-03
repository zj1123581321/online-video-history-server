/**
 * YouTube 历史记录提供者 - CDP 版本
 *
 * 使用 Chrome DevTools Protocol 连接到远程 Chrome 获取 YouTube 观看历史记录
 * 支持精确的观看时间解析
 */

import CDP from 'chrome-remote-interface';
import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base.js';
import db from '../db/index.js';
import { getCookieService } from '../services/cookie.js';
import logger from '../utils/logger.js';

// 同步状态文件路径
const SYNC_STATE_FILE = './data/youtube_cdp_sync_state.json';

// 预编译 SQL 语句
const stmts = {
  getById: db.prepare('SELECT id, view_time FROM history WHERE id = ? AND platform = ?'),
  insert: db.prepare(`
    INSERT OR IGNORE INTO history
    (id, platform, business, bvid, cid, title, tag_name, cover, view_time, uri, author_name, author_mid, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
};

/**
 * 等待指定时间
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * YouTube CDP 历史记录提供者
 */
export class YouTubeCDPProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.platform = 'youtube-cdp';
    // 清理 host 配置，移除可能误配置的协议前缀
    let host = config?.cdp?.host || 'localhost';
    host = host.replace(/^https?:\/\//, '');
    this.cdpHost = host;
    this.cdpPort = config?.cdp?.port || 9222;
    this.maxScrolls = config?.cdp?.maxScrolls || 15;
    this.scrollInterval = config?.cdp?.scrollInterval || 3000;
    this.targetLoadCount = config?.cdp?.targetLoadCount || 50;
    this.timezoneOffset = config?.timezoneOffset || 8; // UTC+8
  }

  /**
   * 验证配置
   */
  validateConfig() {
    if (!this.enabled) {
      logger.info('[YouTube-CDP] Provider 未启用');
      return false;
    }

    // 检查 CDP 配置
    if (!this.cdpHost || !this.cdpPort) {
      logger.warn('[YouTube-CDP] CDP 配置不完整，需要 host 和 port');
      return false;
    }

    logger.info(`[YouTube-CDP] 配置验证通过 (${this.cdpHost}:${this.cdpPort})`);
    return true;
  }

  /**
   * 读取同步状态
   * @returns {object} { lastSyncTime: number }
   */
  _readSyncState() {
    try {
      if (fs.existsSync(SYNC_STATE_FILE)) {
        const content = fs.readFileSync(SYNC_STATE_FILE, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      logger.warn(`[YouTube-CDP] 读取同步状态失败: ${err.message}`);
    }
    return { lastSyncTime: 0 };
  }

  /**
   * 保存同步状态
   * @param {object} state - 同步状态
   */
  _saveSyncState(state) {
    try {
      const dir = path.dirname(SYNC_STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`[YouTube-CDP] 保存同步状态失败: ${err.message}`);
    }
  }

  /**
   * 等待元素出现
   */
  async _waitForSelector(Runtime, selector, timeout = 30000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const result = await Runtime.evaluate({
        expression: `document.querySelector('${selector}') !== null`,
      });
      if (result.result.value) return true;
      await sleep(500);
    }
    throw new Error(`等待元素超时: ${selector}`);
  }

  /**
   * 等待新内容加载完成
   * @param {object} Runtime - CDP Runtime
   * @param {number} previousCount - 滚动前的视频数量
   * @param {number} timeout - 超时时间（毫秒）
   * @returns {Promise<number>} 当前视频数量
   */
  async _waitForNewContent(Runtime, previousCount, timeout = 10000) {
    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeout) {
      const countResult = await Runtime.evaluate({
        expression: 'document.querySelectorAll("ytd-video-renderer").length',
      });
      const currentCount = countResult.result.value;

      if (currentCount > previousCount) {
        // 新内容已加载，再等待一小段时间确保渲染完成
        await sleep(500);
        return currentCount;
      }

      await sleep(checkInterval);
    }

    // 超时，返回当前数量
    const finalResult = await Runtime.evaluate({
      expression: 'document.querySelectorAll("ytd-video-renderer").length',
    });
    return finalResult.result.value;
  }

  /**
   * 智能滚动加载更多历史记录
   */
  async _scrollToLoadMore(Runtime) {
    logger.info(`[YouTube-CDP] 开始滚动加载历史记录 (目标 ${this.targetLoadCount} 条)...`);

    let previousCount = 0;
    let noNewContentCount = 0;

    // 获取初始数量
    const initialResult = await Runtime.evaluate({
      expression: 'document.querySelectorAll("ytd-video-renderer").length',
    });
    previousCount = initialResult.result.value;
    logger.info(`[YouTube-CDP] 初始视频数量: ${previousCount}`);

    for (let i = 0; i < this.maxScrolls; i++) {
      if (previousCount >= this.targetLoadCount) {
        logger.info(`[YouTube-CDP] ✓ 已达到目标数量 (${previousCount})`);
        break;
      }

      // 执行滚动（每次滚动当前文档高度的 30%，确保触发懒加载）
      await Runtime.evaluate({
        expression: 'window.scrollBy(0, document.documentElement.scrollHeight * 0.3)',
      });

      // 等待新内容加载
      const currentCount = await this._waitForNewContent(Runtime, previousCount, this.scrollInterval * 3);

      logger.info(`[YouTube-CDP]   第 ${i + 1}/${this.maxScrolls} 次滚动 - ${previousCount} → ${currentCount} 条`);

      if (currentCount === previousCount) {
        noNewContentCount++;
        if (noNewContentCount >= 3) {
          logger.info('[YouTube-CDP] 连续三次无新内容，停止滚动');
          break;
        }
        // 无新内容时额外等待
        await sleep(this.scrollInterval);
      } else {
        noNewContentCount = 0;
      }

      previousCount = currentCount;
    }

    logger.info(`[YouTube-CDP] 滚动完成，共加载 ${previousCount} 条记录`);
  }

  /**
   * 从页面提取视频和时间信息
   * 支持新旧两种 YouTube 页面元素：
   * - 旧元素: ytd-video-renderer
   * - 新元素: yt-lockup-view-model
   */
  async _extractVideosWithTime(Runtime) {
    // 提取视频详情（同时支持新旧两种元素）
    const result = await Runtime.evaluate({
      expression: `
        (() => {
          const items = [];
          const sections = document.querySelectorAll('ytd-item-section-renderer');

          sections.forEach((section) => {
            // 提取日期标题
            let dateText = '';
            const headerRenderer = section.querySelector('ytd-item-section-header-renderer');
            if (headerRenderer) {
              const titleElement = headerRenderer.querySelector('#title');
              dateText = titleElement?.textContent?.trim() || '';
            }

            // 方式1: 旧元素 ytd-video-renderer
            const videoRenderers = section.querySelectorAll('ytd-video-renderer');
            videoRenderers.forEach((renderer) => {
              try {
                const titleElement =
                  renderer.querySelector('#video-title') ||
                  renderer.querySelector('a#video-title-link');

                const title = titleElement?.textContent?.trim() || '';
                const url = titleElement?.href || '';

                let videoId = '';
                let videoType = 'video';
                if (url) {
                  const watchMatch = url.match(/[?&]v=([^&]+)/);
                  if (watchMatch) {
                    videoId = watchMatch[1];
                  } else {
                    const shortsMatch = url.match(/\\/shorts\\/([^?&\\/]+)/);
                    if (shortsMatch) {
                      videoId = shortsMatch[1];
                      videoType = 'shorts';
                    }
                  }
                }

                const channelElement =
                  renderer.querySelector('#channel-name a') ||
                  renderer.querySelector('ytd-channel-name a');
                const channelName = channelElement?.textContent?.trim() || '';

                if (title && dateText && videoId) {
                  items.push({
                    id: videoId,
                    title: title,
                    url: url,
                    type: videoType,
                    channelName: channelName,
                    dateHeader: dateText,
                  });
                }
              } catch (err) {
                console.error('提取视频失败(旧元素):', err.message);
              }
            });

            // 方式2: 新元素 yt-lockup-view-model
            const lockups = section.querySelectorAll('yt-lockup-view-model');
            lockups.forEach((lockup) => {
              try {
                const titleLink = lockup.querySelector('a[href*="watch"]') || lockup.querySelector('a[href*="shorts"]');
                const h3 = lockup.querySelector('h3');

                const title = h3?.textContent?.trim() || '';
                const url = titleLink?.href || '';

                let videoId = '';
                let videoType = 'video';
                if (url) {
                  const watchMatch = url.match(/[?&]v=([^&]+)/);
                  if (watchMatch) {
                    videoId = watchMatch[1];
                  } else {
                    const shortsMatch = url.match(/\\/shorts\\/([^?&\\/]+)/);
                    if (shortsMatch) {
                      videoId = shortsMatch[1];
                      videoType = 'shorts';
                    }
                  }
                }

                const channelLink = lockup.querySelector('a[href*="channel"]') || lockup.querySelector('a[href*="@"]');
                const channelName = channelLink?.textContent?.trim() || '';

                if (title && dateText && videoId) {
                  items.push({
                    id: videoId,
                    title: title,
                    url: url,
                    type: videoType,
                    channelName: channelName,
                    dateHeader: dateText,
                  });
                }
              } catch (err) {
                console.error('提取视频失败(新元素):', err.message);
              }
            });
          });

          return items;
        })()
      `,
      returnByValue: true,
    });

    const items = result.result.value || [];

    // 输出视频详情日志（只显示前 10 条）
    logger.info(`[YouTube-CDP] 提取到 ${items.length} 条视频记录`);
    const showCount = Math.min(items.length, 10);
    for (let i = 0; i < showCount; i++) {
      const item = items[i];
      const titleShort = item.title.length > 30 ? item.title.substring(0, 30) + '...' : item.title;
      logger.info(`[YouTube-CDP]   [${i + 1}] ${item.dateHeader} | ${item.id} | ${titleShort}`);
    }
    if (items.length > 10) {
      logger.info(`[YouTube-CDP]   ... 还有 ${items.length - 10} 条`);
    }

    return items;
  }

  /**
   * 解析日期字符串为时间戳
   * 支持格式：
   * - "Today", "Yesterday" 相对日期
   * - "Thursday", "Friday" 等星期格式
   * - "Jan 26", "Feb 11" 等月+日格式（默认当年）
   * - "Dec 15, 2025", "Feb 11, 2025" 等完整日期格式
   */
  _parseDateString(dateStr) {
    const now = new Date();
    const currentYear = now.getFullYear();

    const monthMap = {
      'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3,
      'May': 4, 'Jun': 5, 'Jul': 6, 'Aug': 7,
      'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11,
    };

    const weekdayMap = {
      'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4,
      'Friday': 5, 'Saturday': 6, 'Sunday': 0,
    };

    try {
      // 格式 0: "Today", "Yesterday" (相对日期)
      const lowerDateStr = dateStr.trim().toLowerCase();
      if (lowerDateStr === 'today') {
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        const utcTimestamp = today.getTime() - (this.timezoneOffset * 3600000);
        return Math.floor(utcTimestamp / 1000);
      }
      if (lowerDateStr === 'yesterday') {
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        const utcTimestamp = yesterday.getTime() - (this.timezoneOffset * 3600000);
        return Math.floor(utcTimestamp / 1000);
      }

      // 格式 1: "Dec 15, 2025" (完整日期)
      const fullDateMatch = dateStr.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})$/);
      if (fullDateMatch) {
        const [, month, day, year] = fullDateMatch;
        const monthIndex = monthMap[month];
        if (monthIndex !== undefined) {
          const date = new Date(parseInt(year), monthIndex, parseInt(day), 0, 0, 0, 0);
          const utcTimestamp = date.getTime() - (this.timezoneOffset * 3600000);
          return Math.floor(utcTimestamp / 1000);
        }
      }

      // 格式 2: "Jan 26" (月+日，默认当年)
      const monthDayMatch = dateStr.match(/^([A-Z][a-z]{2})\s+(\d{1,2})$/);
      if (monthDayMatch) {
        const [, month, day] = monthDayMatch;
        const monthIndex = monthMap[month];
        if (monthIndex !== undefined) {
          let year = currentYear;
          const testDate = new Date(year, monthIndex, parseInt(day));
          if (testDate > now) {
            year -= 1;
          }

          const date = new Date(year, monthIndex, parseInt(day), 0, 0, 0, 0);
          const utcTimestamp = date.getTime() - (this.timezoneOffset * 3600000);
          return Math.floor(utcTimestamp / 1000);
        }
      }

      // 格式 3: "Thursday" (星期，取最近的过去的这一天)
      const weekdayName = dateStr.trim();
      if (weekdayMap.hasOwnProperty(weekdayName)) {
        const targetWeekday = weekdayMap[weekdayName];
        const currentWeekday = now.getDay();

        let daysAgo = currentWeekday - targetWeekday;
        if (daysAgo <= 0) {
          daysAgo += 7;
        }

        const targetDate = new Date(now);
        targetDate.setDate(now.getDate() - daysAgo);
        targetDate.setHours(0, 0, 0, 0);

        const utcTimestamp = targetDate.getTime() - (this.timezoneOffset * 3600000);
        return Math.floor(utcTimestamp / 1000);
      }

      logger.warn(`[YouTube-CDP] 无法解析日期: "${dateStr}"`);
      return Math.floor(Date.now() / 1000);

    } catch (err) {
      logger.error(`[YouTube-CDP] 解析日期失败: "${dateStr}" - ${err.message}`);
      return Math.floor(Date.now() / 1000);
    }
  }

  /**
   * 获取 YouTube 缩略图 URL
   */
  _getThumbnailUrl(videoId, quality = 'hqdefault') {
    return videoId ? `https://i.ytimg.com/vi/${videoId}/${quality}.jpg` : '';
  }

  /**
   * 标准化数据格式
   */
  normalizeItem(item) {
    const viewTime = this._parseDateString(item.dateHeader);
    const thumbnail = this._getThumbnailUrl(item.id);

    return {
      id: item.id,
      platform: this.platform,
      business: 'video',
      bvid: item.id,
      cid: 0,
      title: item.title,
      tag_name: item.type === 'shorts' ? 'shorts' : '',
      cover: thumbnail,
      viewTime: viewTime,
      uri: item.url,
      author_name: item.channelName,
      author_mid: 0,
      timestamp: Date.now(),
    };
  }

  /**
   * 同步历史记录
   */
  async sync() {
    if (!this.validateConfig()) {
      throw new Error('YouTube-CDP: 配置无效');
    }

    let client = null;

    try {
      logger.info(`[YouTube-CDP] 开始同步历史记录`);
      logger.info(`[YouTube-CDP] CDP 服务: ${this.cdpHost}:${this.cdpPort}`);

      // 读取同步状态
      const syncState = this._readSyncState();
      const lastSyncTime = syncState.lastSyncTime || 0;
      const isFirstSync = lastSyncTime === 0;

      logger.info(`[YouTube-CDP] ${isFirstSync ? '首次同步' : '增量同步'}，上次同步时间: ${lastSyncTime ? new Date(lastSyncTime * 1000).toISOString() : '无'}`);

      // 连接到远程 Chrome
      logger.info('[YouTube-CDP] 正在连接到远程 Chrome...');
      client = await CDP({
        host: this.cdpHost,
        port: this.cdpPort,
      });
      logger.info('[YouTube-CDP] ✓ 已连接');

      const { Network, Page, Runtime } = client;
      await Promise.all([Network.enable(), Page.enable(), Runtime.enable()]);

      // 导航到 YouTube 历史记录页面
      logger.info('[YouTube-CDP] 正在导航到 YouTube 历史记录页面...');
      await Page.navigate({ url: 'https://www.youtube.com/feed/history' });
      await Page.loadEventFired();
      logger.info('[YouTube-CDP] ✓ 页面加载完成');

      // 等待页面渲染
      await sleep(5000);
      await this._waitForSelector(Runtime, 'ytd-video-renderer', 10000);

      // 滚动到页面顶部，确保从最新记录开始（YouTube 会记忆上次滚动位置）
      logger.info('[YouTube-CDP] 滚动到页面顶部...');
      await Runtime.evaluate({
        expression: 'window.scrollTo(0, 0)',
      });
      await sleep(1000);
      logger.info('[YouTube-CDP] ✓ 已定位到页面顶部');

      // 滚动加载更多
      await this._scrollToLoadMore(Runtime);

      // 提取数据
      logger.info('[YouTube-CDP] 提取视频和时间信息...');
      const rawItems = await this._extractVideosWithTime(Runtime);
      logger.info(`[YouTube-CDP] ✓ 提取到 ${rawItems.length} 条原始记录`);

      if (rawItems.length === 0) {
        return { newCount: 0, updateCount: 0 };
      }

      // 标准化数据
      const items = rawItems.map(item => this.normalizeItem(item));

      // 插入数据库（支持增量同步）
      let newCount = 0;
      let skippedCount = 0;
      let stopped = false;

      // 获取当前同步时间（使用第一条记录的时间，如果没有则使用当前时间）
      const currentSyncTime = items.length > 0 ? items[0].viewTime : Math.floor(Date.now() / 1000);

      const batchInsert = db.transaction((items) => {
        for (const item of items) {
          const existing = stmts.getById.get(item.id, this.platform);

          if (existing) {
            // 增量同步优化：如果遇到上次同步的记录，停止插入
            if (!isFirstSync && existing.view_time >= lastSyncTime) {
              logger.info(`[YouTube-CDP] 遇到上次同步的记录 (${item.id})，停止同步`);
              stopped = true;
              break;
            }
            // 存在但是更早的记录（重复观看），跳过
            skippedCount++;
            continue;
          }

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
        }
      });

      batchInsert(items);

      // 保存同步状态
      this._saveSyncState({
        lastSyncTime: currentSyncTime,
        lastSyncAt: new Date().toISOString(),
      });

      const statusMsg = stopped ? '(提前终止)' : '';
      logger.info(`[YouTube-CDP] 同步完成${statusMsg}: 新增 ${newCount} 条，跳过 ${skippedCount} 条重复`);

      return { newCount, updateCount: 0 };

    } catch (err) {
      logger.error('[YouTube-CDP] 同步失败: ' + err.message, err);
      throw err;
    } finally {
      if (client) {
        await client.close();
        logger.info('[YouTube-CDP] ✓ 已断开 CDP 连接');
      }
    }
  }

  /**
   * 删除远程历史记录（暂不实现）
   */
  async deleteRemote(item) {
    logger.info('[YouTube-CDP] 删除远程记录功能暂未实现');
    return false;
  }
}

export default YouTubeCDPProvider;
