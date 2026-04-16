# TVBox Source Aggregator

将多个 TVBox 配置源合并成一个稳定的聚合地址。自动测速筛选、站点级去重、Spider JAR 智能分配，部署在 Cloudflare Worker 上，免费、零运维。

## 功能

- **多源聚合** — 添加多个 TVBox 配置 JSON 地址，自动合并为一个
- **站点去重** — 不同源中的相同站点只保留一份
- **Spider JAR 智能分配** — 自动处理 type:3 站点的 JAR 依赖冲突
- **测速筛选**（可选） — 自动过滤不可达或高延迟的源
- **管理后台** — 网页端添加/删除源，触发刷新
- **定时更新** — 每天自动重新聚合，客户端无感知
- **容错设计** — 聚合失败时保留上次有效缓存

## 快速开始

### 1. 准备环境

- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费）
- Node.js 18+

### 2. 克隆仓库

```bash
git clone https://gitee.com/tengxiaobao/tvbox-source-aggregator.git
cd tvbox-source-aggregator
npm install
```

### 3. 登录 Cloudflare

```bash
npx wrangler login
```

### 4. 创建 KV 存储

```bash
npx wrangler kv namespace create KV
npx wrangler kv namespace create KV --preview
```

将输出的 `id` 和 `preview_id` 填入 `wrangler.toml`。

### 5. 设置密码

```bash
echo "your-admin-password" | npx wrangler secret put ADMIN_TOKEN
```

### 6. 部署

```bash
npm run deploy
```

### 7. 添加源

打开 `https://your-worker-url/admin`，输入密码，添加你的 TVBox 配置 JSON 地址，点击 Refresh。

### 8. TVBox 配置

将 `https://your-worker-url/` 填入 TVBox 的接口地址。

## 自定义域名（推荐）

Workers 默认的 `*.workers.dev` 域名在部分网络环境下不可直接访问。如果你有托管在 Cloudflare 的域名：

1. 在 Cloudflare DNS 添加记录：`AAAA tvbox 100::` （已代理）
2. 取消 `wrangler.toml` 中 `routes` 的注释，填入你的域名和 Zone ID

## 可选：测速功能

注册 [zbape.com](https://www.zbape.com) 获取免费 API Key，然后：

```bash
echo "your-api-key" | npx wrangler secret put ZBAPE_API_KEY
```

开启后，每次聚合会自动测速并过滤高延迟源。

## 端点说明

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | TVBox 配置 JSON（客户端填这个地址） |
| `/status` | GET | 监控仪表盘页面 |
| `/status-data` | GET | 状态数据 JSON |
| `/admin` | GET | 管理后台（密码保护） |
| `/refresh` | POST | 手动触发聚合刷新 |

## 项目结构

```
├── src/
│   ├── index.ts          # Worker 入口：路由、Cron、聚合流程
│   ├── admin.ts          # 管理后台页面
│   ├── dashboard.ts      # 监控仪表盘页面
│   ├── fetcher.ts        # 批量 fetch 配置 JSON（并发、超时、容错解析）
│   ├── parser.ts         # 配置规范化（相对 URL 转绝对、Spider JAR 提取）
│   ├── merger.ts         # 站点级合并引擎（Spider JAR 智能分配）
│   ├── dedup.ts          # 去重逻辑（sites/parses/lives/doh/rules/hosts/ads/flags）
│   ├── speedtest.ts      # zbape.com 测速 API（1QPS 限流）
│   ├── types.ts          # TypeScript 类型定义
│   └── config.ts         # 常量配置
├── wrangler.toml         # CF Worker 配置
├── package.json
└── tsconfig.json
```

## 环境变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `ADMIN_TOKEN` | Secret | 管理后台密码（必填） |
| `ZBAPE_API_KEY` | Secret | zbape.com 测速 API 密钥（可选） |
| `REFRESH_TOKEN` | Secret | 刷新接口独立 Token（可选） |
| `SPEED_TIMEOUT_MS` | Var | 源延迟阈值，默认 5000ms |
| `FETCH_TIMEOUT_MS` | Var | fetch 配置超时，默认 5000ms |

## 定时任务

默认每天 UTC 5:00（北京时间 13:00）自动聚合。修改 `wrangler.toml` 中的 `crons` 调整。

## License

MIT
