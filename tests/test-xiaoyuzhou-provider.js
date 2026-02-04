/**
 * 小宇宙 Provider 自动刷新机制测试
 *
 * 用法: node tests/test-xiaoyuzhou-provider.js [--no-access-token]
 *
 * --no-access-token: 模拟只配置 refreshToken 的场景
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取配置
const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// 动态导入 Provider（需要在项目上下文中运行）
const { XiaoyuzhouProvider } = await import('../src/providers/xiaoyuzhou.js');

// 测试模式
const NO_ACCESS_TOKEN = process.argv.includes('--no-access-token');

console.log('=== 小宇宙 Provider 自动刷新机制测试 ===\n');

// 准备测试配置
const testConfig = { ...config.providers.xiaoyuzhou };

if (NO_ACCESS_TOKEN) {
  console.log('【测试模式】移除 accessToken，只使用 refreshToken\n');
  delete testConfig.accessToken;

  // 同时清除 token 状态文件，模拟首次运行
  const tokenStateFile = path.join(__dirname, '..', 'data', 'xiaoyuzhou_tokens.json');
  if (fs.existsSync(tokenStateFile)) {
    fs.unlinkSync(tokenStateFile);
    console.log('已清除 Token 状态文件\n');
  }
}

console.log('配置信息:');
console.log(`  - accessToken: ${testConfig.accessToken ? '已配置' : '(未配置)'}`);
console.log(`  - refreshToken: ${testConfig.refreshToken ? '已配置' : '(未配置)'}`);
console.log(`  - deviceId: ${testConfig.deviceId || '(自动生成)'}`);
console.log('');

// 创建 Provider 实例
const provider = new XiaoyuzhouProvider(testConfig);

async function main() {
  try {
    console.log('--- 开始同步测试 ---\n');

    const result = await provider.sync();

    console.log('\n--- 同步结果 ---\n');
    console.log(`新增记录: ${result.newCount}`);
    console.log(`更新记录: ${result.updateCount}`);

    // 检查 token 状态文件
    const tokenStateFile = path.join(__dirname, '..', 'data', 'xiaoyuzhou_tokens.json');
    if (fs.existsSync(tokenStateFile)) {
      const tokenState = JSON.parse(fs.readFileSync(tokenStateFile, 'utf-8'));
      console.log('\n--- Token 状态文件 ---\n');
      console.log(`accessToken: ${tokenState.accessToken ? tokenState.accessToken.slice(0, 50) + '...' : '(无)'}`);
      console.log(`refreshToken: ${tokenState.refreshToken ? tokenState.refreshToken.slice(0, 50) + '...' : '(无)'}`);
      console.log(`deviceId: ${tokenState.deviceId}`);
      console.log(`updatedAt: ${tokenState.updatedAt}`);
    }

    console.log('\n=== 测试完成 ===');

  } catch (error) {
    console.error(`\n测试失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
