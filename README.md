# 视频历史记录服务器

一个轻量级的多平台视频观看历史记录管理系统，支持自动同步、搜索过滤、导入导出等功能。

目前支持的平台：
- **Bilibili**（已实现）
- **YouTube**（规划中）

本项目参考了 [bilibili-history-wxt](https://github.com/mundane799699/bilibili-history-wxt) 项目的部分实现。

## 文档

- [客户端接入指南](docs/API_CLIENT.md) - API 接口文档和多语言客户端示例

## 功能特点

- **多平台支持**：可扩展的 Provider 架构，支持多个视频平台
- **自动同步**：定时同步各平台观看历史记录，支持自定义同步间隔
- **手动同步**：支持手动触发同步操作
- **智能搜索**：支持按视频标题、UP主名称、日期、平台等多维度过滤
- **无限滚动**：前端支持滚动到底部自动加载更多内容
- **删除功能**：同时删除远程和本地历史记录
- **导入/导出**：支持历史记录 JSON 格式的导出和导入
- **图片代理**：解决跨域图片加载问题
- **数据本地存储**：使用 SQLite 数据库存储，查询性能优秀，方便备份和迁移

## 项目结构

```
bilibili-history-server/
├── src/                              # 后端源代码
│   ├── index.js                      # 主应用程序入口
│   ├── db/
│   │   └── index.js                  # 数据库初始化模块
│   ├── providers/                    # 平台 Provider 模块
│   │   ├── base.js                   # Provider 基类
│   │   └── bilibili.js               # Bilibili 实现
│   └── services/
│       └── history.js                # 历史记录服务（Provider 调度）
├── public/                           # 前端静态资源
│   └── index.html                    # 单页面应用
├── data/                             # 数据存储目录
│   └── history.db                    # SQLite 数据库文件（运行后生成）
├── config.json                       # 配置文件（需手动创建）
├── config-example.json               # 配置文件模板
├── package.json                      # 项目配置
└── README.md                         # 项目文档
```

## 技术栈

### 后端
- **Node.js** >= 14.0.0
- **Express** - Web 框架
- **better-sqlite3** - SQLite 数据库
- **node-fetch** - HTTP 请求库

### 前端
- **HTML5 / JavaScript (ES6+)**
- **Tailwind CSS** - 样式框架（CDN 引入）

## 系统要求

- Node.js >= 14.0.0
- npm >= 6.0.0

## 安装

1. 克隆项目
```bash
git clone https://github.com/haha2026/bilibili-history-server.git
cd bilibili-history-server
```

2. 安装依赖
```bash
npm install
```

3. 配置
复制 `config-example.json` 为 `config.json` 并修改配置：
```json
{
  "server": {
    "port": 3000,
    "syncInterval": 3600000
  },
  "auth": {
    "password": "your_password_here",
    "maxAttempts": 5,
    "lockoutDuration": 300000
  },
  "providers": {
    "bilibili": {
      "enabled": true,
      "cookie": "SESSDATA=your_sessdata_here; bili_jct=your_bili_jct_here"
    }
  }
}
```

### 配置说明

| 配置项 | 说明 |
|--------|------|
| `server.port` | 服务器端口，默认 3000 |
| `server.syncInterval` | 自动同步间隔（毫秒），默认 3600000（1小时） |
| `auth.password` | 访问密码，留空则不启用认证 |
| `auth.maxAttempts` | 最大尝试次数，默认 5 |
| `auth.lockoutDuration` | 锁定时长（毫秒），默认 300000（5分钟） |
| `providers.bilibili.enabled` | 是否启用 Bilibili 同步 |
| `providers.bilibili.cookie` | B站登录凭证，需包含 `SESSDATA` 和 `bili_jct` |

### 获取 Bilibili Cookie

**方式一：手动配置**

1. 登录 [B站](https://www.bilibili.com)
2. 打开浏览器开发者工具（F12）
3. 切换到 Application/存储 -> Cookies
4. 复制 `SESSDATA` 和 `bili_jct` 的值

**方式二：使用 CookieCloud 自动同步（推荐）**

如果你已经部署了 [CookieCloud](https://github.com/easychen/CookieCloud) 服务，可以配置自动同步 cookie：

```json
{
  "cookiecloud": {
    "enabled": true,
    "url": "https://your-cookiecloud-server.com",
    "uuid": "your-uuid-here",
    "password": "your-password-here",
    "platforms": {
      "bilibili": {
        "domain": ".bilibili.com"
      }
    }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `cookiecloud.enabled` | 是否启用 CookieCloud |
| `cookiecloud.url` | CookieCloud 服务地址 |
| `cookiecloud.uuid` | CookieCloud UUID |
| `cookiecloud.password` | CookieCloud 解密密码 |
| `cookiecloud.platforms.bilibili.domain` | Bilibili cookie 的域名，默认 `.bilibili.com` |

启用 CookieCloud 后：
- 系统会自动从云端获取最新的 cookie
- cookie 会缓存到本地 `data/cookie_cache.json`，根据过期时间自动刷新
- 如果 CookieCloud 不可用，会自动降级使用 `providers.bilibili.cookie` 静态配置

> **安全提示**：Cookie 包含敏感信息，请妥善保管，不要泄露或提交到公开仓库。

## 运行

开发模式（支持热重载）：
```bash
npm run dev
```

生产模式：
```bash
npm start
```

启动后访问 `http://localhost:3000` 即可使用。

## API 接口

### 获取历史记录
```
GET /api/history

参数：
- platform: 平台过滤（bilibili/youtube/all），默认 all
- keyword: 视频标题搜索关键词（可选）
- authorKeyword: UP主名称关键词（可选）
- date: 日期，YYYY-MM-DD 格式（可选）
- page: 页码，默认 1
- pageSize: 每页数量，默认 20

响应：
{
  "items": [...],     // 历史记录数组
  "total": 100,       // 总数
  "hasMore": true     // 是否有更多
}
```

### 获取已启用的平台
```
GET /api/platforms

响应：
{
  "platforms": ["bilibili"]
}
```

### 同步历史记录
```
POST /api/history/sync

请求体（可选）：
{ "platform": "bilibili" }  // 不传则同步所有已启用平台

响应：
{
  "success": true,
  "message": "同步成功，新增5条记录，更新2条记录",
  "details": {
    "bilibili": { "newCount": 5, "updateCount": 2 }
  }
}
```

### 删除历史记录
```
DELETE /api/history/:id

响应：
{
  "success": true,
  "message": "删除成功"
}
```

### 设置同步间隔
```
POST /api/set-sync-interval

请求体：
{ "interval": 3600000 }

响应：
{
  "message": "同步间隔已更新",
  "interval": 3600000
}
```

### 获取同步间隔
```
GET /api/get-sync-interval

响应：
{ "interval": 3600000 }
```

### 图片代理
```
GET /img-proxy?url=<encoded-url>

说明：用于代理图片，解决跨域问题
```

## 数据存储

历史记录存储在 SQLite 数据库 `data/history.db` 中，表结构如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 历史记录ID（主键） |
| `platform` | TEXT | 来源平台（bilibili/youtube） |
| `business` | TEXT | 内容类型 |
| `bvid` | TEXT | 视频ID |
| `cid` | INTEGER | 内容ID |
| `title` | TEXT | 视频标题 |
| `tag_name` | TEXT | 分类标签 |
| `cover` | TEXT | 封面图片URL |
| `view_time` | INTEGER | 观看时间（Unix时间戳） |
| `uri` | TEXT | 资源URI |
| `author_name` | TEXT | 作者名称 |
| `author_mid` | INTEGER | 作者ID |
| `timestamp` | INTEGER | 本地记录时间戳 |

### 支持的内容类型（Bilibili）

| 类型 | 说明 |
|------|------|
| `archive` | 普通视频 |
| `pgc` | 番剧/电影 |
| `article` | 专栏文章 |
| `article-list` | 文章列表 |
| `live` | 直播 |
| `cheese` | 课程 |

## 扩展新平台

项目采用 Provider 架构，扩展新平台只需：

1. 在 `src/providers/` 下创建新的 Provider 类，继承 `BaseProvider`
2. 实现 `sync()` 和 `deleteRemote()` 方法
3. 在 `src/services/history.js` 中注册新 Provider
4. 在配置文件中添加对应平台的配置

## 数据备份

建议定期备份 `data/history.db` 文件。也可以使用前端的导出功能将数据导出为 JSON 文件保存。

> **数据迁移**：如果从旧版本升级，启动时会自动将 `data/history.json` 中的数据迁移到 SQLite 数据库，并将原文件备份为 `history.json.bak`。

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

## 致谢

- [bilibili-history-wxt](https://github.com/mundane799699/bilibili-history-wxt) - 参考项目
