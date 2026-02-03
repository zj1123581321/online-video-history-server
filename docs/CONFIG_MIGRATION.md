# 配置迁移指南

## v1.x -> v2.0 配置变更

### 同步间隔单位变更

所有 `syncInterval` 配置单位从**毫秒**改为**分钟**。

#### 转换公式

```
新值（分钟） = 旧值（毫秒） / 60000
```

#### 示例

| 旧配置（毫秒） | 新配置（分钟） | 含义 |
|---------------|---------------|------|
| 3600000 | 60 | 1 小时 |
| 43200000 | 720 | 12 小时 |
| 28800000 | 480 | 8 小时 |

### Bilibili 配置位置变更

Bilibili 的 `syncInterval` 从 `server` 移到 `providers.bilibili`。

#### 旧配置

```json
{
  "server": {
    "port": 3000,
    "syncInterval": 3600000
  },
  "providers": {
    "bilibili": {
      "enabled": true,
      "cookie": "..."
    }
  }
}
```

#### 新配置

```json
{
  "server": {
    "port": 3000
  },
  "providers": {
    "bilibili": {
      "enabled": true,
      "syncInterval": 60,
      "cookie": "..."
    }
  }
}
```

### 各 Provider syncInterval 变更对照

| Provider | 原配置位置 | 原值(ms) | 新配置位置 | 新值(min) |
|----------|------------|----------|------------|-----------|
| Bilibili | `server.syncInterval` | 3600000 | `providers.bilibili.syncInterval` | 60 |
| YouTube | `providers.youtube.syncInterval` | 43200000 | 同上 | 720 |
| YouTube-CDP | `providers.youtube-cdp.syncInterval` | 28800000 | 同上 | 480 |
| 小宇宙 | `providers.xiaoyuzhou.syncInterval` | 3600000 | 同上 | 60 |

### 迁移步骤

1. **打开** `config.json`
2. **移除** `server.syncInterval` 配置项
3. **在各 Provider 中** 将 `syncInterval` 的毫秒值转换为分钟值：
   - `3600000` -> `60`
   - `43200000` -> `720`
   - `28800000` -> `480`
4. **为 Bilibili 添加** `syncInterval` 配置（如需自定义间隔）
5. **重启服务**

### API 变更

#### /api/set-sync-interval

**旧版本**：接收毫秒值
```json
{ "interval": 3600000 }
```

**新版本**：接收分钟值
```json
{ "interval": 60 }
```

#### /api/get-sync-interval

**旧版本**：返回毫秒值
```json
{ "interval": 3600000 }
```

**新版本**：返回分钟值
```json
{ "interval": 60 }
```

### 完整配置示例

```json
{
  "server": {
    "port": 3000,
    "timezone": 8
  },
  "providers": {
    "bilibili": {
      "enabled": true,
      "syncInterval": 60,
      "cookie": "SESSDATA=xxx; bili_jct=xxx"
    },
    "youtube": {
      "enabled": false,
      "syncInterval": 720,
      "firstSyncCount": 100
    },
    "youtube-cdp": {
      "enabled": false,
      "syncInterval": 480,
      "timezoneOffset": 8,
      "cdp": {
        "host": "localhost",
        "port": 9222,
        "maxScrolls": 15,
        "scrollInterval": 3000,
        "targetLoadCount": 50
      }
    },
    "xiaoyuzhou": {
      "enabled": false,
      "accessToken": "your-access-token-here",
      "refreshToken": "your-refresh-token-here",
      "deviceId": "your-device-id-here",
      "syncInterval": 60,
      "pageSize": 25,
      "maxPages": 20
    }
  }
}
```
