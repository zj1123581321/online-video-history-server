# 视频历史记录服务器

一个轻量级的多平台视频观看历史记录管理系统，支持自动同步、搜索过滤、导入导出等功能。

目前支持的平台：
- **Bilibili**（已实现）
- **YouTube**（已实现，需配合 yt-dlp）
- **YouTube-CDP**（实验性，基于 Chrome DevTools Protocol，支持精确时间解析）

本项目参考了 [bilibili-history-wxt](https://github.com/mundane799699/bilibili-history-wxt) 项目的部分实现。

## 文档

- [客户端接入指南](docs/API_CLIENT.md) - API 接口文档和多语言客户端示例

## 功能特点

- **多平台支持**：可扩展的 Provider 架构，支持 Bilibili 和 YouTube
- **自动同步**：定时同步各平台观看历史记录，支持自定义同步间隔
- **手动同步**：支持手动触发同步操作，可按平台选择
- **智能搜索**：支持按视频标题、UP主名称、日期、平台等多维度过滤
- **无限滚动**：前端支持滚动到底部自动加载更多内容
- **删除功能**：同时删除远程和本地历史记录（Bilibili 支持远程删除）
- **导入/导出**：支持历史记录 JSON 格式的导出和导入
- **图片代理**：解决跨域图片加载问题
- **数据本地存储**：使用 SQLite 数据库存储，查询性能优秀，方便备份和迁移
- **CookieCloud 集成**：支持从 CookieCloud 自动获取 Cookie，无需手动配置
- **认证保护**：可选的密码认证，支持失败次数限制和 IP 锁定
- **Docker 支持**：提供完整的 Dockerfile 和 docker-compose 配置

## 项目结构

```
bilibili-history-server/
├── src/                              # 后端源代码
│   ├── index.js                      # 主应用程序入口
│   ├── db/
│   │   └── index.js                  # 数据库初始化模块
│   ├── providers/                    # 平台 Provider 模块
│   │   ├── base.js                   # Provider 基类
│   │   ├── bilibili.js               # Bilibili 实现
│   │   └── youtube.js               # YouTube 实现
│   ├── services/
│   │   ├── history.js                # 历史记录服务（Provider 调度）
│   │   └── cookie.js                 # Cookie 服务（CookieCloud 集成）
│   ├── middleware/
│   │   └── auth.js                   # 认证中间件
│   └── utils/
│       ├── cookiecloud.js             # CookieCloud 客户端
│       ├── cookieCache.js             # Cookie 缓存管理
│       └── cookieNetscape.js         # Netscape Cookie 格式转换
├── public/                           # 前端静态资源
│   └── index.html                    # 单页面应用
├── data/                             # 数据存储目录
│   ├── history.db                    # SQLite 数据库文件（运行后生成）
│   ├── cookie_cache.json              # Cookie 缓存文件（CookieCloud 模式）
│   └── youtube_sync_state.json       # YouTube 同步状态文件
├── docker/                           # Docker 相关文件
│   ├── docker-compose.yml             # 本地开发配置
│   ├── docker-compose.deploy.yml      # 生产部署配置
│   ├── export/                       # 镜像导出目录
│   └── build_and_export.bat          # Windows 镜像构建导出脚本
├── docs/                             # 文档目录
│   └── API_CLIENT.md                 # 客户端接入指南
├── config.json                       # 配置文件（需手动创建）
├── config-example.json               # 配置文件模板
├── Dockerfile                        # Docker 镜像构建文件
├── package.json                      # 项目配置
└── README.md                         # 项目文档
```

## 技术栈

### 后端
- **Node.js** >= 14.0.0
- **Express** - Web 框架
- **better-sqlite3** - SQLite 数据库
- **node-fetch** - HTTP 请求库
- **dayjs** - 日期处理库
- **evp_bytestokey** - CookieCloud 解密支持
- **cors** - 跨域支持

### 前端
- **HTML5 / JavaScript (ES6+)**
- **Tailwind CSS** - 样式框架（CDN 引入）

### 其他依赖
- **yt-dlp** - YouTube 历史记录获取（Docker 环境已内置）

## 系统要求

- Node.js >= 14.0.0
- npm >= 6.0.0
- Python 3 和 pip（如需使用 YouTube，非 Docker 环境）

## 安装

### 方式一：Docker 部署（推荐）

1. 克隆项目
```bash
git clone https://github.com/haha2026/bilibili-history-server.git
cd bilibili-history-server
```

2. 配置
复制 `config-example.json` 为 `config.json` 并修改配置（详见[配置说明](#配置说明)）

3. 启动服务
```bash
cd docker
docker-compose up -d
```

### 方式二：本地安装

1. 克隆项目
```bash
git clone https://github.com/haha2026/bilibili-history-server.git
cd bilibili-history-server
```

2. 安装依赖
```bash
npm install
```

3. 安装 yt-dlp（如需使用 YouTube）
```bash
pip install yt-dlp
```

4. 配置
复制 `config-example.json` 为 `config.json` 并修改配置（详见[配置说明](#配置说明)）

## 配置说明

### 服务器配置

```json
{
  "server": {
    "port": 3000,
    "syncInterval": 3600000,
    "timezone": 8
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `server.port` | 服务器端口，默认 3000 |
| `server.syncInterval` | Bilibili 自动同步间隔（毫秒），默认 3600000（1小时） |
| `server.timezone` | 时区偏移（小时），如 8 表示 UTC+8，用于 YouTube 同步时间点计算 |

### 认证配置

```json
{
  "auth": {
    "password": "your_password_here",
    "maxAttempts": 5,
    "lockoutDuration": 300000
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `auth.password` | 访问密码，留空则不启用认证 |
| `auth.maxAttempts` | 最大尝试次数，默认 5 |
| `auth.lockoutDuration` | 锁定时长（毫秒），默认 300000（5分钟） |

### 平台配置

#### Bilibili

```json
{
  "providers": {
    "bilibili": {
      "enabled": true,
      "cookie": "SESSDATA=your_sessdata_here; bili_jct=your_bili_jct_here"
    }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `providers.bilibili.enabled` | 是否启用 Bilibili 同步 |
| `providers.bilibili.cookie` | B站登录凭证，需包含 `SESSDATA` 和 `bili_jct` |

#### YouTube

```json
{
  "providers": {
    "youtube": {
      "enabled": true,
      "syncInterval": 43200000,
      "firstSyncCount": 100
    }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `providers.youtube.enabled` | 是否启用 YouTube 同步 |
| `providers.youtube.syncInterval` | 自动同步间隔（毫秒），默认 43200000（12小时） |
| `providers.youtube.firstSyncCount` | 首次同步获取的记录数，默认 100 条 |

**注意**：
- YouTube 必须使用 CookieCloud 获取 Cookie（不支持静态配置）
- YouTube 同步会在每天 00:00 和 12:00（配置时区）自动触发
- 删除远程记录功能暂未实现

#### YouTube-CDP（实验性功能）

使用 Chrome DevTools Protocol 连接到远程 Chrome 获取 YouTube 历史记录，支持精确的观看时间解析。

```json
{
  "providers": {
    "youtube-cdp": {
      "enabled": true,
      "syncInterval": 28800000,
      "timezoneOffset": 8,
      "cdp": {
        "host": "localhost",
        "port": 9222,
        "maxScrolls": 15,
        "scrollInterval": 3000,
        "targetLoadCount": 50
      }
    }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `providers.youtube-cdp.enabled` | 是否启用 YouTube-CDP 同步 |
| `providers.youtube-cdp.syncInterval` | 自动同步间隔（毫秒），默认 28800000（8小时） |
| `providers.youtube-cdp.timezoneOffset` | 时区偏移（小时），用于日期解析，默认 8（UTC+8） |
| `providers.youtube-cdp.cdp.host` | CDP 服务地址，默认 localhost |
| `providers.youtube-cdp.cdp.port` | CDP 服务端口，默认 9222 |
| `providers.youtube-cdp.cdp.maxScrolls` | 最大滚动次数，默认 15 |
| `providers.youtube-cdp.cdp.scrollInterval` | 滚动间隔（毫秒），默认 3000 |
| `providers.youtube-cdp.cdp.targetLoadCount` | 目标加载记录数，默认 50 |

**前置条件**：
- 需要运行一个开启远程调试的 Chrome 实例
- Chrome 必须已登录 YouTube 账号

**启动 Chrome 调试模式**：

Windows:
```bash
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\temp\chrome-debug
```

Linux/Mac:
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

Docker:
```bash
docker run -d -p 9222:9222 \
  --name chrome-cdp \
  zenika/alpine-chrome:latest \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222
```

**优势**：
- 支持精确的观看时间解析（"Thursday"、"Jan 26"、"Dec 15, 2025" 等格式）
- 不依赖 yt-dlp 和 Python 环境
- 纯 Node.js 实现

**注意**：
- 这是实验性功能，建议先在测试环境验证
- 需要占用额外的 Chrome 实例资源
- 删除远程记录功能暂未实现

### CookieCloud 配置

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
      },
      "youtube": {
        "domain": ".youtube.com"
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
| `cookiecloud.platforms.youtube.domain` | YouTube cookie 的域名，默认 `.youtube.com` |

启用 CookieCloud 后：
- 系统会自动从云端获取最新的 cookie
- cookie 会缓存到本地 `data/cookie_cache.json`，根据过期时间自动刷新
- Bilibili 支持自动刷新 cookie（认证失败时）
- YouTube 必须启用 CookieCloud 才能使用

### 获取 Bilibili Cookie

**方式一：手动配置**

1. 登录 [B站](https://www.bilibili.com)
2. 打开浏览器开发者工具（F12）
3. 切换到 Application/存储 -> Cookies
4. 复制 `SESSDATA` 和 `bili_jct` 的值

**方式二：使用 CookieCloud 自动同步（推荐）**

如果你已经部署了 [CookieCloud](https://github.com/easychen/CookieCloud) 服务，可以配置自动同步 cookie（见上方[CookieCloud 配置](#cookiecloud-配置)）。

### 获取 YouTube Cookie

YouTube **必须**使用 CookieCloud 获取 cookie，不支持手动配置。

1. 在浏览器中登录 YouTube
2. 使用 [CookieCloud 浏览器扩展](https://github.com/easychen/CookieCloud) 上传 cookie
3. 在服务器配置中启用 CookieCloud 并配置相关信息

> **安全提示**：Cookie 包含敏感信息，请妥善保管，不要泄露或提交到公开仓库。

## 运行

### 开发模式（本地）

```bash
npm run dev
```

### 生产模式（本地）

```bash
npm start
```

### Docker 模式

```bash
cd docker
docker-compose up -d
```

### 构建导出 Docker 镜像（Windows）

```bash
cd docker
build_and_export.bat
```

启动后访问 `http://localhost:3000` 即可使用。

## API 接口

### 认证接口

#### 获取认证状态
```
GET /api/auth/status

响应：
{
  "required": true,          // 是否需要认证
  "locked": false,          // 是否被锁定
  "lockoutRemaining": 0,    // 锁定剩余时间（毫秒）
  "remainingAttempts": 5     // 剩余尝试次数
}
```

#### 验证密码
```
POST /api/auth/verify

请求体：
{ "password": "your_password" }

响应：
{
  "success": true,
  "message": "认证成功"
}
```

### 业务接口（需要认证）

所有业务接口需要在请求头中携带认证信息：
```
X-Auth-Token: <password>
```

#### 获取历史记录
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

#### 获取已启用的平台
```
GET /api/platforms

响应：
{
  "platforms": ["bilibili", "youtube"]
}
```

#### 同步历史记录
```
POST /api/history/sync

请求体（可选）：
{ "platform": "bilibili" }  // 不传则同步所有已启用平台

响应：
{
  "success": true,
  "message": "同步成功，新增5条记录，更新2条记录",
  "details": {
    "bilibili": { "newCount": 5, "updateCount": 2 },
    "youtube": { "newCount": 10, "updateCount": 0 }
  }
}
```

#### 删除历史记录
```
DELETE /api/history/:id

响应：
{
  "success": true,
  "message": "删除成功"
}
```

#### 设置同步间隔
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

#### 获取同步间隔
```
GET /api/get-sync-interval

响应：
{ "interval": 3600000 }
```

#### 图片代理
```
GET /img-proxy?url=<encoded-url>

说明：用于代理图片，解决跨域问题
```

## 数据存储

历史记录存储在 SQLite 数据库 `data/history.db` 中，表结构如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 历史记录ID（主键，与 platform 组成复合主键） |
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

## Docker 部署

### 本地开发

```bash
cd docker
docker-compose up -d
```

### 生产部署

```bash
cd docker
docker-compose -f docker-compose.deploy.yml up -d
```

### 镜像构建和导出

Windows 环境：
```bash
cd docker
build_and_export.bat
```

Linux/Mac 环境可参考 `build_and_export.bat` 手动构建。

## 故障排查

### YouTube 同步失败

1. 确认已安装 yt-dlp：`yt-dlp --version`
2. 确认已启用并正确配置 CookieCloud
3. 检查 YouTube Cookie 是否有效
4. 查看服务器日志获取详细错误信息

### CookieCloud 连接失败

1. 确认 CookieCloud 服务地址正确
2. 确认 UUID 和 Password 正确
3. 确认 CookieCloud 服务可访问（网络、防火墙等）
4. 查看服务器日志获取详细错误信息

### 认证失败

1. 检查 `config.json` 中 `auth.password` 是否配置
2. 检查前端请求头是否携带 `X-Auth-Token`
3. 如果被锁定，等待锁定时间结束或重启服务器

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

## 致谢

- [bilibili-history-wxt](https://github.com/mundane799699/bilibili-history-wxt) - 参考项目
- [CookieCloud](https://github.com/easychen/CookieCloud) - Cookie 同步方案
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - YouTube 历史记录获取
