# Binance Square Autopost Service

一个可自托管到 VPS 的 Binance Square 自动发帖服务：行情感知 → Prompt 生成 → 定时发布 → Telegram 回执 → Web 后台编辑 Prompt。

## 功能

- Web 后台编辑 Prompt、启停定时任务、手动 dry-run / 发布
- 定时发布，默认每 20 分钟检查一次
- 每日发帖计数与上限
- Binance futures 数据优先；遇到 451 或不可用时 fallback 到 `www.binance.com/api/v3` 现货数据
- OpenAI-compatible Chat Completions；也支持 `LLM_PROVIDER=mock` 本地测试
- Binance Square OpenAPI 发布
- Telegram 成功/失败通知（可选）
- 所有状态存在 `data/`，不依赖数据库

## 本地启动

```bash
cd binance-square-autopost-service
cp .env.example .env
# 编辑 .env：至少设置 ADMIN_TOKEN；真正发布还要设置 BINANCE_SQUARE_OPENAPI_KEY 和 LLM 配置
node --check src/server.js
npm start
```

打开：`http://127.0.0.1:8787`

如果 `.env` 里设置了 `ADMIN_TOKEN`，在页面左侧填入同一个 token。

## 关键配置

```env
PORT=8787
HOST=127.0.0.1
ADMIN_TOKEN=change-me-long-random-token

LLM_PROVIDER=mock              # 本地测试用 mock；生产改成 openai
OPENAI_BASE_URL=https://api.openai.com/v1  # 或你的中转站：https://relay.example.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini      # 或中转站里的模型名
OPENAI_TEMPERATURE=0.8
OPENAI_MAX_TOKENS=180
OPENAI_TIMEOUT_MS=45000

BINANCE_SQUARE_OPENAPI_KEY=...

TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

生产发布前，后台里把 `LLM Provider` 从 `mock` 改成 `openai`，保存设置。

### OpenAI-compatible / 中转站配置

服务调用的是标准 Chat Completions：

```text
POST {OPENAI_BASE_URL}/chat/completions
Authorization: Bearer {OPENAI_API_KEY}
```

所以只要你的中转站兼容 OpenAI `/v1/chat/completions`，填：

```env
OPENAI_BASE_URL=https://你的中转站域名/v1
OPENAI_API_KEY=你的中转站 key
OPENAI_MODEL=中转站支持的模型名
```

这些非敏感项也可以在 Web 后台编辑；API Key / Binance Key 也可以在后台填，后台会保存到 `data/secrets.json`。`data/secrets.json` 已被 `.gitignore` 忽略，不会进 Git。

## VPS systemd 部署

示例路径用 `/opt/binance-square-autopost-service`：

```bash
sudo useradd --system --home /opt/binance-square-autopost-service --shell /usr/sbin/nologin binancepost || true
sudo mkdir -p /opt/binance-square-autopost-service
sudo rsync -av --exclude data/runs.jsonl ./ /opt/binance-square-autopost-service/
sudo chown -R binancepost:binancepost /opt/binance-square-autopost-service
sudo cp /opt/binance-square-autopost-service/systemd/binance-square-autopost.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now binance-square-autopost
sudo journalctl -u binance-square-autopost -f
```

如果需要外网访问后台，建议用 Nginx/Caddy 反代，并只绑定本机：

```env
HOST=127.0.0.1
PORT=8787
```

## API

- `GET /api/status`
- `PUT /api/settings`
- `GET /api/prompts`
- `POST /api/prompts`
- `PUT /api/prompts/:id`
- `POST /api/prompts/:id/activate`
- `POST /api/run` body: `{ "mode": "dry-run" }` 或 `{ "mode": "publish" }`
- `POST /api/market-pack`
- `GET /api/runs?limit=50`

带 token：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/api/status
```

## 数据文件

- `data/settings.json`：后台设置，首次启动自动生成，已忽略 Git
- `data/prompts.json`：Prompt 版本，首次启动自动生成，已忽略 Git
- `data/secrets.json`：Web 后台保存的 API Key，已忽略 Git
- `data/runs.jsonl`：运行日志，已忽略 Git
- `data/daily_counter.json`：每日计数，已忽略 Git
- `data/market_pack_cache.json`：行情缓存，已忽略 Git

## 注意

- 不要把 `.env` 提交到 Git。
- 如果 VPS 出口本身对 Binance 被 451，优先换 VPS 区域；也可以在 `.env` 配置 `HTTPS_PROXY`，但生产上更推荐稳定干净的 VPS 出口。
- `mock` 模式不会调用 LLM，适合先验证页面、定时、行情与发布链路。真正发帖请使用真实 LLM。若你强行用 mock 发布，服务不会阻止，但内容会比较模板。
