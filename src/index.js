import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { syncHistory, initProviders, deleteRemoteHistory, getEnabledProviders } from './services/history.js';
import { initCookieService } from './services/cookie.js';
import fetch from 'node-fetch';
import { setInterval as setNodeInterval, clearInterval as clearNodeInterval } from 'timers';
import db, { initDatabase } from './db/index.js';
import { createAuthMiddleware, setupAuthRoutes } from './middleware/auth.js';
import logger from './utils/logger.js';
import { initNotificationService, notifyServerStart, notifyServerStop, notifySyncError, notifySyncSuccess } from './services/notification.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const config = JSON.parse(readFileSync(join(__dirname, '../config.json'), 'utf-8'));

// 初始化数据库
initDatabase();

// 初始化 Cookie 服务（需要在 Providers 之前）
initCookieService(config);

// 初始化 Providers
initProviders(config);

// 初始化通知服务
initNotificationService(config.notification, config.server?.timezone ?? 8);

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// 认证路由（需要在认证中间件之前注册）
setupAuthRoutes(app, config.auth);

// 认证中间件（白名单路径不需要认证）
const authWhitelist = [
  '/api/auth/status',
  '/api/auth/verify',
  '/img-proxy'
];
app.use(createAuthMiddleware(config.auth, authWhitelist));

// 预编译查询语句
const stmts = {
  getById: db.prepare('SELECT * FROM history WHERE id = ?'),
  deleteById: db.prepare('DELETE FROM history WHERE id = ?'),
};

// Bilibili 自动同步定时器
let bilibiliSyncTimer = null;
function startBilibiliAutoSync() {
  if (bilibiliSyncTimer) clearNodeInterval(bilibiliSyncTimer);

  // 检查 Bilibili 是否启用
  if (!config.providers?.bilibili?.enabled) {
    logger.info('[Bilibili] 未启用，跳过自动同步');
    return;
  }

  const interval = (config.providers?.bilibili?.syncInterval || 60) * 60000;
  bilibiliSyncTimer = setNodeInterval(async () => {
    try {
      const result = await syncHistory('bilibili');
      logger.info(`[Bilibili] 自动同步成功: 新增 ${result.totalNew}, 更新 ${result.totalUpdate}`);
      notifySyncSuccess({ platform: 'bilibili', newCount: result.totalNew, updateCount: result.totalUpdate });
    } catch (e) {
      logger.error('[Bilibili] 自动同步失败: ' + e.message, e);
      notifySyncError({ platform: 'bilibili', error: e.message, syncType: '自动同步' });
    }
  }, interval);
  logger.info(`[Bilibili] 自动同步定时器已启动，间隔: ${interval / 60000} 分钟`);
}
startBilibiliAutoSync();

// YouTube 自动同步定时器
let youtubeSyncTimer = null;
let youtubeNextSyncTimeout = null;

/**
 * 获取指定时区的当前时间
 * @param {number} timezoneOffset - 时区偏移（小时），如 8 表示 UTC+8
 * @returns {Date} 调整后的时间
 */
function getTimeInTimezone(timezoneOffset = 8) {
  const now = new Date();
  // 获取 UTC 时间，然后加上时区偏移
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcTime + timezoneOffset * 3600000);
}

/**
 * 计算下一个 YouTube 同步时间点
 * @returns {{nextTime: Date, delay: number}}
 */
function getNextYouTubeSyncTime() {
  // 获取配置的时区，默认北京时间 (UTC+8)
  const timezoneOffset = config.server?.timezone ?? 8;
  const tzNow = getTimeInTimezone(timezoneOffset);
  const hours = tzNow.getHours();

  // 计算目标时间点（在配置时区中的 00:00 或 12:00）
  let targetHour;
  let daysToAdd = 0;

  if (hours < 12) {
    targetHour = 12;
  } else {
    targetHour = 0;
    daysToAdd = 1;
  }

  // 构建目标时间（在配置时区）
  const targetInTz = new Date(
    tzNow.getFullYear(),
    tzNow.getMonth(),
    tzNow.getDate() + daysToAdd,
    targetHour, 0, 0
  );

  // 转换回本地时间进行延迟计算
  const now = new Date();
  const targetUtc = targetInTz.getTime() - timezoneOffset * 3600000;
  const targetLocal = new Date(targetUtc - now.getTimezoneOffset() * 60000);

  const delay = targetLocal.getTime() - now.getTime();

  // 用于日志显示的时间字符串
  const displayTime = `${targetInTz.getFullYear()}-${String(targetInTz.getMonth() + 1).padStart(2, '0')}-${String(targetInTz.getDate()).padStart(2, '0')} ${String(targetInTz.getHours()).padStart(2, '0')}:00 (UTC+${timezoneOffset})`;

  return { nextTime: targetLocal, delay, displayTime };
}

