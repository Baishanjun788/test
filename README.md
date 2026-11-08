# 小号获取 · 服务器部署版

把你现在这个网页连同"转发服务"一起部署到自己的服务器，
以后**不用开本地代理，任何设备打开网址就能用**。

---

## 一、先说清楚：为什么需要"转发"

接口 `https://api.4399pc.cc/claim_by_key` **没有做 CORS 支持**，实测：

| 请求 | 结果 |
|---|---|
| `POST` + `X-API-Key`（**不带** Origin，服务端调用） | ✅ 200，正常返回账号 |
| `POST` + `X-API-Key` + `Origin: https://example.com` | ❌ **403 Forbidden** |
| `OPTIONS` 预检请求 | ❌ **403 Forbidden** |

浏览器发跨域请求时，**必然带 `Origin` 头**，而且**必然先发 `OPTIONS` 预检**。
这两样都被服务器拒了，请求根本走不出去，前端只能拿到 `TypeError: Failed to fetch`。

你参考的 Python / Ruby 能跑通，是因为它们属于**服务端请求**，不带 `Origin`。

所以关键点是：

> 请求必须由**服务器**发出，而不是由浏览器发出。

**部署到服务器正好满足这个条件** —— 这就是为什么部署到服务器之后就不需要本地代理了。

```
之前（本地）:  浏览器 ──✗ CORS 被拦──> api.4399pc.cc
部署到服务器:  浏览器 ──✓ 同域请求──> 你的服务器 ──✓ 服务端请求──> api.4399pc.cc ──> 你的服务器 ──> 浏览器
```

部署后浏览器只跟**你自己的服务器**打交道（同域，不存在跨域问题），
真正请求接口这件事由服务器完成，从而绕开浏览器限制。

---

## 二、目录内容

```
小号获取-服务器版/
├── server.js              # 转发服务 + 静态网页托管（零依赖，核心文件）
├── public/
│   └── index.html         # 网页本体（界面、复制、历史、冷却都在这里）
├── package.json           # 声明 Node 版本要求（无第三方依赖）
├── .env.example           # 环境变量示例
├── Dockerfile             # 容器镜像（可选）
├── docker-compose.yml     # 一键容器部署（可选）
├── ecosystem.config.json  # PM2 配置（可选）
└── README.md              # 本文件
```

**只需要 Node.js 18 及以上**，没有任何第三方 npm 包，不用 `npm install` 也能跑。

---

## 三、最快上手（3 步）

### 1. 上传

把整个 `小号获取-服务器版` 文件夹传到服务器，例如：

```bash
scp -r 小号获取-服务器版 root@你的服务器IP:/opt/xiaohao
```

### 2. 启动

```bash
cd /opt/xiaohao
node server.js
```

看到下面的输出就成功了：

```
[2026-01-01 12:00:00] ==============================================
[2026-01-01 12:00:00]   小号获取 服务已启动
[2026-01-01 12:00:00]   监听地址: http://0.0.0.0:8787/
[2026-01-01 12:00:00]   上游接口: https://api.4399pc.cc/claim_by_key
[2026-01-01 12:00:00]   可用 API: api1, api2
[2026-01-01 12:00:00]   访问口令: 未设置（公网部署建议设置）
[2026-01-01 12:00:00]   限速策略: 每 IP 每 60 秒最多 10 次
[2026-01-01 12:00:00] ==============================================
```

### 3. 打开

浏览器访问 `http://你的服务器IP:8787/` 即可。
记得在云厂商控制台的**安全组**里放行 8787 端口，否则外网打不开。

---

## 四、正式部署建议（重要）

### 4.1 一定要设置访问口令

不设口令的话，**任何知道网址的人都能消耗你的额度**。设置方法：

```bash
ACCESS_TOKEN=改成你自己的随机字符串 node server.js
```

建议生成一串随机口令：

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

设置后，网页上会出现口令输入框，输入一次会记在浏览器里；服务端所有请求都会校验。

### 4.2 用 PM2 常驻运行（断线不退出、开机自启）

