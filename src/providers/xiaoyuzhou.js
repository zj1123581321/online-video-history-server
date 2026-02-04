/**
 * 小宇宙播客历史记录提供者
 *
 * 使用小宇宙 API 获取播客播放历史记录
 * 只需配置 refreshToken，accessToken 会自动获取和刷新
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
  refreshEndpoint: '/app_auth_tokens.refresh',
  maxRetries: 3,
  retryDelay: 2000,
  requestInterval: 1000,
};

// 同步状态文件路径
const SYNC_STATE_FILE = './data/xiaoyuzhou_sync_state.json';
// Token 状态文件路径
const TOKEN_STATE_FILE = './data/xiaoyuzhou_tokens.json';

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
    // 运行时 token 状态
    this._accessToken = null;
    this._refreshToken = null;
    this._deviceId = null;
    this._tokenInitialized = false;
  }

  /**
   * 验证配置
   * @returns {boolean}
   */
  validateConfig() {
    if (!this.enabled) return false;

    // 只需要 refreshToken 或 accessToken 其中之一
    if (!this.config.refreshToken && !this.config.accessToken) {
      logger.warn('[Xiaoyuzhou] 需要配置 refreshToken 或 accessToken');
      return false;
    }

    return true;
  }

  /**
   * 读取 Token 状态
   * @returns {object} { accessToken, refreshToken, deviceId, updatedAt }
   */
  _readTokenState() {
    try {
      if (fs.existsSync(TOKEN_STATE_FILE)) {
        const content = fs.readFileSync(TOKEN_STATE_FILE, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      logger.warn(`[Xiaoyuzhou] 读取 Token 状态失败: ${err.message}`);
    }
    return {};
  }

  /**
   * 保存 Token 状态
   * @param {object} state - Token 状态
   */
  _saveTokenState(state) {
    try {
      const dir = path.dirname(TOKEN_STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(TOKEN_STATE_FILE, JSON.stringify({
        ...state,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
      logger.debug('[Xiaoyuzhou] Token 状态已保存');
    } catch (err) {
      logger.error(`[Xiaoyuzhou] 保存 Token 状态失败: ${err.message}`);
    }
  }

  /**
   * 初始化 Token
   * 优先级: 状态文件 > 配置文件
   */
  async _initTokens() {
    if (this._tokenInitialized) return;

    // 读取状态文件中的 token
    const savedState = this._readTokenState();

    // 设备 ID: 配置 > 状态文件 > 自动生成
    this._deviceId = this.config.deviceId || savedState.deviceId || this._generateDeviceId();

    // refreshToken: 状态文件 > 配置（状态文件的更新，配置的是初始值）
    this._refreshToken = savedState.refreshToken || this.config.refreshToken;

    // accessToken: 状态文件 > 配置
    this._accessToken = savedState.accessToken || this.config.accessToken || null;

    // 如果没有 accessToken，尝试刷新获取
    if (!this._accessToken && this._refreshToken) {
      logger.info('[Xiaoyuzhou] 无 accessToken，尝试刷新获取...');
      await this._refreshTokens();
    }

    // 保存设备 ID（如果是新生成的）
    if (!savedState.deviceId && !this.config.deviceId) {
      this._saveTokenState({
        accessToken: this._accessToken,
        refreshToken: this._refreshToken,
        deviceId: this._deviceId,
      });
    }

    this._tokenInitialized = true;
  }

  /**
   * 刷新 Token
   * @returns {Promise<boolean>} 是否刷新成功
   */
  async _refreshTokens() {
    if (!this._refreshToken) {
      logger.error('[Xiaoyuzhou] 无 refreshToken，无法刷新');
      return false;
    }

    logger.info('[Xiaoyuzhou] 正在刷新 Token...');

    try {
      const url = `${API_CONFIG.baseUrl}${API_CONFIG.refreshEndpoint}`;
      const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'User-Agent': 'Xiaoyuzhou/2.102.2(android 36)',
          'x-jike-device-id': this._deviceId,
          'x-jike-refresh-token': this._refreshToken,
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error(`[Xiaoyuzhou] Token 刷新失败 (${response.status}): ${text}`);
        return false;
      }

      const data = await response.json();

      if (data['x-jike-access-token']) {
        this._accessToken = data['x-jike-access-token'];
        // refreshToken 也会轮换，必须保存新的
        if (data['x-jike-refresh-token']) {
          this._refreshToken = data['x-jike-refresh-token'];
        }

        // 保存到状态文件
        this._saveTokenState({
          accessToken: this._accessToken,
          refreshToken: this._refreshToken,
          deviceId: this._deviceId,
        });

        logger.info('[Xiaoyuzhou] Token 刷新成功');
        return true;
      }

      logger.error('[Xiaoyuzhou] Token 刷新响应格式异常');
      return false;
    } catch (err) {
      logger.error(`[Xiaoyuzhou] Token 刷新异常: ${err.message}`);
      return false;
    }
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
    return {
      'Content-Type': 'application/json;charset=utf-8',
      'User-Agent': 'Xiaoyuzhou/2.102.2(android 36)',
      'os': 'android',
      'os-version': '36',
      'manufacturer': 'Xiaomi',
      'model': '23127PN0CC',
      'applicationid': 'app.podcast.cosmos',
      'app-version': '2.102.2',
      'app-buildno': '1395',
      'x-jike-device-id': this._deviceId,
      'x-jike-access-token': this._accessToken,
    };
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
   * @param {boolean} isRetry - 是否为重试请求
   * @returns {Promise<{data: object[], loadMoreKey: string|null}>}
   */
  async _fetchHistory(loadMoreKey = null, isRetry = false) {
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
      // 检查是否是认证错误，尝试刷新 token 后重试
      if ((response.status === 401 || response.status === 403) && !isRetry) {
        logger.warn('[Xiaoyuzhou] 认证失败，尝试刷新 Token 后重试...');
        const refreshed = await this._refreshTokens();
        if (refreshed) {
          return this._fetchHistory(loadMoreKey, true);
        }
        throw new Error('Xiaoyuzhou: Token 刷新失败，请检查 refreshToken 是否有效');
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
      throw new Error('Xiaoyuzhou: 配置无效，请确保已配置 refreshToken');
    }

    // 初始化 Token
    await this._initTokens();

    if (!this._accessToken) {
      throw new Error('Xiaoyuzhou: 无法获取有效的 accessToken');
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
