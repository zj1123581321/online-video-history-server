import fetch from 'node-fetch';
import logger from '../utils/logger.js';

/**
 * 企业微信 Webhook 通知服务模块
 * 用于发送服务器启动、停止和同步失败等事件通知
 */

// 模块配置
let notificationConfig = null;
let timezone = 8; // 默认 UTC+8

/**
 * 初始化通知服务
 * @param {object} config - 通知配置对象
 * @param {number} [tz=8] - 时区偏移量
 */
export function initNotificationService(config, tz = 8) {
  notificationConfig = config;
  timezone = tz;

  if (config?.enabled) {
    logger.info('[Notification] 通知服务已启用');
  } else {
    logger.info('[Notification] 通知服务未启用');
  }
}

/**
 * 检查通知服务是否可用
 * @param {string} eventType - 事件类型
 * @returns {boolean}
 */
function isNotificationEnabled(eventType) {
  if (!notificationConfig?.enabled) {
    return false;
  }

  if (!notificationConfig?.wecom?.webhookUrl) {
    return false;
  }

  // 检查事件是否启用
  const events = notificationConfig.events || {};
  return events[eventType] !== false; // 默认启用
}

/**
 * 获取当前时间字符串（配置时区）
 * @returns {string}
 */
function getCurrentTimeString() {
  const now = new Date();
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
  const tzTime = new Date(utcTime + timezone * 3600000);

  const year = tzTime.getFullYear();
  const month = String(tzTime.getMonth() + 1).padStart(2, '0');
  const day = String(tzTime.getDate()).padStart(2, '0');
  const hours = String(tzTime.getHours()).padStart(2, '0');
  const minutes = String(tzTime.getMinutes()).padStart(2, '0');
  const seconds = String(tzTime.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 发送企业微信 Webhook 消息
 * @param {string} content - Markdown 格式的消息内容
 * @returns {Promise<void>}
 */
async function sendWecomMessage(content) {
  const webhookUrl = notificationConfig?.wecom?.webhookUrl;

  if (!webhookUrl) {
    logger.warn('[Notification] 未配置 webhook URL');
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          content,
        },
      }),
    });

    const result = await response.json();

    if (result.errcode !== 0) {
      logger.warn(`[Notification] 发送通知失败: ${result.errmsg}`);
    } else {
      logger.debug('[Notification] 通知发送成功');
    }
  } catch (error) {
    logger.warn(`[Notification] 发送通知时出错: ${error.message}`);
  }
}

/**
 * 格式化同步间隔为可读字符串
 * @param {number} minutes - 分钟数
 * @returns {string}
 */
function formatInterval(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60} 小时`;
  }
  return `${minutes} 分钟`;
}

/**
 * 发送服务器启动通知
 * @param {object} params - 参数
 * @param {number} params.port - 服务器端口
 * @param {string[]} params.enabledProviders - 已启用的平台列表
 * @param {object} [params.syncIntervals] - 各平台同步间隔（分钟）
 * @returns {Promise<void>}
 */
export async function notifyServerStart({ port, enabledProviders, syncIntervals = {} }) {
  if (!isNotificationEnabled('serverStart')) {
    return;
  }

  const providersText = enabledProviders.length > 0
    ? enabledProviders.join(', ')
    : '无';

  // 构建同步间隔信息
  let intervalsText = '';
  if (Object.keys(syncIntervals).length > 0) {
    const intervalLines = Object.entries(syncIntervals)
      .map(([provider, minutes]) => `>    - ${provider}: ${formatInterval(minutes)}`)
      .join('\n');
    intervalsText = `\n> **同步间隔**:\n${intervalLines}`;
  }

  const content = `### 历史记录同步服务启动
> **状态**: <font color="info">启动成功</font>
> **端口**: ${port}
> **已启用平台**: ${providersText}${intervalsText}
> **时间**: ${getCurrentTimeString()}`;

  await sendWecomMessage(content).catch(() => {});
}

/**
 * 发送服务器停止通知
 * @param {object} params - 参数
 * @param {string} params.signal - 触发停止的信号
 * @returns {Promise<void>}
 */
export async function notifyServerStop({ signal }) {
  if (!isNotificationEnabled('serverStop')) {
    return;
  }

  const content = `### 历史记录同步服务停止
> **状态**: <font color="warning">服务停止</font>
> **信号**: ${signal}
> **时间**: ${getCurrentTimeString()}`;

  await sendWecomMessage(content).catch(() => {});
}

/**
 * 发送同步成功通知（仅在有新增记录时）
 * @param {object} params - 参数
 * @param {string} params.platform - 平台名称
 * @param {number} params.newCount - 新增记录数
 * @param {number} params.updateCount - 更新记录数
 * @returns {Promise<void>}
 */
export async function notifySyncSuccess({ platform, newCount, updateCount }) {
  // 无新增记录则不通知
  if (newCount <= 0) {
    return;
  }

  if (!isNotificationEnabled('syncSuccess')) {
    return;
  }

  const content = `### 同步完成通知
> **平台**: <font color="info">${platform}</font>
> **新增**: ${newCount} 条
> **更新**: ${updateCount} 条
> **时间**: ${getCurrentTimeString()}`;

  await sendWecomMessage(content).catch(() => {});
}

/**
 * 发送同步失败通知
 * @param {object} params - 参数
 * @param {string} params.platform - 平台名称
 * @param {string} params.error - 错误信息
 * @param {string} [params.syncType='自动同步'] - 同步类型
 * @returns {Promise<void>}
 */
export async function notifySyncError({ platform, error, syncType = '自动同步' }) {
  if (!isNotificationEnabled('syncError')) {
    return;
  }

  const content = `### 同步失败告警 <@all>
> **平台**: <font color="warning">${platform}</font>
> **类型**: ${syncType}
> **错误**: ${error}
> **时间**: ${getCurrentTimeString()}`;

  await sendWecomMessage(content).catch(() => {});
}