```bash
npm install -g pm2
pm2 start ecosystem.config.json
pm2 save
pm2 startup        # 按提示执行它输出的那行命令，实现开机自启
pm2 logs xiaohao   # 看日志
pm2 restart xiaohao
```

> `ecosystem.config.json` 里已经有 Key 和端口配置，按需修改。

### 4.3 用 systemd 常驻（不用装 PM2）

创建 `/etc/systemd/system/xiaohao.service`：

```ini
[Unit]
Description=Xiaohao Claim Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/xiaohao
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=PORT=8787
Environment=HOST=0.0.0.0
Environment=ACCESS_TOKEN=改成你的口令
Environment=API_KEY_1=aku_6648b8a4a0204d6168e180086b206ac47d96a29e
Environment=API_KEY_2=aku_b625effc303427b2e8ae1dd817756ad38717f639

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xiaohao
sudo systemctl status xiaohao
journalctl -u xiaohao -f    # 看日志
```

### 4.4 用 Docker 部署

方式一，compose（推荐）：

```bash
cd /opt/xiaohao
# 先编辑 docker-compose.yml，改掉 ACCESS_TOKEN
docker compose up -d --build
docker compose logs -f
```

方式二，纯命令：

```bash
cd /opt/xiaohao
docker build -t xiaohao .
docker run -d --name xiaohao --restart unless-stopped \
  -p 8787:8787 \
  -e ACCESS_TOKEN=你的口令 \
  xiaohao
```

### 4.5 配域名 + HTTPS（推荐）

用 Nginx 反代到 8787，这样能用域名和 https，也能和 80/443 共存：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # 让服务端能拿到真实客户端 IP，按 IP 限速才准
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }
}
```

然后 `certbot --nginx -d your-domain.com` 一键上 HTTPS。

> Nginx 的 `X-Forwarded-For` 很重要：服务端靠它识别真实客户端 IP 做限速，
> 不配的话所有人会被当成 127.0.0.1 共用一份限速额度。

---

## 五、配置项说明

全部用**环境变量**配置，都有默认值：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `UPSTREAM` | `https://api.4399pc.cc/claim_by_key` | 上游接口地址 |
| `API_KEY_1` | 已内置 baishanjun 的 Key | API 1 的 Key |
| `API_KEY_2` | 已内置 chenxx 的 Key | API 2 的 Key |
| `ACCESS_TOKEN` | 空 | 访问口令，留空则不校验 |
| `LIMIT_WINDOW_MS` | `60000` | 限速时间窗口（毫秒） |
| `LIMIT_MAX` | `10` | 窗口内每个 IP 最多请求次数 |
| `UPSTREAM_TIMEOUT_MS` | `25000` | 请求上游超时 |
| `CORS_ORIGIN` | `*` | 允许的跨域来源（同域部署用不到） |

**Key 只存在服务端**，前端拿不到，安全性比把 Key 写死在 HTML 里更好。

---

## 六、接口说明

### `GET /healthz` — 健康检查

```json
{
  "ok": true,
  "service": "xiaohao-server",
  "upstream": "https://api.4399pc.cc/claim_by_key",
  "tokenRequired": false,
  "apis": ["api1", "api2"]
}
```

前端打开时会调用它来判断是否需要显示口令框。

### `POST /api/claim` — 获取账号

请求体：

```json
{ "api": "api1", "token": "可选的口令" }
```

- `api`：`api1` 或 `api2`，省略默认 `api1`
- 也可以把口令放在请求头 `X-Access-Token` 里

成功时**原样返回上游的 JSON**：

```json
{
  "code": 1,
  "msg": "ok",
  "username": "gerrym1ntray9120",
  "password": "234kuUhr",
  "quota_limit": 25,
  "used_count": 1,
  "remaining": 24
}
```

错误情况：

| 状态码 | 含义 |
|---|---|
| `400` | `api` 参数非法（不是 api1/api2） |
| `401` | 口令错误或未提供 |
| `405` | 用了 GET（必须用 POST） |
| `429` | 触发本站限速，响应头带 `Retry-After` |
| `502` | 上游返回异常 |
| `504` | 请求上游超时 |