/**
 * 执行 YouTube 同步
 */
async function doYouTubeSync() {
  try {
    logger.info('[YouTube] 开始自动同步...');
    const result = await syncHistory('youtube');
    logger.info(`[YouTube] 自动同步成功: 新增 ${result.totalNew}, 更新 ${result.totalUpdate}`);
    notifySyncSuccess({ platform: 'youtube', newCount: result.totalNew, updateCount: result.totalUpdate });
  } catch (e) {
    logger.error('[YouTube] 自动同步失败: ' + e.message, e);
    notifySyncError({ platform: 'youtube', error: e.message, syncType: '自动同步' });
  }
}

/**
 * 启动 YouTube 自动同步
 */
function startYouTubeAutoSync() {
  // 清理现有定时器
  if (youtubeSyncTimer) clearNodeInterval(youtubeSyncTimer);
  if (youtubeNextSyncTimeout) clearTimeout(youtubeNextSyncTimeout);

  // 检查 YouTube 是否启用
  if (!config.providers?.youtube?.enabled) {
    logger.info('[YouTube] 未启用，跳过自动同步');
    return;
  }

  const interval = (config.providers.youtube.syncInterval || 720) * 60000; // 默认 12 小时
  const { delay, displayTime } = getNextYouTubeSyncTime();

  logger.info(`[YouTube] 下一次同步时间: ${displayTime}，等待 ${Math.round(delay / 60000)} 分钟`);

  // 先设置一个 timeout 到下一个定时点
  youtubeNextSyncTimeout = setTimeout(() => {
    // 执行第一次同步
    doYouTubeSync();

    // 然后启动固定间隔的定时器
    youtubeSyncTimer = setNodeInterval(doYouTubeSync, interval);
    logger.info(`[YouTube] 定时同步已启动，间隔: ${interval / 60000} 分钟`);
  }, delay);
}
startYouTubeAutoSync();

// YouTube-CDP 自动同步定时器
let youtubeCdpSyncTimer = null;
function startYouTubeCdpAutoSync() {
  if (youtubeCdpSyncTimer) clearNodeInterval(youtubeCdpSyncTimer);

  // 检查 YouTube-CDP 是否启用
  if (!config.providers?.['youtube-cdp']?.enabled) {
    logger.info('[YouTube-CDP] 未启用，跳过自动同步');
    return;
  }

  const interval = (config.providers['youtube-cdp'].syncInterval || 480) * 60000; // 默认 8 小时
  youtubeCdpSyncTimer = setNodeInterval(async () => {
    try {
      const result = await syncHistory('youtube-cdp');
      logger.info(`[YouTube-CDP] 自动同步成功: 新增 ${result.totalNew}, 更新 ${result.totalUpdate}`);
      notifySyncSuccess({ platform: 'youtube-cdp', newCount: result.totalNew, updateCount: result.totalUpdate });
    } catch (e) {
      logger.error('[YouTube-CDP] 自动同步失败: ' + e.message, e);
      notifySyncError({ platform: 'youtube-cdp', error: e.message, syncType: '自动同步' });
    }
  }, interval);
  logger.info(`[YouTube-CDP] 自动同步定时器已启动，间隔: ${interval / 60000} 分钟`);
}
startYouTubeCdpAutoSync();

