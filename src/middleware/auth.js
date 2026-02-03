/**
 * 认证中间件模块
 * 提供简单的密码认证功能，支持失败次数限制和 IP 锁定
 */

import logger from '../utils/logger.js';

// 存储每个 IP 的失败尝试记录
// 格式: { ip: { attempts: number, lockedUntil: number | null } }
const attemptRecords = new Map();

/**
 * 获取客户端 IP 地址
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

/**
 * 获取或创建 IP 的尝试记录
 * @param {string} ip
 * @returns {{ attempts: number, lockedUntil: number | null }}
 */
function getAttemptRecord(ip) {
  if (!attemptRecords.has(ip)) {
    attemptRecords.set(ip, { attempts: 0, lockedUntil: null });
  }
  return attemptRecords.get(ip);
}

/**
 * 检查 IP 是否被锁定
 * @param {string} ip
 * @returns {{ locked: boolean, remainingTime: number }}
 */
function checkLockStatus(ip) {
  const record = getAttemptRecord(ip);
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    return {
      locked: true,
      remainingTime: record.lockedUntil - Date.now()
    };
  }
  // 锁定已过期，重置状态
  if (record.lockedUntil) {
    record.attempts = 0;
    record.lockedUntil = null;
  }
  return { locked: false, remainingTime: 0 };
}

/**
 * 记录失败尝试
 * @param {string} ip
 * @param {number} maxAttempts
 * @param {number} lockoutDuration
 * @returns {{ locked: boolean, remainingAttempts: number, lockoutDuration: number }}
 */
function recordFailedAttempt(ip, maxAttempts, lockoutDuration) {
  const record = getAttemptRecord(ip);
  record.attempts++;

  if (record.attempts >= maxAttempts) {
    record.lockedUntil = Date.now() + lockoutDuration;
    logger.warn(`[Auth] IP ${ip} 已被锁定，锁定时长: ${lockoutDuration / 1000}秒`);
    return {
      locked: true,
      remainingAttempts: 0,
      lockoutDuration
    };
  }

  return {
    locked: false,
    remainingAttempts: maxAttempts - record.attempts,
    lockoutDuration: 0
  };
}

/**
 * 重置 IP 的尝试记录（登录成功时调用）
 * @param {string} ip
 */
function resetAttempts(ip) {
  attemptRecords.delete(ip);
}

/**
 * 创建认证中间件
 * @param {object} authConfig 认证配置
 * @param {string} authConfig.password 密码
 * @param {number} authConfig.maxAttempts 最大尝试次数
 * @param {number} authConfig.lockoutDuration 锁定时长（毫秒）
 * @param {string[]} whitelist 白名单路径
 * @returns {import('express').RequestHandler}
 */
export function createAuthMiddleware(authConfig, whitelist = []) {
  const { password, maxAttempts = 5, lockoutDuration = 300000 } = authConfig || {};

  // 密码为空则不启用认证
  if (!password) {
    logger.info('[Auth] 未配置密码，认证功能已禁用');
    return (req, res, next) => next();
  }

  logger.info('[Auth] 认证功能已启用');

  return (req, res, next) => {
    // 检查白名单
    const isWhitelisted = whitelist.some(path => {
      if (path.endsWith('*')) {
        return req.path.startsWith(path.slice(0, -1));
      }
      return req.path === path;
    });

    if (isWhitelisted) {
      return next();
    }

    // 检查认证 token
    const token = req.headers['x-auth-token'];

    if (token === password) {
      return next();
    }

    // 认证失败
    res.status(401).json({
      error: '未授权访问',
      code: 'UNAUTHORIZED'
    });
  };
}

/**
 * 创建认证相关的 API 路由
 * @param {import('express').Router} router
 * @param {object} authConfig
 */
export function setupAuthRoutes(router, authConfig) {
  const { password, maxAttempts = 5, lockoutDuration = 300000 } = authConfig || {};

  /**
   * 获取认证状态
   * GET /api/auth/status
   */
  router.get('/api/auth/status', (req, res) => {
    const ip = getClientIp(req);
    const lockStatus = checkLockStatus(ip);
    const record = getAttemptRecord(ip);

    res.json({
      // 是否需要认证（密码非空则需要）
      required: !!password,
      // 是否被锁定
      locked: lockStatus.locked,
      // 锁定剩余时间（毫秒）
      lockoutRemaining: lockStatus.remainingTime,
      // 剩余尝试次数
      remainingAttempts: lockStatus.locked ? 0 : maxAttempts - record.attempts
    });
  });

  /**
   * 验证密码
   * POST /api/auth/verify
   */
  router.post('/api/auth/verify', (req, res) => {
    const ip = getClientIp(req);
    const { password: inputPassword } = req.body || {};

    // 检查是否被锁定
    const lockStatus = checkLockStatus(ip);
    if (lockStatus.locked) {
      logger.warn(`[Auth] IP ${ip} 尝试登录但处于锁定状态`);
      return res.status(429).json({
        success: false,
        error: '尝试次数过多，请稍后再试',
        code: 'LOCKED',
        lockoutRemaining: lockStatus.remainingTime
      });
    }

    // 未配置密码，直接成功
    if (!password) {
      return res.json({
        success: true,
        message: '认证成功'
      });
    }

    // 验证密码
    if (inputPassword === password) {
      resetAttempts(ip);
      logger.info(`[Auth] IP ${ip} 认证成功`);
      return res.json({
        success: true,
        message: '认证成功'
      });
    }

    // 密码错误，记录失败
    const attemptResult = recordFailedAttempt(ip, maxAttempts, lockoutDuration);
    logger.warn(`[Auth] IP ${ip} 认证失败，剩余尝试次数: ${attemptResult.remainingAttempts}`);

    if (attemptResult.locked) {
      return res.status(429).json({
        success: false,
        error: '尝试次数过多，请稍后再试',
        code: 'LOCKED',
        lockoutRemaining: attemptResult.lockoutDuration
      });
    }

    return res.status(401).json({
      success: false,
      error: '密码错误',
      code: 'INVALID_PASSWORD',
      remainingAttempts: attemptResult.remainingAttempts
    });
  });
}
