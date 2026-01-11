/**
 * Provider 基类
 * 所有平台的历史记录提供者都应该继承此类
 */
export class BaseProvider {
  /**
   * @param {object} config - 平台配置
   */
  constructor(config) {
    this.platform = 'unknown';
    this.config = config;
    this.enabled = config?.enabled ?? false;
  }

  /**
   * 获取平台名称
   * @returns {string}
   */
  getPlatform() {
    return this.platform;
  }

  /**
   * 检查是否启用
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * 同步历史记录
   * @returns {Promise<{newCount: number, updateCount: number}>}
   */
  async sync() {
    throw new Error(`${this.platform}: sync() not implemented`);
  }

  /**
   * 删除远程历史记录
   * @param {object} item - 历史记录项
   * @returns {Promise<boolean>}
   */
  async deleteRemote(item) {
    throw new Error(`${this.platform}: deleteRemote() not implemented`);
  }

  /**
   * 将原始数据标准化为统一格式
   * @param {object} rawItem - 原始数据
   * @returns {object} 标准化后的数据
   */
  normalizeItem(rawItem) {
    throw new Error(`${this.platform}: normalizeItem() not implemented`);
  }

  /**
   * 验证配置是否有效
   * @returns {boolean}
   */
  validateConfig() {
    return this.enabled;
  }
}

export default BaseProvider;