// 小宇宙自动同步定时器
let xiaoyuzhouSyncTimer = null;
function startXiaoyuzhouAutoSync() {
  if (xiaoyuzhouSyncTimer) clearNodeInterval(xiaoyuzhouSyncTimer);

  // 检查小宇宙是否启用
  if (!config.providers?.xiaoyuzhou?.enabled) {
    logger.info('[Xiaoyuzhou] 未启用，跳过自动同步');
    return;
  }

  const interval = (config.providers.xiaoyuzhou.syncInterval || 60) * 60000; // 默认 1 小时
  xiaoyuzhouSyncTimer = setNodeInterval(async () => {
    try {
      const result = await syncHistory('xiaoyuzhou');
      logger.info(`[Xiaoyuzhou] 自动同步成功: 新增 ${result.totalNew}, 更新 ${result.totalUpdate}`);
      notifySyncSuccess({ platform: 'xiaoyuzhou', newCount: result.totalNew, updateCount: result.totalUpdate });
    } catch (e) {
      logger.error('[Xiaoyuzhou] 自动同步失败: ' + e.message, e);
      notifySyncError({ platform: 'xiaoyuzhou', error: e.message, syncType: '自动同步' });
    }
  }, interval);
  logger.info(`[Xiaoyuzhou] 自动同步定时器已启动，间隔: ${interval / 60000} 分钟`);
}
startXiaoyuzhouAutoSync();

/**
 * 构建查询历史记录的 SQL
 * @param {object} params 查询参数
 * @returns {{sql: string, params: any[]}}
 */
function buildHistoryQuery(params) {
  const { keyword = '', authorKeyword = '', date = '', platform = '' } = params;

  let sql = 'SELECT * FROM history WHERE 1=1';
  const sqlParams = [];

  // 平台过滤
  if (platform && platform !== 'all') {
    sql += ' AND platform = ?';
    sqlParams.push(platform);
  }

  if (keyword) {
    sql += ' AND title LIKE ?';
    sqlParams.push(`%${keyword}%`);
  }

  if (authorKeyword) {
    sql += ' AND author_name LIKE ?';
    sqlParams.push(`%${authorKeyword}%`);
  }

  if (date) {
    // 将日期转换为时间戳范围
    const dayStart = new Date(date + 'T00:00:00').getTime() / 1000;
    const dayEnd = new Date(date + 'T23:59:59').getTime() / 1000;
    sql += ' AND view_time >= ? AND view_time <= ?';
    sqlParams.push(dayStart, dayEnd);
  }

  sql += ' ORDER BY view_time DESC';

  return { sql, params: sqlParams };
}

// 获取历史记录
app.get('/api/history', (req, res) => {
  try {
    const { keyword = '', authorKeyword = '', date = '', platform = '', page = 1, pageSize = 20 } = req.query;
    const pageNum = parseInt(page, 10);
    const pageSizeNum = parseInt(pageSize, 10);
    const offset = (pageNum - 1) * pageSizeNum;

    // 构建查询
    const { sql, params } = buildHistoryQuery({ keyword, authorKeyword, date, platform });

    // 查询总数
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total').replace(' ORDER BY view_time DESC', '');
    const countResult = db.prepare(countSql).get(...params);
    const total = countResult.total;

    // 分页查询
    const pagedSql = sql + ' LIMIT ? OFFSET ?';
    const items = db.prepare(pagedSql).all(...params, pageSizeNum, offset);

    // 转换字段名以保持 API 兼容性
    const formattedItems = items.map(item => ({
      ...item,
      viewTime: item.view_time,
    }));

    res.json({
      items: formattedItems,
      total,
      hasMore: offset + items.length < total
    });
  } catch (error) {
    logger.error('查询历史记录失败: ' + error.message, error);
    res.status(500).json({ error: error.message });
  }
});

// 获取已启用的平台列表
app.get('/api/platforms', (req, res) => {
  const providers = getEnabledProviders();
  // 返回 Provider 实例的 platform 属性值（用于数据库查询）
  // 使用 Set 去重（例如 youtube 和 youtube-cdp 都使用 platform='youtube'）
  const platformSet = new Set(
    Object.values(providers).map(provider => provider.platform)
  );
  res.json({
    platforms: Array.from(platformSet)
  });
});

