/**
 * 日志模块 - 类似 Python loguru 风格
 *
 * 特性：
 * - 时间戳：YYYY-MM-DD HH:mm:ss.SSS
 * - 日志级别：DEBUG, INFO, WARN, ERROR
 * - 代码位置：自动捕获文件名和行号
 * - 控制台输出：带颜色
 * - 文件输出：按日期轮转，保留指定天数
 * - 错误日志：单独写入 error.log
 *
 * 配置优先级：环境变量 > config.json > 默认值
 *
 * 环境变量：
 * - LOG_LEVEL: 日志级别 (debug/info/warn/error)，默认 info
 * - LOG_TO_FILE: 是否写入文件 (true/false)，默认 true
 * - LOG_MAX_DAYS: 日志保留天数，默认 7
 *
 * config.json 配置项：
 * - logger.level: 日志级别
 * - logger.file: 是否写入文件
 * - logger.maxDays: 日志保留天数
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// 获取当前文件路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日志目录
const LOG_DIR = path.join(process.cwd(), 'data', 'logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * 读取配置文件中的日志配置
 * @returns {object} 日志配置
 */
function loadLoggerConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.logger || {};
    }
  } catch {
    // 配置文件读取失败，使用默认值
  }
  return {};
}

// 读取配置（环境变量优先级高于配置文件）
const fileConfig = loadLoggerConfig();

const LOG_LEVEL = (
  process.env.LOG_LEVEL ||
  fileConfig.level ||
  'info'
).toLowerCase();

const LOG_TO_FILE = process.env.LOG_TO_FILE !== undefined
  ? process.env.LOG_TO_FILE !== 'false'
  : fileConfig.file !== false;

const LOG_MAX_DAYS = parseInt(process.env.LOG_MAX_DAYS, 10) ||
  fileConfig.maxDays ||
  7;

// 日志级别颜色映射
const LEVEL_COLORS = {
  error: '\x1b[31m',   // 红色
  warn: '\x1b[33m',    // 黄色
  info: '\x1b[32m',    // 绿色
  debug: '\x1b[36m',   // 青色
};
const RESET_COLOR = '\x1b[0m';

/**
 * 从调用栈中提取代码位置
 * @returns {string} 文件名:行号
 */
function getCallerLocation() {
  const err = new Error();
  const stack = err.stack.split('\n');

  // 跳过 Error、getCallerLocation、log 方法，找到实际调用者
  for (let i = 3; i < stack.length; i++) {
    const line = stack[i];

    // 跳过 winston 内部调用和 logger.js 自身
    if (line.includes('node_modules') ||
        line.includes('logger.js') ||
        line.includes('DerivedLogger')) {
      continue;
    }

    // 匹配文件路径和行号
    // Windows: at functionName (C:\path\file.js:123:45) 或 file:///C:/path/file.js:123:45
    // Unix: at functionName (/path/file.js:123:45) 或 file:///path/file.js:123:45
    const match = line.match(/at\s+(?:.*?\s+)?\(?(?:file:\/\/\/)?(.+?):(\d+):\d+\)?/);
    if (match) {
      const filePath = match[1];
      const lineNumber = match[2];
      const fileName = path.basename(filePath);
      return `${fileName}:${lineNumber}`;
    }
  }

  return 'unknown:0';
}

/**
 * 格式化时间戳
 * @param {Date} date
 * @returns {string} YYYY-MM-DD HH:mm:ss.SSS
 */
function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * 自定义日志格式（控制台，带颜色）
 */
const consoleFormat = winston.format.printf((info) => {
  const timestamp = formatTimestamp();
  const level = info.level.toUpperCase().padEnd(5);
  const location = (info.location || 'unknown:0').padEnd(25);
  const color = LEVEL_COLORS[info.level] || '';

  // 处理错误对象
  let message = info.message;
  if (info.error instanceof Error) {
    message += `\n${info.error.stack}`;
  }

  return `${timestamp} | ${color}${level}${RESET_COLOR} | ${location} | ${message}`;
});

/**
 * 自定义日志格式（文件，无颜色）
 */
const fileFormat = winston.format.printf((info) => {
  const timestamp = formatTimestamp();
  const level = info.level.toUpperCase().padEnd(5);
  const location = (info.location || 'unknown:0').padEnd(25);

  // 处理错误对象
  let message = info.message;
  if (info.error instanceof Error) {
    message += `\n${info.error.stack}`;
  }

  return `${timestamp} | ${level} | ${location} | ${message}`;
});

// 创建 transports
const transports = [];

// 控制台输出
transports.push(
  new winston.transports.Console({
    format: winston.format.combine(consoleFormat),
  })
);

// 文件输出
if (LOG_TO_FILE) {
  // 全量日志文件（按日期轮转）
  transports.push(
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: `${LOG_MAX_DAYS}d`,
      format: winston.format.combine(fileFormat),
    })
  );

  // 错误日志文件（单独记录）
  transports.push(
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: `${LOG_MAX_DAYS}d`,
      level: 'error',
      format: winston.format.combine(fileFormat),
    })
  );
}

// 创建 winston logger 实例
const winstonLogger = winston.createLogger({
  level: LOG_LEVEL,
  transports,
});

/**
 * 日志包装器 - 自动添加代码位置
 */
const logger = {
  /**
   * 调试日志
   * @param {string} message 日志消息
   * @param {Error} [error] 可选的错误对象
   */
  debug(message, error) {
    const location = getCallerLocation();
    winstonLogger.debug(message, { location, error });
  },

  /**
   * 信息日志
   * @param {string} message 日志消息
   * @param {Error} [error] 可选的错误对象
   */
  info(message, error) {
    const location = getCallerLocation();
    winstonLogger.info(message, { location, error });
  },

  /**
   * 警告日志
   * @param {string} message 日志消息
   * @param {Error} [error] 可选的错误对象
   */
  warn(message, error) {
    const location = getCallerLocation();
    winstonLogger.warn(message, { location, error });
  },

  /**
   * 错误日志
   * @param {string} message 日志消息
   * @param {Error} [error] 可选的错误对象
   */
  error(message, error) {
    const location = getCallerLocation();
    winstonLogger.error(message, { location, error });
  },

  /**
   * 通用日志方法
   * @param {string} level 日志级别
   * @param {string} message 日志消息
   * @param {Error} [error] 可选的错误对象
   */
  log(level, message, error) {
    const location = getCallerLocation();
    winstonLogger.log(level, message, { location, error });
  },
};

export default logger;
