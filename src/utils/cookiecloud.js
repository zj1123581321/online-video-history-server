/**
 * CookieCloud 客户端
 *
 * 负责从 CookieCloud 服务获取和解密 cookie 数据
 */

import crypto from 'crypto';
import https from 'https';
import fetch from 'node-fetch';
import EVP_BytesToKey from 'evp_bytestokey';

// 创建忽略 SSL 证书验证的 agent
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * CookieCloud 客户端类
 */
export class CookieCloudClient {
  /**
   * @param {object} config - CookieCloud 配置
   * @param {string} config.url - CookieCloud 服务地址
   * @param {string} config.uuid - UUID
   * @param {string} config.password - 解密密码
   */
  constructor(config) {
    this.url = config.url?.replace(/\/$/, '') || '';
    this.uuid = config.uuid || '';
    this.password = config.password || '';
  }

  /**
   * 生成解密密钥
   * @returns {string} MD5(uuid + "-" + password) 的前 16 个字符
   */
  _generateKey() {
    const combined = `${this.uuid}-${this.password}`;
    const hash = crypto.createHash('md5').update(combined).digest('hex');
    return hash.substring(0, 16);
  }

  /**
   * 解密 CookieCloud 数据
   * @param {string} encrypted - Base64 编码的加密数据
   * @returns {object} 解密后的 JSON 对象
   */
  _decrypt(encrypted) {
    const password = this._generateKey();

    // Base64 解码
    const encryptedBuffer = Buffer.from(encrypted, 'base64');

    // 检查 "Salted__" 前缀 (8 字节)
    const prefix = encryptedBuffer.slice(0, 8).toString('utf8');
    if (prefix !== 'Salted__') {
      throw new Error('加密数据格式错误：缺少 Salted__ 前缀');
    }

    // 提取盐值 (字节 8-16)
    const salt = encryptedBuffer.slice(8, 16);

    // 提取密文
    const ciphertext = encryptedBuffer.slice(16);

    // 使用 EVP_BytesToKey 派生密钥和 IV
    // CryptoJS 默认使用 AES-256-CBC，需要 256 位(32字节)密钥和 16 字节 IV
    // 注意：第三个参数是 keyBits（位），不是字节
    const derived = EVP_BytesToKey(password, salt, 256, 16);

    // AES-256-CBC 解密
    const decipher = crypto.createDecipheriv('aes-256-cbc', derived.key, derived.iv);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // 解析 JSON
    return JSON.parse(decrypted.toString('utf8'));
  }

  /**
   * 从 CookieCloud 获取数据
   * @returns {Promise<object>} 包含 cookie_data 和 local_storage_data
   */
  async fetchData() {
    if (!this.url || !this.uuid || !this.password) {
      throw new Error('CookieCloud 配置不完整');
    }

    const apiUrl = `${this.url}/get/${this.uuid}`;
    console.log(`[CookieCloud] 正在从 ${this.url} 获取数据...`);

    // 使用忽略 SSL 验证的 agent（支持自签名证书）
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      agent: apiUrl.startsWith('https') ? httpsAgent : undefined,
      timeout: 10000,
    });

    if (!response.ok) {
      throw new Error(`CookieCloud 请求失败: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.encrypted) {
      throw new Error('CookieCloud 返回数据为空或格式错误');
    }

    // 解密数据
    const decrypted = this._decrypt(data.encrypted);
    console.log(`[CookieCloud] 获取成功，包含 ${Object.keys(decrypted.cookie_data || {}).length} 个域名的 cookie`);

    return decrypted;
  }

  /**
   * 获取指定域名的 cookie
   * @param {string} domain - 目标域名，如 ".bilibili.com"
   * @returns {Promise<object>} 包含 cookie 字符串和过期时间信息
   */
  async getCookiesForDomain(domain) {
    const data = await this.fetchData();
    const cookieData = data.cookie_data || {};

    // 查找匹配的域名
    const cookies = this._findDomainCookies(cookieData, domain);

    if (!cookies || cookies.length === 0) {
      const availableDomains = Object.keys(cookieData);
      throw new Error(`未找到域名 "${domain}" 的 cookie，可用域名: ${availableDomains.join(', ')}`);
    }

    console.log(`[CookieCloud] 找到 ${cookies.length} 个匹配的 cookie`);

    // 构建 cookie 字符串
    const cookieString = this._buildCookieString(cookies);

    // 获取最早的过期时间
    const expires = this._getEarliestExpiration(cookies);

    return {
      cookie: cookieString,
      expires,
      count: cookies.length,
    };
  }

  /**
   * 查找匹配域名的 cookie
   * @param {object} cookieData - CookieCloud 返回的 cookie 数据
   * @param {string} targetDomain - 目标域名
   * @returns {Array} cookie 数组
   */
  _findDomainCookies(cookieData, targetDomain) {
    // 1. 精确匹配
    if (cookieData[targetDomain]) {
      console.log(`[CookieCloud] 精确匹配域名: ${targetDomain}`);
      return cookieData[targetDomain];
    }

    // 2. 尝试变体匹配（带/不带前导点）
    let variant;
    if (targetDomain.startsWith('.')) {
      variant = targetDomain.substring(1);
    } else {
      variant = '.' + targetDomain;
    }

    if (cookieData[variant]) {
      console.log(`[CookieCloud] 变体匹配域名: ${variant}`);
      return cookieData[variant];
    }

    // 3. 尝试子域名匹配
    for (const domain of Object.keys(cookieData)) {
      if (domain.endsWith(targetDomain) || targetDomain.endsWith(domain)) {
        console.log(`[CookieCloud] 子域名匹配: ${domain}`);
        return cookieData[domain];
      }
    }

    return null;
  }

  /**
   * 构建 cookie 字符串
   * @param {Array} cookies - cookie 数组
   * @returns {string} cookie 字符串，格式如 "name1=value1; name2=value2"
   */
  _buildCookieString(cookies) {
    const parts = [];

    for (const cookie of cookies) {
      if (cookie.name && cookie.value) {
        parts.push(`${cookie.name}=${cookie.value}`);
      }
    }

    return parts.join('; ');
  }

  /**
   * 获取最早的 cookie 过期时间
   * @param {Array} cookies - cookie 数组
   * @returns {number|null} 过期时间戳（秒），如果都没有过期时间则返回 null
   */
  _getEarliestExpiration(cookies) {
    let earliest = null;

    for (const cookie of cookies) {
      // 检查各种可能的过期时间字段
      const exp = cookie.expirationDate || cookie.expires || cookie.expiry;

      if (exp && typeof exp === 'number') {
        if (earliest === null || exp < earliest) {
          earliest = exp;
        }
      }
    }

    return earliest;
  }
}

export default CookieCloudClient;
