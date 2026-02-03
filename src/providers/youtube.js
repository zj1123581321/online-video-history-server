/**
 * YouTube 历史记录提供者
 *
 * 使用 yt-dlp 获取 YouTube 观看历史记录
 * Cookie 仅支持从 CookieCloud 获取
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base.js';
import db from '../db/index.js';
import { getCookieService } from '../services/cookie.js';
import logger from '../utils/logger.js';

// 同步状态文件路径
const SYNC_STATE_FILE = './data/youtube_sync_state.json';

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
 * YouTube 历史记录提供者
 */
export class YouTubeProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.platform = 'youtube';
    this.firstSyncCount = config?.firstSyncCount || 100;
  }

  /**
   * 验证配置
   * @returns {boolean}
   */
  validateConfig() {
    if (!this.enabled) return false;

    // YouTube 必须使用 CookieCloud
    try {
      const cookieService = getCookieService();
      if (!cookieService.isCookieCloudEnabled()) {
        logger.warn('[YouTube] 必须启用 CookieCloud 才能同步历史记录');
        return false;
      }
      return true;
    } catch {
      logger.warn('[YouTube] CookieService 未初始化');
      return false;
    }
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
      logger.warn(`[YouTube] 读取同步状态失败: ${err.message}`);
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
      logger.error(`[YouTube] 保存同步状态失败: ${err.message}`);
    }
  }

  /**
   * 调用 yt-dlp 获取历史记录
   * @param {string} cookieFile - cookie 文件路径
   * @param {number|null} limit - 限制条数，null 表示不限制
   * @returns {object[]} 视频条目列表
   */
  _fetchHistory(cookieFile, limit = null) {
    const args = [
      'yt-dlp',
      '--cookies', cookieFile,
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--sleep-interval', '2',
    ];

    if (limit) {
      args.push('--playlist-end', String(limit));
    }

    args.push('https://www.youtube.com/feed/history');

    logger.info(`[YouTube] 执行命令: ${args.join(' ')}`);

    try {
      const output = execSync(args.join(' '), {
        encoding: 'utf-8',
        timeout: 300000, // 5分钟超时
        maxBuffer: 50 * 1024 * 1024, // 50MB 缓冲区
      });

      const data = JSON.parse(output);
      return data.entries || [];
    } catch (err) {
      if (err.status) {
        logger.error(`[YouTube] yt-dlp 执行失败，退出码: ${err.status}`);
        logger.error(`[YouTube] stderr: ${err.stderr}`);
      }
      throw new Error(`yt-dlp 执行失败: ${err.message}`);
    }
  }

  /**
   * 标准化数据格式
   * @param {object} entry - yt-dlp 返回的视频条目
   * @param {number} viewTime - 观看时间戳
   * @returns {object}
   */
  normalizeItem(entry, viewTime) {
    // 获取最大尺寸的缩略图
    let cover = '';
    if (entry.thumbnails && entry.thumbnails.length > 0) {
      // 按尺寸排序，取最大的
      const sortedThumbs = [...entry.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
      cover = sortedThumbs[0].url || '';
    }

    return {
      id: entry.id,
      platform: this.platform,
      business: 'video',
      bvid: entry.id,
      cid: 0,
      title: entry.title || '',
      tag_name: '',
      cover: cover,
      viewTime: viewTime,
      uri: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
      author_name: '',
      author_mid: 0,
      timestamp: Date.now(),
    };
  }

  /**
   * 同步历史记录
   * @returns {Promise<{newCount: number, updateCount: number}>}
   */
  async sync() {
    if (!this.validateConfig()) {
      throw new Error('YouTube: 配置无效，请确保已启用 CookieCloud');
    }

    const cookieService = getCookieService();
    let cookieFile = null;

    try {
      // 获取 cookie 文件
      cookieFile = await cookieService.getCookieNetscapeFile('youtube');
      logger.info('[YouTube] Cookie 文件已准备');

      // 读取同步状态
      const syncState = this._readSyncState();
      const lastSyncTime = syncState.lastSyncTime || 0;
      const isFirstSync = lastSyncTime === 0;

      logger.info(`[YouTube] ${isFirstSync ? '首次同步' : '增量同步'}，上次同步时间: ${lastSyncTime ? new Date(lastSyncTime * 1000).toISOString() : '无'}`);

      // 获取历史记录
      const limit = isFirstSync ? this.firstSyncCount : null;
      const entries = this._fetchHistory(cookieFile, limit);

      logger.info(`[YouTube] 获取到 ${entries.length} 条记录`);

      if (entries.length === 0) {
        return { newCount: 0, updateCount: 0 };
      }

      // 当前时间作为 view_time
      const currentTime = Math.floor(Date.now() / 1000);
      let newCount = 0;
      let skippedCount = 0;

      // 使用事务批量处理
      const batchInsert = db.transaction((items) => {
        for (const item of items) {
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
        }
      });

      const newItems = [];

      for (const entry of entries) {
        if (!entry.id) {
          continue;
        }

        // 检查是否已存在
        const existing = stmts.getById.get(entry.id, this.platform);

        if (existing) {
          // 如果存在且 view_time >= lastSyncTime，说明遇到了上次同步的记录
          if (!isFirstSync && existing.view_time >= lastSyncTime) {
            logger.info(`[YouTube] 遇到上次同步的记录 (${entry.id})，停止同步`);
            break;
          }
          // 存在但是更早的记录（重复观看），跳过
          skippedCount++;
          continue;
        }

        // 新记录
        const item = this.normalizeItem(entry, currentTime);
        newItems.push(item);
      }

      // 批量插入
      if (newItems.length > 0) {
        batchInsert(newItems);
        newCount = newItems.length;
      }

      // 保存同步状态
      this._saveSyncState({
        lastSyncTime: currentTime,
        lastSyncAt: new Date().toISOString(),
      });

      logger.info(`[YouTube] 同步完成: 新增 ${newCount} 条，跳过 ${skippedCount} 条重复`);

      return { newCount, updateCount: 0 };
    } finally {
      // 清理临时 cookie 文件
      if (cookieFile) {
        cookieService.removeCookieFile(cookieFile);
      }
    }
  }

  /**
   * 删除远程历史记录（暂不实现）
   * @param {object} item - 历史记录项
   * @returns {Promise<boolean>}
   */
  async deleteRemote(item) {
    logger.info('[YouTube] 删除远程记录功能暂未实现');
    return false;
  }
}

export default YouTubeProvider;
