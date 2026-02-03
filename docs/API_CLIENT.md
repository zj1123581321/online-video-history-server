# 视频历史记录服务器 - 客户端接入指南

本文档指导其他项目如何接入和使用视频历史记录服务器的 API。

## 目录

- [快速开始](#快速开始)
- [认证机制](#认证机制)
- [API 接口](#api-接口)
- [错误处理](#错误处理)
- [代码示例](#代码示例)

---

## 快速开始

### 基本信息

| 项目 | 说明 |
|------|------|
| 基础地址 | `http://localhost:3000`（默认） |
| 数据格式 | JSON |
| 字符编码 | UTF-8 |

### 最小示例

```javascript
// 获取历史记录列表
const response = await fetch('http://localhost:3000/api/history', {
  headers: {
    'X-Auth-Token': 'your_password'  // 如果启用了认证
  }
});
const data = await response.json();
console.log(data.items);
```

---

## 认证机制

### 认证流程

服务器支持可选的密码认证。如果配置了 `auth.password`，所有 API 请求（白名单除外）都需要携带认证信息。

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   客户端    │────▶│ GET /api/auth/  │────▶│  检查是否   │
│             │     │    status       │     │  需要认证   │
└─────────────┘     └─────────────────┘     └──────┬──────┘
                                                   │
                    ┌──────────────────────────────┼──────────────────────────────┐
                    │                              │                              │
                    ▼                              ▼                              ▼
           required: false                required: true                  required: true
           (直接调用 API)                  (未认证)                        (已认证)
                                                   │                              │
                                                   ▼                              │
                                    ┌─────────────────────────┐                   │
                                    │ POST /api/auth/verify   │                   │
                                    │ body: { password: xxx } │                   │
                                    └───────────┬─────────────┘                   │
                                                │                                 │
                                    ┌───────────┴───────────┐                     │
                                    ▼                       ▼                     │
                               验证成功                 验证失败                   │
                            (保存 token)           (显示错误信息)                  │
                                    │                                             │
                                    └─────────────────────────────────────────────┤
                                                                                  │
                                                                                  ▼
                                                                    携带 X-Auth-Token 调用 API
```

### 白名单接口

以下接口无需认证即可访问：

- `GET /api/auth/status` - 获取认证状态
- `POST /api/auth/verify` - 验证密码
- `GET /img-proxy` - 图片代理

### 认证方式

在所有需要认证的请求中，添加 HTTP Header：

```
X-Auth-Token: <password>
```

### 失败锁定机制

- 默认最大尝试次数：5 次
- 默认锁定时长：5 分钟（300000 毫秒）
- 锁定期间所有认证请求将返回 `429` 状态码

---

## API 接口

### 认证相关

#### 获取认证状态

检查服务器是否需要认证，以及当前 IP 的状态。

```
GET /api/auth/status
```

**响应示例：**

```json
{
  "required": true,
  "locked": false,
  "lockoutRemaining": 0,
  "remainingAttempts": 5
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `required` | boolean | 是否需要认证 |
| `locked` | boolean | 当前 IP 是否被锁定 |
| `lockoutRemaining` | number | 锁定剩余时间（毫秒） |
| `remainingAttempts` | number | 剩余尝试次数 |

#### 验证密码

```
POST /api/auth/verify
Content-Type: application/json
```

**请求体：**

```json
{
  "password": "your_password"
}
```

**成功响应 (200)：**

```json
{
  "success": true,
  "message": "认证成功"
}
```

**失败响应 (401)：**

```json
{
  "success": false,
  "error": "密码错误",
  "code": "INVALID_PASSWORD",
  "remainingAttempts": 4
}
```

**锁定响应 (429)：**

```json
{
  "success": false,
  "error": "尝试次数过多，请稍后再试",
  "code": "LOCKED",
  "lockoutRemaining": 300000
}
```

---

### 历史记录

#### 获取历史记录列表

```
GET /api/history
```

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `platform` | string | 否 | `all` | 平台过滤：`bilibili`、`youtube`、`all` |
| `keyword` | string | 否 | - | 视频标题搜索关键词 |
| `authorKeyword` | string | 否 | - | UP主/作者名称关键词 |
| `date` | string | 否 | - | 日期过滤，格式：`YYYY-MM-DD` |
| `page` | number | 否 | `1` | 页码 |
| `pageSize` | number | 否 | `20` | 每页数量 |

**响应示例：**

```json
{
  "items": [
    {
      "id": 1,
      "platform": "bilibili",
      "business": "archive",
      "bvid": "BV1xx411c7mD",
      "cid": 12345678,
      "title": "视频标题",
      "tag_name": "科技",
      "cover": "https://i0.hdslb.com/xxx.jpg",
      "view_time": 1704067200,
      "viewTime": 1704067200,
      "uri": "bilibili://video/BV1xx411c7mD",
      "author_name": "UP主名称",
      "author_mid": 12345,
      "timestamp": 1704067200000
    }
  ],
  "total": 100,
  "hasMore": true
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `items` | array | 历史记录数组 |
| `total` | number | 符合条件的总记录数 |
| `hasMore` | boolean | 是否还有更多数据 |

**items 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 记录唯一 ID |
| `platform` | string | 来源平台 |
| `business` | string | 内容类型（archive/pgc/live 等） |
| `bvid` | string | 视频 ID |
| `cid` | number | 内容 ID |
| `title` | string | 视频标题 |
| `tag_name` | string | 分类标签 |
| `cover` | string | 封面图片 URL |
| `view_time` | number | 观看时间（Unix 时间戳，秒） |
| `viewTime` | number | 同 view_time（兼容字段） |
| `uri` | string | 资源 URI |
| `author_name` | string | 作者名称 |
| `author_mid` | number | 作者 ID |
| `timestamp` | number | 本地记录时间戳（毫秒） |

#### 同步历史记录

手动触发从远程平台同步历史记录。

```
POST /api/history/sync
Content-Type: application/json
```

**请求体（可选）：**

```json
{
  "platform": "bilibili"
}
```

不传 `platform` 则同步所有已启用平台。

**响应示例：**

```json
{
  "success": true,
  "message": "同步成功，新增 5 条记录，更新 2 条记录",
  "details": {
    "bilibili": {
      "newCount": 5,
      "updateCount": 2
    }
  }
}
```

#### 删除历史记录

删除指定的历史记录（同时删除远程和本地）。

```
DELETE /api/history/:id
```

**路径参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | number | 历史记录 ID |

**响应示例：**

```json
{
  "success": true,
  "message": "删除成功"
}
```

---

### 平台管理

#### 获取已启用的平台

```
GET /api/platforms
```

**响应示例：**

```json
{
  "platforms": ["bilibili"]
}
```

---

### 同步设置

#### 获取同步间隔

```
GET /api/get-sync-interval
```

**响应示例：**

```json
{
  "interval": 60
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `interval` | number | 同步间隔（分钟） |

#### 设置同步间隔

```
POST /api/set-sync-interval
Content-Type: application/json
```

**请求体：**

```json
{
  "interval": 60
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `interval` | number | 同步间隔（分钟），最小值 1 |

**响应示例：**

```json
{
  "message": "同步间隔已更新",
  "interval": 60
}
```

---

### 图片代理

用于解决跨域图片加载问题。

```
GET /img-proxy?url=<encoded-url>
```

**查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | string | URL 编码后的图片地址 |

**示例：**

```
GET /img-proxy?url=https%3A%2F%2Fi0.hdslb.com%2Fxxx.jpg
```

返回图片二进制数据，Content-Type 与原图一致。

---

## 错误处理

### HTTP 状态码

| 状态码 | 说明 |
|--------|------|
| `200` | 请求成功 |
| `400` | 请求参数错误 |
| `401` | 未授权访问 |
| `404` | 资源不存在 |
| `429` | 请求过于频繁（IP 被锁定） |
| `500` | 服务器内部错误 |
| `502` | 代理请求失败 |

### 错误响应格式

```json
{
  "success": false,
  "error": "错误描述信息",
  "code": "ERROR_CODE"
}
```

### 错误码列表

| 错误码 | 说明 |
|--------|------|
| `UNAUTHORIZED` | 未授权访问，需要认证 |
| `INVALID_PASSWORD` | 密码错误 |
| `LOCKED` | IP 被锁定 |

---

## 代码示例

### JavaScript / TypeScript

```typescript
/**
 * 视频历史记录服务器客户端
 */
class HistoryClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
  }

  /**
   * 设置认证 token
   */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * 发起请求
   */
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.token) {
      headers['X-Auth-Token'] = this.token;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * 获取认证状态
   */
  async getAuthStatus(): Promise<{
    required: boolean;
    locked: boolean;
    lockoutRemaining: number;
    remainingAttempts: number;
  }> {
    return this.request('/api/auth/status');
  }

  /**
   * 验证密码
   */
  async verifyPassword(password: string): Promise<{ success: boolean }> {
    const result = await this.request<{ success: boolean }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });

    if (result.success) {
      this.token = password;
    }

    return result;
  }

  /**
   * 获取历史记录
   */
  async getHistory(params: {
    platform?: string;
    keyword?: string;
    authorKeyword?: string;
    date?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<{
    items: HistoryItem[];
    total: number;
    hasMore: boolean;
  }> {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        query.set(key, String(value));
      }
    });

    return this.request(`/api/history?${query}`);
  }

  /**
   * 同步历史记录
   */
  async syncHistory(platform?: string): Promise<{
    success: boolean;
    message: string;
    details: Record<string, { newCount: number; updateCount: number }>;
  }> {
    return this.request('/api/history/sync', {
      method: 'POST',
      body: platform ? JSON.stringify({ platform }) : undefined,
    });
  }

  /**
   * 删除历史记录
   */
  async deleteHistory(id: number): Promise<{ success: boolean }> {
    return this.request(`/api/history/${id}`, {
      method: 'DELETE',
    });
  }

  /**
   * 获取已启用的平台
   */
  async getPlatforms(): Promise<{ platforms: string[] }> {
    return this.request('/api/platforms');
  }

  /**
   * 获取同步间隔
   */
  async getSyncInterval(): Promise<{ interval: number }> {
    return this.request('/api/get-sync-interval');
  }

  /**
   * 设置同步间隔
   * @param interval 同步间隔（分钟）
   */
  async setSyncInterval(interval: number): Promise<{ message: string; interval: number }> {
    return this.request('/api/set-sync-interval', {
      method: 'POST',
      body: JSON.stringify({ interval }),
    });
  }

  /**
   * 获取代理图片 URL
   */
  getProxyImageUrl(originalUrl: string): string {
    return `${this.baseUrl}/img-proxy?url=${encodeURIComponent(originalUrl)}`;
  }
}

// 类型定义
interface HistoryItem {
  id: number;
  platform: string;
  business: string;
  bvid: string;
  cid: number;
  title: string;
  tag_name: string;
  cover: string;
  view_time: number;
  viewTime: number;
  uri: string;
  author_name: string;
  author_mid: number;
  timestamp: number;
}

// 使用示例
async function main() {
  const client = new HistoryClient('http://localhost:3000');

  // 检查是否需要认证
  const authStatus = await client.getAuthStatus();

  if (authStatus.required) {
    // 需要认证，验证密码
    await client.verifyPassword('your_password');
  }

  // 获取历史记录
  const history = await client.getHistory({
    platform: 'bilibili',
    page: 1,
    pageSize: 20,
  });

  console.log(`共 ${history.total} 条记录`);
  history.items.forEach(item => {
    console.log(`[${item.platform}] ${item.title} - ${item.author_name}`);
  });
}
```

### Python

```python
"""
视频历史记录服务器 Python 客户端
"""
import requests
from typing import Optional
from urllib.parse import urlencode


class HistoryClient:
    """视频历史记录服务器客户端"""

    def __init__(self, base_url: str = "http://localhost:3000"):
        self.base_url = base_url.rstrip("/")
        self.token: Optional[str] = None
        self.session = requests.Session()

    def set_token(self, token: str) -> None:
        """设置认证 token"""
        self.token = token

    def _request(self, method: str, path: str, **kwargs) -> dict:
        """发起请求"""
        headers = kwargs.pop("headers", {})

        if self.token:
            headers["X-Auth-Token"] = self.token

        response = self.session.request(
            method,
            f"{self.base_url}{path}",
            headers=headers,
            **kwargs
        )

        if not response.ok:
            error_data = response.json() if response.text else {}
            raise Exception(error_data.get("error", f"HTTP {response.status_code}"))

        return response.json()

    def get_auth_status(self) -> dict:
        """获取认证状态"""
        return self._request("GET", "/api/auth/status")

    def verify_password(self, password: str) -> dict:
        """验证密码"""
        result = self._request(
            "POST",
            "/api/auth/verify",
            json={"password": password}
        )

        if result.get("success"):
            self.token = password

        return result

    def get_history(
        self,
        platform: str = "all",
        keyword: Optional[str] = None,
        author_keyword: Optional[str] = None,
        date: Optional[str] = None,
        page: int = 1,
        page_size: int = 20
    ) -> dict:
        """
        获取历史记录

        Args:
            platform: 平台过滤 (bilibili/youtube/all)
            keyword: 视频标题关键词
            author_keyword: 作者名称关键词
            date: 日期过滤 (YYYY-MM-DD)
            page: 页码
            page_size: 每页数量

        Returns:
            包含 items, total, hasMore 的字典
        """
        params = {
            "platform": platform,
            "page": page,
            "pageSize": page_size
        }

        if keyword:
            params["keyword"] = keyword
        if author_keyword:
            params["authorKeyword"] = author_keyword
        if date:
            params["date"] = date

        return self._request("GET", f"/api/history?{urlencode(params)}")

    def sync_history(self, platform: Optional[str] = None) -> dict:
        """同步历史记录"""
        json_data = {"platform": platform} if platform else None
        return self._request("POST", "/api/history/sync", json=json_data)

    def delete_history(self, record_id: int) -> dict:
        """删除历史记录"""
        return self._request("DELETE", f"/api/history/{record_id}")

    def get_platforms(self) -> dict:
        """获取已启用的平台"""
        return self._request("GET", "/api/platforms")

    def get_sync_interval(self) -> dict:
        """获取同步间隔"""
        return self._request("GET", "/api/get-sync-interval")

    def set_sync_interval(self, interval: int) -> dict:
        """
        设置同步间隔

        Args:
            interval: 同步间隔（分钟），最小 1
        """
        return self._request(
            "POST",
            "/api/set-sync-interval",
            json={"interval": interval}
        )

    def get_proxy_image_url(self, original_url: str) -> str:
        """获取代理图片 URL"""
        from urllib.parse import quote
        return f"{self.base_url}/img-proxy?url={quote(original_url, safe='')}"


# 使用示例
if __name__ == "__main__":
    client = HistoryClient("http://localhost:3000")

    # 检查是否需要认证
    auth_status = client.get_auth_status()
    print(f"需要认证: {auth_status['required']}")

    if auth_status["required"]:
        # 验证密码
        result = client.verify_password("your_password")
        print(f"认证结果: {result['success']}")

    # 获取历史记录
    history = client.get_history(platform="bilibili", page=1, page_size=10)
    print(f"共 {history['total']} 条记录")

    for item in history["items"]:
        print(f"[{item['platform']}] {item['title']} - {item['author_name']}")

    # 同步历史记录
    sync_result = client.sync_history()
    print(f"同步结果: {sync_result['message']}")
```

### cURL

```bash
# 获取认证状态
curl http://localhost:3000/api/auth/status

# 验证密码
curl -X POST http://localhost:3000/api/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"password": "your_password"}'

# 获取历史记录（带认证）
curl http://localhost:3000/api/history \
  -H "X-Auth-Token: your_password"

# 获取历史记录（带过滤）
curl "http://localhost:3000/api/history?platform=bilibili&keyword=test&page=1&pageSize=10" \
  -H "X-Auth-Token: your_password"

# 同步历史记录
curl -X POST http://localhost:3000/api/history/sync \
  -H "X-Auth-Token: your_password" \
  -H "Content-Type: application/json"

# 同步指定平台
curl -X POST http://localhost:3000/api/history/sync \
  -H "X-Auth-Token: your_password" \
  -H "Content-Type: application/json" \
  -d '{"platform": "bilibili"}'

# 删除历史记录
curl -X DELETE http://localhost:3000/api/history/123 \
  -H "X-Auth-Token: your_password"

# 获取已启用平台
curl http://localhost:3000/api/platforms \
  -H "X-Auth-Token: your_password"

# 获取同步间隔
curl http://localhost:3000/api/get-sync-interval \
  -H "X-Auth-Token: your_password"

# 设置同步间隔（1小时 = 60分钟）
curl -X POST http://localhost:3000/api/set-sync-interval \
  -H "X-Auth-Token: your_password" \
  -H "Content-Type: application/json" \
  -d '{"interval": 60}'
```

---

## 常见问题

### Q: 如何处理图片跨域问题？

使用图片代理接口：

```javascript
const proxyUrl = `http://localhost:3000/img-proxy?url=${encodeURIComponent(originalUrl)}`;
```

### Q: 如何实现无限滚动？

通过 `hasMore` 字段判断是否还有更多数据：

```javascript
async function loadMore(page) {
  const data = await client.getHistory({ page, pageSize: 20 });

  appendItems(data.items);

  if (data.hasMore) {
    // 还有更多，可以继续加载
    return page + 1;
  }
  return null; // 没有更多了
}
```

### Q: 时间戳如何转换？

`view_time` 是 Unix 时间戳（秒），转换示例：

```javascript
const date = new Date(item.view_time * 1000);
```

```python
from datetime import datetime
date = datetime.fromtimestamp(item["view_time"])
```

### Q: 如何处理认证失败？

监听 `401` 状态码，提示用户重新认证：

```javascript
if (response.status === 401) {
  // 跳转到登录页或显示登录弹窗
  showLoginDialog();
}
```

---

## 更新日志

- **v1.0.0** - 初始版本，支持 Bilibili 平台
