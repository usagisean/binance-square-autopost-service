# Binance Square Autopost Service

一个可自托管到 VPS 的 Binance Square 自动发帖服务：行情感知 → Prompt 生成 → 定时发布 → Telegram 回执 → Web 后台编辑 Prompt。

## 功能

- Web 后台编辑 Prompt、启停定时任务、手动预览 / 发布
- 默认 preview-only：定时任务只生成内容给你看，不真实发帖
- 通用 Job 配置：Job 名称、说明、语言、风格、Prompt 模板、模型中转站都可配置
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

# 其他用户复制仓库后，改这几项就可以变成自己的任务
JOB_NAME=Binance Square Market Autopost
JOB_DESCRIPTION=基于真实 Binance 行情，生成有交易员视角的短帖。
POST_LANGUAGE=zh-CN
STYLE_GUIDE=短句、克制、有交易感；不要报告腔、模板腔、喊单腔。
DEFAULT_PROMPT_FILE=

# Preview by default: scheduler and web actions only generate content, not publish.
# Change to live only after you finish testing.
PUBLISH_MODE=preview

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

默认 `PUBLISH_MODE=preview`：即使启用定时任务，也只会生成发帖内容并记录到“最近运行”，不会调用 Binance 发布接口。

生产发布前，后台里把 `LLM Provider` 从 `mock` 改成 `openai`，保存设置。等你确认内容质量后，再把“发布模式”从 `preview` 切换到 `live`。

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

## 给其他用户的最小配置流程

1. Fork/clone 仓库。
2. `cp .env.example .env`。
3. 修改：

```env
JOB_NAME=你的任务名称
JOB_DESCRIPTION=你的发帖目标、主题、受众说明
POST_LANGUAGE=zh-CN
STYLE_GUIDE=你的文风要求
OPENAI_BASE_URL=https://你的中转站/v1
OPENAI_API_KEY=你的中转站 key
OPENAI_MODEL=你的模型名
BINANCE_SQUARE_OPENAPI_KEY=你的 Binance Square key
PUBLISH_MODE=preview
```

4. 启动后先保持 `preview`，只看生成内容。
5. 确认稳定后，再把发布模式切到 `live`。

默认 Prompt 模板在 `templates/default-prompt.md`。如果用户想完全自定义模板，可以：

- 在 Web 后台直接编辑 Prompt；或
- 设置 `DEFAULT_PROMPT_FILE=/path/to/your-prompt.md` 后首次启动生成。


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
