import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, renameSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '../../data/history.db');
const JSON_PATH = join(__dirname, '../../data/history.json');

// 创建数据库连接
const db = new Database(DB_PATH);

// 启用 WAL 模式提升性能
db.pragma('journal_mode = WAL');

/**
 * 初始化数据库表结构和索引
 */
function initSchema() {
  // 检查是否需要迁移（id 从 INTEGER 改为 TEXT）
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history'").get();

  if (tableExists) {
    const columns = db.prepare("PRAGMA table_info(history)").all();
    const idCol = columns.find(col => col.name === 'id');

    // 如果 id 是 INTEGER 类型，需要迁移
    if (idCol && idCol.type === 'INTEGER') {
      console.log('[DB] 检测到旧表结构（id 为 INTEGER），开始迁移...');
      migrateIdToText();
    }
  }

  // 创建新表结构（如果不存在）
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'bilibili',
      business TEXT,
      bvid TEXT,
      cid INTEGER,
      title TEXT,
      tag_name TEXT,
      cover TEXT,
      view_time INTEGER,
      uri TEXT,
      author_name TEXT,
      author_mid INTEGER,
      timestamp INTEGER,
      PRIMARY KEY (id, platform)
    );

    CREATE INDEX IF NOT EXISTS idx_view_time ON history(view_time DESC);
    CREATE INDEX IF NOT EXISTS idx_platform ON history(platform);
    CREATE INDEX IF NOT EXISTS idx_title ON history(title);
    CREATE INDEX IF NOT EXISTS idx_author ON history(author_name);
  `);
}

/**
 * 迁移数据库：将 id 从 INTEGER 改为 TEXT
 */
function migrateIdToText() {
  db.exec(`
    -- 重命名旧表
    ALTER TABLE history RENAME TO history_old;

    -- 创建新表
    CREATE TABLE history (
      id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'bilibili',
      business TEXT,
      bvid TEXT,
      cid INTEGER,
      title TEXT,
      tag_name TEXT,
      cover TEXT,
      view_time INTEGER,
      uri TEXT,
      author_name TEXT,
      author_mid INTEGER,
      timestamp INTEGER,
      PRIMARY KEY (id, platform)
    );

    -- 复制数据，将 id 转为 TEXT
    INSERT INTO history SELECT
      CAST(id AS TEXT),
      COALESCE(platform, 'bilibili'),
      business, bvid, cid, title, tag_name, cover,
      view_time, uri, author_name, author_mid, timestamp
    FROM history_old;

    -- 删除旧表
    DROP TABLE history_old;

    -- 重建索引
    CREATE INDEX IF NOT EXISTS idx_view_time ON history(view_time DESC);
    CREATE INDEX IF NOT EXISTS idx_platform ON history(platform);
    CREATE INDEX IF NOT EXISTS idx_title ON history(title);
    CREATE INDEX IF NOT EXISTS idx_author ON history(author_name);
  `);

  console.log('[DB] 表结构迁移完成：id 已从 INTEGER 改为 TEXT');
}

/**
 * 从旧的 JSON 文件迁移数据到 SQLite
 * @returns {number} 迁移的记录数
 */
function migrateFromJson() {
  if (!existsSync(JSON_PATH)) {
    return 0;
  }

  // 检查数据库是否已有数据
  const count = db.prepare('SELECT COUNT(*) as count FROM history').get();
  if (count.count > 0) {
    console.log('数据库已有数据，跳过迁移');
    return 0;
  }

  console.log('检测到旧的 JSON 数据文件，开始迁移...');

  try {
    const jsonData = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));

    if (!Array.isArray(jsonData) || jsonData.length === 0) {
      console.log('JSON 文件为空或格式不正确，跳过迁移');
      return 0;
    }

    // 使用事务批量插入
    const insert = db.prepare(`
      INSERT OR REPLACE INTO history
      (id, platform, business, bvid, cid, title, tag_name, cover, view_time, uri, author_name, author_mid, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items) => {
      for (const item of items) {
        insert.run(
          item.id,
          'bilibili',
          item.business || '',
          item.bvid || '',
          item.cid || 0,
          item.title || '',
          item.tag_name || '',
          item.cover || '',
          item.viewTime || 0,
          item.uri || '',
          item.author_name || '',
          item.author_mid || 0,
          item.timestamp || Date.now()
        );
      }
    });

    insertMany(jsonData);

    // 备份旧的 JSON 文件
    const backupPath = JSON_PATH + '.bak';
    renameSync(JSON_PATH, backupPath);
    console.log(`迁移完成，共迁移 ${jsonData.length} 条记录`);
    console.log(`原 JSON 文件已备份为: ${backupPath}`);

    return jsonData.length;
  } catch (error) {
    console.error('迁移失败:', error);
    return 0;
  }
}

/**
 * 初始化数据库（创建表 + 迁移数据）
 */
export function initDatabase() {
  migrateFromJson();
  console.log('数据库初始化完成');
}

// 模块加载时立即创建表结构，确保其他模块导入 db 时表已存在
initSchema();

export default db;
