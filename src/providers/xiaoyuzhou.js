/**
 * 小宇宙播客历史记录提供者
 *
 * 使用小宇宙 API 获取播客播放历史记录
 * 需要配置 accessToken 和 refreshToken
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base.js';
import db from '../db/index.js';
import logger from '../utils/logger.js';

// 小宇宙 API 配置
const API_CONFIG = {
  baseUrl: 'https://api.xiaoyuzhoufm.com',
  historyEndpoint: '/v1/episode-played/list-history',
  maxRetries: 3,
  retryDelay: 2000,
  requestInterval: 1000,
};

// 同步状态文件路径
const SYNC_STATE_FILE = './data/xiaoyuzhou_sync_state.json';

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
async function fetchWithRetry(url, options, retries = API_CONFIG.maxRetries) {
  try {
    const response = await fetch(url, options);
    return response;
  } catch (error) {
    if (retries > 0) {
      logger.warn(`[Xiaoyuzhou] 网络请求失败 (${error.message})，${API_CONFIG.retryDelay / 1000}秒后重试，剩余 ${retries} 次...`);
      await sleep(API_CONFIG.retryDelay);
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
}

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
 * 小宇宙播客历史记录提供者
 */
export class XiaoyuzhouProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.platform = 'xiaoyuzhou';
    this.pageSize = config?.pageSize || 25;
    this.maxPages = config?.maxPages || 20;
  }

  /**
   * 验证配置
   * @returns {boolean}
   */
  validateConfig() {
    if (!this.enabled) return false;

    if (!this.config.accessToken) {
      logger.warn('[Xiaoyuzhou] accessToken 未配置');
      return false;
    }

    return true;
  }

  /**
   * 读取同步状态
   * @returns {object} { lastSyncTime: number, lastEid: string }
   */
  _readSyncState() {
    try {
      if (fs.existsSync(SYNC_STATE_FILE)) {
        const content = fs.readFileSync(SYNC_STATE_FILE, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      logger.warn(`[Xiaoyuzhou] 读取同步状态失败: ${err.message}`);
    }
    return { lastSyncTime: 0, lastEid: null };
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
      logger.error(`[Xiaoyuzhou] 保存同步状态失败: ${err.message}`);
    }
  }

  /**
   * 构建请求头
   * @returns {object}
   */
  _buildHeaders() {
    // 生成随机设备 ID（如果未配置）
    const deviceId = this.config.deviceId || this._generateDeviceId();

    const headers = {
      'Content-Type': 'application/json;charset=utf-8',
      'User-Agent': 'Xiaoyuzhou/2.102.2(android 36)',
      'os': 'android',
      'os-version': '36',
      'manufacturer': 'Xiaomi',
      'model': '23127PN0CC',
      'applicationid': 'app.podcast.cosmos',
      'app-version': '2.102.2',
      'app-buildno': '1395',
      'x-jike-device-id': deviceId,
      'x-jike-access-token': this.config.accessToken,
    };

    if (this.config.refreshToken) {
      headers['x-jike-refresh-token'] = this.config.refreshToken;
    }

    return headers;
  }

  /**
   * 生成随机设备 ID
   * @returns {string}
   */
  _generateDeviceId() {
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
   * 调用小宇宙 API 获取历史记录
   * @param {string|null} loadMoreKey - 分页游标
   * @returns {Promise<{data: object[], loadMoreKey: string|null}>}
   */
  async _fetchHistory(loadMoreKey = null) {
    const url = `${API_CONFIG.baseUrl}${API_CONFIG.historyEndpoint}`;
    const body = {
      limit: this.pageSize,
    };

    if (loadMoreKey) {
      body.loadMoreKey = loadMoreKey;
    }

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: this._buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // 检查是否是认证错误
      if (response.status === 401 || response.status === 403) {
        throw new Error('Xiaoyuzhou: 认证失败，请检查 accessToken 和 deviceId 是否有效');
      }
      throw new Error(`Xiaoyuzhou: API 请求失败 (${response.status})`);
    }

    const result = await response.json();

    // 检查 API 响应格式
    if (!result.data) {
      throw new Error('Xiaoyuzhou: API 响应格式异常');
    }

    return {
      data: result.data || [],
      loadMoreKey: result.loadMoreKey || null,
    };
  }

  /**
   * 标准化数据格式
   * @param {object} rawItem - 小宇宙 API 返回的原始数据
   * @param {number} viewTime - 观看时间戳
   * @returns {object}
   */
  normalizeItem(rawItem, viewTime) {
    const episode = rawItem.episode || rawItem;

    // 获取封面图
    let cover = '';
    if (episode.image && episode.image.picUrl) {
      cover = episode.image.picUrl;
    } else if (episode.podcast && episode.podcast.image && episode.podcast.image.picUrl) {
      cover = episode.podcast.image.picUrl;
    }

    // 获取播客信息
    const podcast = episode.podcast || {};

    return {
      id: episode.eid,
      platform: this.platform,
      business: 'podcast',
      bvid: episode.pid || '',
      cid: episode.duration || 0,
      title: episode.title || '',
      tag_name: podcast.title || '',
      cover: cover,
      viewTime: viewTime,
      uri: `https://www.xiaoyuzhoufm.com/episode/${episode.eid}`,
      author_name: podcast.author || '',
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
      throw new Error('Xiaoyuzhou: 配置无效，请确保已配置 accessToken');
    }

    // 读取同步状态
    const syncState = this._readSyncState();
    const isFirstSync = syncState.lastSyncTime === 0;

    logger.info(`[Xiaoyuzhou] ${isFirstSync ? '首次同步' : '增量同步'}，上次同步时间: ${syncState.lastSyncTime ? new Date(syncState.lastSyncTime).toISOString() : '无'}`);

    let loadMoreKey = null;
    let pageCount = 0;
    let newCount = 0;
    let skippedCount = 0;
    let shouldStop = false;
    const currentTime = Math.floor(Date.now() / 1000);
    let firstEid = null;

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

    while (!shouldStop) {
      pageCount++;

      // 首次同步限制最大页数
      if (isFirstSync && pageCount > this.maxPages) {
        logger.info(`[Xiaoyuzhou] 首次同步已达最大页数限制 (${this.maxPages})`);
        break;
      }

      logger.debug(`[Xiaoyuzhou] 获取第 ${pageCount} 页...`);

      try {
        const { data, loadMoreKey: nextKey } = await this._fetchHistory(loadMoreKey);

        if (data.length === 0) {
          logger.info('[Xiaoyuzhou] 没有更多数据');
          break;
        }

        const newItems = [];

        for (const rawItem of data) {
          const episode = rawItem.episode || rawItem;
          if (!episode.eid) {
            continue;
          }

          // 记录第一条记录的 eid
          if (firstEid === null) {
            firstEid = episode.eid;
          }

          // 检查是否已存在
          const existing = stmts.getById.get(episode.eid, this.platform);

          if (existing) {
            // 增量同步：遇到已存在的记录时停止
            if (!isFirstSync) {
              logger.info(`[Xiaoyuzhou] 遇到已存在的记录 (${episode.eid})，停止同步`);
              shouldStop = true;
              break;
            }
            // 首次同步：跳过已存在的记录
            skippedCount++;
            continue;
          }

          // 新记录
          const item = this.normalizeItem(rawItem, currentTime);
          newItems.push(item);
        }

        // 批量插入
        if (newItems.length > 0) {
          batchInsert(newItems);
          newCount += newItems.length;
        }

        logger.debug(`[Xiaoyuzhou] 第 ${pageCount} 页: 新增 ${newItems.length} 条，跳过 ${data.length - newItems.length} 条`);

        // 检查是否有更多数据
        if (!nextKey) {
          logger.info('[Xiaoyuzhou] 已到达历史记录末尾');
          break;
        }

        loadMoreKey = nextKey;

        // 延时避免请求过于频繁
        await sleep(API_CONFIG.requestInterval);

      } catch (error) {
        logger.error(`[Xiaoyuzhou] 获取历史记录失败: ${error.message}`);
        throw error;
      }
    }

    // 保存同步状态
    this._saveSyncState({
      lastSyncTime: Date.now(),
      lastSyncAt: new Date().toISOString(),
      lastEid: firstEid || syncState.lastEid,
    });

    logger.info(`[Xiaoyuzhou] 同步完成: 新增 ${newCount} 条，跳过 ${skippedCount} 条重复`);

    return { newCount, updateCount: 0 };
  }

  /**
   * 删除远程历史记录（暂不实现）
   * @param {object} item - 历史记录项
   * @returns {Promise<boolean>}
   */
  async deleteRemote(item) {
    logger.info('[Xiaoyuzhou] 删除远程记录功能暂未实现');
    return false;
  }
}

export default XiaoyuzhouProvider;