前端对 `401` 会自动弹出命令输入框，对 `429` 会提示等待秒数。

---

## 七、网页功能清单

跟本地版完全一致，额外多了口令支持：

- **API 切换**：API 1 - baishanjun / API 2 - chenxx，选择会被记住
- **一键复制**：账号、密码各自有复制按钮
- **剩余次数**：右上角大字显示，剩余 ≤3 变红；底部显示已用 / 额度
- **3 秒冷却**：每次请求后按钮锁定 3 秒，倒计时实时显示
- **历史获取**：每次成功后，上一次的账号密码自动移入下方历史区
  - 带获取时间和 API 标签
  - 存在浏览器 localStorage，关掉再开依然在，最多 200 条
  - 每条支持：复制账号+密码 / 填回输入框 / 删除
  - 顶部：复制全部（按行导出）/ 清空
- **访问口令**：服务端开启后自动显示输入框
- **Ctrl + Enter**：快捷获取

> 历史记录存在**每个浏览器自己的** localStorage 里，换设备/换浏览器不会同步，这是有意为之（账号密码不上传服务器）。

---

## 八、常见问题

**Q：浏览器打开空白 / 提示无法连接转发服务**
确认服务在跑：`curl http://127.0.0.1:8787/healthz`。
外网打不开就检查云厂商安全组是否放行端口。

**Q：还是报 Failed to fetch**
看浏览器地址是不是 `http://IP:8787/`。如果你单独打开 `public/index.html` 文件（file://），
同域请求失效，必须通过服务器地址访问。

**Q：提示 401 / 需要访问口令**
服务端设了 `ACCESS_TOKEN`，在网页顶部输入框填同一个口令，点保存。

**Q：提示 429 请求过于频繁**
触发了本站限速（默认每 IP 60 秒 10 次）。调大 `LIMIT_MAX` 或调大 `LIMIT_WINDOW_MS`。
注意如果前面有 Nginx，务必配 `X-Forwarded-For`，否则所有用户共用一份额度。

**Q：`remaining` 一直不减少**
该接口的额度统计方式由上游决定；页面如实显示返回的数字，与部署无关。

**Q：端口被占用**
改 `PORT` 环境变量，或 `docker-compose.yml` 里的端口映射。

**Q：前端和后端想分开部署（不同域名）**
把 `public/index.html` 里这行改成服务地址：

```js
var CLAIM_ENDPOINT = "https://api.your-domain.com/api/claim";
```

同时把服务的 `CORS_ORIGIN` 设为前端的域名（不要留 `*`）。

**Q：能不能直接扔到静态托管（如 GitHub Pages / 宝塔纯静态）**
不行。纯静态托管只发文件，**不能发服务端请求**，跨域问题依旧存在，必须要有这块 Node 服务（或等价的 PHP/Python 服务端转发）。

---

## 九、运维小抄

```bash
# 看日志
pm2 logs xiaohao            # PM2
journalctl -u xiaohao -f    # systemd
docker compose logs -f      # Docker

# 重启
pm2 restart xiaohao
sudo systemctl restart xiaohao
docker compose restart

# 验证服务正常
curl http://127.0.0.1:8787/healthz

# 验证能拿到账号（记得带上口令）
curl -X POST http://127.0.0.1:8787/api/claim \
  -H "Content-Type: application/json" \
  -H "X-Access-Token: 你的口令" \
  -d '{"api":"api1"}'
```

---

## 十、安全提醒

1. **务必设置 `ACCESS_TOKEN`**，否则网址一旦泄露，额度会被随便用。
2. 服务端日志会记录每次请求的 IP、api、返回码，**不会记录账号密码**。
3. 历史记录只存在访问者自己的浏览器里，服务器不落库。
4. 建议上 HTTPS，避免口令在公网明文传输。
5. Key 建议只配在服务器的环境变量里，不要写进前端代码。
