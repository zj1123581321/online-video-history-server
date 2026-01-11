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
    console.log('[Bilibili] 未启用，跳过自动同步');
    return;
  }

  const interval = config.server.syncInterval || 3600000;
  bilibiliSyncTimer = setNodeInterval(async () => {
    try {
      const result = await syncHistory('bilibili');
      console.log(`[Bilibili] 自动同步成功: 新增 ${result.totalNew}, 更新 ${result.totalUpdate}`);
    } catch (e) {
      console.error('[Bilibili] 自动同步失败:', e);
    }
  }, interval);
  console.log(`[Bilibili] 自动同步定时器已启动，间隔: ${interval}ms`);
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
    console.log('[YouTube] 开始自动同步...');
    const result = await syncHistory('youtube');
    console.log(`[YouTube] 自动同步成功: 新增 ${result.totalNew}, 更新 ${result.totalUpdate}`);
  } catch (e) {
    console.error('[YouTube] 自动同步失败:', e);
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
    console.log('[YouTube] 未启用，跳过自动同步');
    return;
  }

  const interval = config.providers.youtube.syncInterval || 43200000; // 默认 12 小时
  const { delay, displayTime } = getNextYouTubeSyncTime();

  console.log(`[YouTube] 下一次同步时间: ${displayTime}，等待 ${Math.round(delay / 60000)} 分钟`);

  // 先设置一个 timeout 到下一个定时点
  youtubeNextSyncTimeout = setTimeout(() => {
    // 执行第一次同步
    doYouTubeSync();

    // 然后启动固定间隔的定时器
    youtubeSyncTimer = setNodeInterval(doYouTubeSync, interval);
    console.log(`[YouTube] 定时同步已启动，间隔: ${interval}ms`);
  }, delay);
}
startYouTubeAutoSync();

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
    console.error('查询历史记录失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取已启用的平台列表
app.get('/api/platforms', (req, res) => {
  const providers = getEnabledProviders();
  res.json({
    platforms: Object.keys(providers)
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
    console.error('同步历史记录失败:', error);
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
      console.warn(`删除远程记录失败 (${item.platform}):`, error.message);
      // 继续删除本地记录
    }

    // 删除本地记录
    stmts.deleteById.run(id);

    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    console.error('删除失败:', error);
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

// 设置自动同步间隔 API
app.post('/api/set-sync-interval', express.json(), (req, res) => {
  const { interval } = req.body;
  if (!interval || typeof interval !== 'number' || interval < 60000) {
    return res.status(400).json({ error: '无效的同步间隔，最小1分钟' });
  }
  config.server.syncInterval = interval;
  // 更新 config.json
  const configPath = join(__dirname, '../config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  startAutoSync();
  res.json({ message: '同步间隔已更新', interval });
});

// 获取当前同步间隔 API
app.get('/api/get-sync-interval', (req, res) => {
  res.json({ interval: config.server.syncInterval || 3600000 });
});

// 启动服务器
app.listen(config.server.port, () => {
  console.log(`服务器运行在 http://localhost:${config.server.port}`);
});
