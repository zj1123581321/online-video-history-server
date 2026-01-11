import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { syncHistory } from './services/history.js';
import fetch from 'node-fetch';
import { setInterval as setNodeInterval, clearInterval as clearNodeInterval } from 'timers';
import db, { initDatabase } from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const config = JSON.parse(readFileSync(join(__dirname, '../config.json'), 'utf-8'));

// 初始化数据库
initDatabase();

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// 预编译查询语句
const stmts = {
  getById: db.prepare('SELECT * FROM history WHERE id = ?'),
  deleteById: db.prepare('DELETE FROM history WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) as total FROM history'),
};

// 自动同步定时器
let syncTimer = null;
function startAutoSync() {
  if (syncTimer) clearNodeInterval(syncTimer);
  const interval = config.server.syncInterval || 3600000;
  syncTimer = setNodeInterval(async () => {
    try {
      await syncHistory();
      console.log('自动同步成功');
    } catch (e) {
      console.error('自动同步失败:', e);
    }
  }, interval);
  console.log('自动同步定时器已启动，间隔(ms):', interval);
}
startAutoSync();

/**
 * 构建查询历史记录的 SQL
 * @param {object} params 查询参数
 * @returns {{sql: string, params: any[]}}
 */
function buildHistoryQuery(params) {
  const { keyword = '', authorKeyword = '', date = '' } = params;

  let sql = 'SELECT * FROM history WHERE 1=1';
  const sqlParams = [];

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
    const { keyword = '', authorKeyword = '', date = '', page = 1, pageSize = 20 } = req.query;
    const pageNum = parseInt(page, 10);
    const pageSizeNum = parseInt(pageSize, 10);
    const offset = (pageNum - 1) * pageSizeNum;

    // 构建查询
    const { sql, params } = buildHistoryQuery({ keyword, authorKeyword, date });

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

// 手动同步历史记录
app.post('/api/history/sync', async (req, res) => {
  try {
    const result = await syncHistory();
    res.json({
      success: true,
      message: `同步成功，新增 ${result.newCount} 条记录，更新 ${result.updateCount} 条记录`
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

    // 从 cookie 中提取 bili_jct
    const cookieStr = config.bilibili.cookie;
    const biliJctMatch = cookieStr.match(/bili_jct=([^;]+)/);
    if (!biliJctMatch) {
      throw new Error('未找到 bili_jct，请检查 cookie 配置');
    }
    const biliJct = biliJctMatch[1];

    // 调用 B站 API 删除远程内容
    const kid = `${item.business}_${id}`;
    const response = await fetch('https://api.bilibili.com/x/v2/history/delete', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': config.bilibili.cookie
      },
      body: new URLSearchParams({
        'kid': kid,
        'csrf': biliJct
      })
    });

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(data.message || '删除远程内容失败');
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
