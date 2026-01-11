import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = JSON.parse(readFileSync(join(__dirname, '../../config.json'), 'utf-8'));

// 预编译 SQL 语句提升性能
const stmts = {
  getById: db.prepare('SELECT id, view_time FROM history WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO history
    (id, business, bvid, cid, title, tag_name, cover, view_time, uri, author_name, author_mid, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateViewTime: db.prepare('UPDATE history SET view_time = ?, timestamp = ? WHERE id = ?'),
};

/**
 * 从 B站 同步历史记录到本地数据库
 * @returns {Promise<{success: boolean, newCount: number, updateCount: number, message: string}>}
 */
export async function syncHistory() {
  try {
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
        const existing = stmts.getById.get(item.id);

        if (!existing) {
          // 新记录
          stmts.insert.run(
            item.id,
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
          // 更新观看时间
          stmts.updateViewTime.run(item.viewTime, item.timestamp, item.id);
          updateCount++;
        }
      }
    });

    while (hasMore) {
      const response = await fetch(
        `https://api.bilibili.com/x/web-interface/history/cursor?max=${max}&view_at=${view_at}&type=${type}&ps=${ps}`,
        {
          headers: {
            Cookie: config.bilibili.cookie,
          },
        }
      );

      if (!response.ok) {
        throw new Error('获取历史记录失败');
      }

      const data = await response.json();

      if (data.code !== 0) {
        throw new Error(data.message || '获取历史记录失败');
      }

      hasMore = data.data.list.length > 0;
      max = data.data.cursor.max;
      view_at = data.data.cursor.view_at;

      if (data.data.list.length > 0) {
        const prevNewCount = newCount;
        const prevUpdateCount = updateCount;

        // 转换数据格式
        const items = [];
        for (const item of data.data.list) {
          // 检查是否已经处理过这个 ID
          if (processedIds.has(item.history.oid)) {
            continue;
          }
          processedIds.add(item.history.oid);

          items.push({
            id: item.history.oid,
            business: item.history.business,
            bvid: item.history.bvid,
            cid: item.history.cid,
            title: item.title,
            tag_name: item.tag_name,
            cover: item.cover || (item.covers && item.covers[0]) || '',
            viewTime: item.view_at,
            uri: item.uri || '',
            author_name: item.author_name || '',
            author_mid: item.author_mid || 0,
            timestamp: Date.now(),
          });
        }

        // 批量插入/更新
        batchInsert(items);

        console.log(`同步了 ${data.data.list.length} 条历史记录`);

        // 如果这一批数据中没有任何新增或更新，且已经处理了足够多的记录，就退出循环
        const hasNewOrUpdated = newCount > prevNewCount || updateCount > prevUpdateCount;
        if (!hasNewOrUpdated && processedIds.size >= 100) {
          console.log('没有新的更新，同步结束');
          break;
        }

        // 添加延时，避免请求过于频繁
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return {
      success: true,
      newCount,
      updateCount,
      message: `成功同步 ${newCount} 条新记录，更新 ${updateCount} 条记录`
    };
  } catch (error) {
    console.error('同步历史记录失败:', error);
    throw error;
  }
}
