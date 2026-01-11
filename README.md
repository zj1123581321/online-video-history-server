# Bilibili 历史记录服务器

一个轻量级的 B站观看历史记录管理系统，支持自动同步、搜索过滤、导入导出等功能。

本项目参考了 [bilibili-history-wxt](https://github.com/mundane799699/bilibili-history-wxt) 项目的部分实现。

## 功能特点

- **自动同步**：定时从 B站 同步观看历史记录，支持自定义同步间隔
- **手动同步**：支持手动触发同步操作
- **智能搜索**：支持按视频标题、UP主名称、日期等多维度过滤
- **无限滚动**：前端支持滚动到底部自动加载更多内容
- **删除功能**：同时删除远程和本地历史记录
- **导入/导出**：支持历史记录 JSON 格式的导出和导入
- **图片代理**：解决 B站 图片跨域问题
- **数据本地存储**：使用 SQLite 数据库存储，查询性能优秀，方便备份和迁移

## 项目结构

```
bilibili-history-server/
├── src/                              # 后端源代码
│   ├── index.js                      # 主应用程序入口
│   ├── db/
│   │   └── index.js                  # 数据库初始化模块
│   └── services/
│       └── history.js                # 历史记录同步服务
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
  "bilibili": {
    "cookie": "SESSDATA=your_sessdata_here; bili_jct=your_bili_jct_here"
  },
  "server": {
    "port": 3000,
    "syncInterval": 3600000
  }
}
```

### 配置说明

| 配置项 | 说明 |
|--------|------|
| `bilibili.cookie` | B站登录凭证，需包含 `SESSDATA` 和 `bili_jct` |
| `server.port` | 服务器端口，默认 3000 |
| `server.syncInterval` | 自动同步间隔（毫秒），默认 3600000（1小时） |

### 获取 Cookie

1. 登录 [B站](https://www.bilibili.com)
2. 打开浏览器开发者工具（F12）
3. 切换到 Application/存储 -> Cookies
4. 复制 `SESSDATA` 和 `bili_jct` 的值

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

### 同步历史记录
```
POST /api/history/sync

响应：
{
  "success": true,
  "message": "同步成功，新增5条记录，更新2条记录"
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
  "success": true,
  "message": "同步间隔已更新"
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

说明：用于代理 B站 图片，解决跨域问题
```

## 数据存储

历史记录存储在 SQLite 数据库 `data/history.db` 中，表结构如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 历史记录ID（主键） |
| `business` | TEXT | 内容类型 |
| `bvid` | TEXT | B站视频BV号 |
| `cid` | INTEGER | 内容ID |
| `title` | TEXT | 视频标题 |
| `tag_name` | TEXT | 分类标签 |
| `cover` | TEXT | 封面图片URL |
| `view_time` | INTEGER | 观看时间（Unix时间戳） |
| `uri` | TEXT | 资源URI |
| `author_name` | TEXT | UP主名称 |
| `author_mid` | INTEGER | UP主ID |
| `timestamp` | INTEGER | 本地记录时间戳 |

### 支持的内容类型

| 类型 | 说明 |
|------|------|
| `archive` | 普通视频 |
| `pgc` | 番剧/电影 |
| `article` | 专栏文章 |
| `article-list` | 文章列表 |
| `live` | 直播 |
| `cheese` | 课程 |

## 数据备份

建议定期备份 `data/history.db` 文件。也可以使用前端的导出功能将数据导出为 JSON 文件保存。

> **数据迁移**：如果从旧版本升级，启动时会自动将 `data/history.json` 中的数据迁移到 SQLite 数据库，并将原文件备份为 `history.json.bak`。

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

## 致谢

- [bilibili-history-wxt](https://github.com/mundane799699/bilibili-history-wxt) - 参考项目