// 手动同步历史记录
app.post('/api/history/sync', async (req, res) => {
  try {
    const { platform } = req.body || {};
    const result = await syncHistory(platform || null);
    res.json({
      success: true,
      message: `同步成功，新增 ${result.totalNew} 条记录，更新 ${result.totalUpdate} 条记录`,
      details: result.results
    });
  } catch (error) {
    logger.error('同步历史记录失败: ' + error.message, error);
    const platformName = req.body?.platform || '所有平台';
    notifySyncError({ platform: platformName, error: error.message, syncType: '手动同步' });
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除历史记录
app.delete('/api/history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const item = stmts.getById.get(id);

    if (!item) {
      return res.status(404).json({ success: false, error: '记录不存在' });
    }

    // 调用对应平台的 Provider 删除远程记录
    try {
      await deleteRemoteHistory(item);
    } catch (error) {
      logger.warn(`删除远程记录失败 (${item.platform}): ${error.message}`);
      // 继续删除本地记录
    }

    // 删除本地记录
    stmts.deleteById.run(id);

    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    logger.error('删除失败: ' + error.message, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 图片代理接口
app.get('/img-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).send('Invalid url');
  }
  try {
    const response = await fetch(url, {
      headers: {
        'Referer': 'https://www.bilibili.com/',
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0'
      }
    });
    if (!response.ok) {
      return res.status(502).send('Bad gateway');
    }
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    response.body.pipe(res);
  } catch (e) {
    res.status(500).send('Proxy error');
  }
});

// 设置自动同步间隔 API（接收分钟值）
app.post('/api/set-sync-interval', express.json(), (req, res) => {
  const { interval } = req.body;
  if (!interval || typeof interval !== 'number' || interval < 1) {
    return res.status(400).json({ error: '无效的同步间隔，最小1分钟' });
  }
  // 确保 providers.bilibili 存在
  if (!config.providers.bilibili) config.providers.bilibili = {};
  config.providers.bilibili.syncInterval = interval;
  // 更新 config.json
  const configPath = join(__dirname, '../config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  startBilibiliAutoSync();
  res.json({ message: '同步间隔已更新', interval });
});

// 获取当前同步间隔 API（返回分钟值）
app.get('/api/get-sync-interval', (req, res) => {
  const interval = config.providers?.bilibili?.syncInterval || 60;
  res.json({ interval });
});

// 启动服务器
const server = app.listen(config.server.port, () => {
  logger.info(`服务器运行在 http://localhost:${config.server.port}`);

  // 发送启动通知
  const enabledProviders = Object.keys(getEnabledProviders());
  notifyServerStart({ port: config.server.port, enabledProviders });
});

/**
 * 优雅退出处理
 * 清理所有定时器、关闭服务器和数据库连接
 */
async function gracefulShutdown(signal) {
  logger.info(`收到 ${signal} 信号，正在关闭服务器...`);

  // 发送停止通知（不等待完成，避免阻塞退出流程）
  notifyServerStop({ signal }).catch(() => {});

  // 清理所有定时器
  if (bilibiliSyncTimer) {
    clearNodeInterval(bilibiliSyncTimer);
    bilibiliSyncTimer = null;
    logger.info('[Bilibili] 自动同步定时器已停止');
  }
  if (youtubeSyncTimer) {
    clearNodeInterval(youtubeSyncTimer);
    youtubeSyncTimer = null;
    logger.info('[YouTube] 自动同步定时器已停止');
  }
  if (youtubeNextSyncTimeout) {
    clearTimeout(youtubeNextSyncTimeout);
    youtubeNextSyncTimeout = null;
    logger.info('[YouTube] 下次同步延时已取消');
  }
  if (youtubeCdpSyncTimer) {
    clearNodeInterval(youtubeCdpSyncTimer);
    youtubeCdpSyncTimer = null;
    logger.info('[YouTube-CDP] 自动同步定时器已停止');
  }
  if (xiaoyuzhouSyncTimer) {
    clearNodeInterval(xiaoyuzhouSyncTimer);
    xiaoyuzhouSyncTimer = null;
    logger.info('[Xiaoyuzhou] 自动同步定时器已停止');
  }

  // 关闭 HTTP 服务器
  server.close((err) => {
    if (err) {
      logger.error('关闭服务器时出错: ' + err.message, err);
    } else {
      logger.info('HTTP 服务器已关闭');
    }

    // 关闭数据库连接
    try {
      db.close();
      logger.info('数据库连接已关闭');
    } catch (dbErr) {
      logger.error('关闭数据库时出错: ' + dbErr.message, dbErr);
    }

    logger.info('服务器已完全停止');
    process.exit(0);
  });

  // 设置超时强制退出，防止无限等待
  setTimeout(() => {
    logger.warn('优雅退出超时，强制退出');
    process.exit(1);
  }, 10000);
}

// 监听终止信号
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
