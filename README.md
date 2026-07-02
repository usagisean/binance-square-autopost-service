# Binance Square Autopost Service

一个可自托管到 VPS 的 Binance Square 自动发帖服务：行情感知 → Prompt 生成 → 定时发布 → Telegram 回执 → Web 后台编辑 Prompt。

## 功能

- Web 后台编辑 Prompt、启停定时任务、手动预览 / 发布
- Web 后台登录页：未登录只显示登录框，配置、密钥、运行记录均需 `ADMIN_TOKEN`
- NewAPI 风格侧边栏后台：概览、Prompt、模型渠道、通知/密钥、任务设置、运行记录分区管理
- Web 后台配置 OpenAI-compatible 渠道、API Key、拉取 `/models`、测试模型、设置最多 10 个 fallback 优先级
- Web 后台配置情报源：新闻 RSS、KOL 手动源、宏观/地缘/名人效应备注、Coinglass Key、链上 API Keys
- 自动发布安全阀：Lead 币种冷却、禁用词校验、近帖相似度校验、连续失败自动暂停
- 条件式交易计划：基于真实行情/盘口/15m K 线生成方向、触发点、失效/止损位，Prompt 只能引用数据包内的计划
- 概览页展示发帖热力图、今日额度、LLM / Publisher 状态；热力图按每日上限（默认 100）和当天 24 小时分布显示
- 默认 preview-only：定时任务只生成内容给你看，不真实发帖
- 通用 Job 配置：Job 名称、说明、语言、风格、Prompt 模板、模型中转站都可配置
- 定时发布，默认每 20 分钟检查一次
- 每日发帖计数与上限
- Binance futures 数据优先；遇到 451 或不可用时 fallback 到 `www.binance.com/api/v3` 现货数据
- OpenAI-compatible `chat/completions`、`/completions`、`responses` 三种模式；也支持 `LLM_PROVIDER=mock` 本地测试
- Binance Square OpenAPI 发布
- Telegram 成功/失败通知（可选）
- Web 后台配置 Telegram Bot Token / Chat ID 并发送测试消息
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
OPENAI_MAX_TOKENS=8192
OPENAI_TIMEOUT_MS=45000

BINANCE_SQUARE_OPENAPI_KEY=...

TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

默认 `PUBLISH_MODE=preview`：即使启用定时任务，也只会生成发帖内容并记录到“最近运行”，不会调用 Binance 发布接口。

生产发布前，后台里把 `LLM Provider` 从 `mock` 改成 `openai`，保存设置。然后在“模型渠道配置”里填中转站 Base URL、API Key 和模型优先级。等你确认内容质量后，再把“发布模式”从 `preview` 切换到 `live`。

### OpenAI-compatible / 中转站配置

服务默认使用后台里的“API 模式”。`auto` 会按顺序尝试；其中 `chat/completions` 和 `responses` 会在非流式空正文时自动 fallback 到流式 SSE 解析：

```text
POST {OPENAI_BASE_URL}/chat/completions        # non-stream + stream fallback
POST {OPENAI_BASE_URL}/completions
POST {OPENAI_BASE_URL}/responses               # non-stream + stream fallback
Authorization: Bearer {OPENAI_API_KEY}
```

所以只要你的中转站兼容 OpenAI 任一文本生成接口，填：

```env
OPENAI_BASE_URL=https://你的中转站域名/v1
OPENAI_API_KEY=
OPENAI_MODEL=中转站支持的模型名
```

推荐直接在 Web 后台的“模型渠道配置”中维护：

- 渠道名、Base URL、API Key
- API 模式：一般选 `auto`；若要贴近 OpenClaw 的 `openai-completions`，可选 `chat/completions`；旧版补全接口选 `/completions`
- 从 `{OPENAI_BASE_URL}/models` 拉取模型
- 每行一个模型 ID，按顺序设置最多 10 个 fallback 模型
- “测试首选模型”确认当前渠道能正常返回内容

模型渠道配置会保存到 `data/llm_config.json`。旧版单一 `OPENAI_*` env 仍作为默认渠道 / fallback 保留。

API Key / Binance Key 都可以在后台填。模型渠道 Key 保存到 `data/llm_config.json`，Binance Key 保存到 `data/secrets.json`。这些 `data/*.json` 已被 `.gitignore` 忽略，不会进 Git。

### 配置热更新

后台保存的这些配置都会写入 VPS 的 `data/*.json`，下一次手动预览、手动发布或定时任务会直接读取；不需要重新跑 GitHub Actions，也不需要重启容器：

- Prompt、任务设置、发布模式、定时间隔、每日上限
- 模型渠道、API Key、模型优先级、fallback 数量
- Telegram / Binance Square Key
- 情报源配置：RSS、KOL 手动源、Coinglass Key、链上 API Keys、宏观备注
- 安全阀：Lead 冷却、禁用词、相似度阈值、连续失败暂停

代码层面的更新（新增页面、字段、行情/情报抓取逻辑、发布逻辑）不是热更新；需要推送 GitHub 后由 Actions 部署，或在 VPS 上 `git pull && docker compose up -d --build`。

### 内容长度、标签和交易计划建议

如果要写方向、触发点、止损，建议在“任务设置”里设置：

```text
最短字符：180
最长字符：360
交易计划：开启
交易计划模式：conditional
```

Binance Square 底部币种卡片由平台识别 `$BTC` 这类 Cashtag 后自动生成。不是所有币都会稳定出卡片；服务里提供“Square 标签优先币种”，会优先选择更常见、更容易被识别的币做 lead/peer，但仍以真实波动和成交活跃度为核心。

示例模型优先级：

```text
gpt-5.4-mini
gpt-5.4
gpt-5.3-codex
gpt-5.2
gpt-5.1
gpt-5
gpt-4o
```

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
LLM_PROVIDER=openai
# 推荐启动后在 Web 后台“模型渠道配置”填写：
# OPENAI_BASE_URL / OPENAI_API_KEY / 模型优先级
BINANCE_SQUARE_OPENAPI_KEY=
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
- `GET /api/llm-config`（加 `?reveal=1` 可在已授权后台显示完整 API Key）
- `PUT /api/llm-config`
- `POST /api/llm-config/channels/:id/models/fetch`
- `POST /api/llm-config/test`
- `GET /api/intel-config`（加 `?reveal=1` 可在已授权后台显示完整 Key）
- `PUT /api/intel-config`
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
- `data/llm_config.json`：模型渠道、API Key、模型优先级，已忽略 Git
- `data/intel_config.json`：新闻 RSS、KOL 源、Coinglass Key、链上 API Keys、宏观备注，已忽略 Git
- `data/secrets.json`：Web 后台保存的 API Key，已忽略 Git
- `data/runs.jsonl`：运行日志，已忽略 Git
- `data/daily_counter.json`：每日计数，已忽略 Git
- `data/market_pack_cache.json`：行情缓存，已忽略 Git

## 注意

- 不要把 `.env` 提交到 Git。
- 如果 VPS 出口本身对 Binance 被 451，优先换 VPS 区域；也可以在 `.env` 配置 `HTTPS_PROXY`，但生产上更推荐稳定干净的 VPS 出口。
- `mock` 模式不会调用 LLM，适合先验证页面、定时、行情与发布链路。真正发帖请使用真实 LLM。若你强行用 mock 发布，服务不会阻止，但内容会比较模板。

## Docker / VPS 部署链路

### 方案 A：VPS 本地 build（最直接）

在 VPS 上安装 Docker 和 Docker Compose Plugin 后：

```bash
git clone https://github.com/usagisean/binance-square-autopost-service.git
cd binance-square-autopost-service
cp .env.docker.example .env
mkdir -p data
nano .env
```

先保持：

```env
PUBLISH_MODE=preview
LLM_PROVIDER=mock
```

启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

打开后台前，建议先配置域名反代；如果只是临时测试，可以用 SSH tunnel：

```bash
ssh -L 8787:127.0.0.1:8787 root@YOUR_VPS_IP
```

然后本机打开：`http://127.0.0.1:8787`。

更新代码：

```bash
./scripts/vps-update.sh
```

### 方案 B：GitHub Actions 构建 GHCR 镜像，VPS 只拉镜像

仓库包含 `.github/workflows/docker.yml`。推送到 `main` 后，GitHub Actions 会构建：

```text
ghcr.io/usagisean/binance-square-autopost-service:main
```

VPS 上使用：

```bash
mkdir -p /opt/binance-square-autopost-service/data
cd /opt/binance-square-autopost-service
curl -O https://raw.githubusercontent.com/usagisean/binance-square-autopost-service/main/docker-compose.ghcr.yml
curl -o .env https://raw.githubusercontent.com/usagisean/binance-square-autopost-service/main/.env.docker.example
nano .env
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

如果 GHCR package 是 private，需要先登录：

```bash
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

### 域名与 HTTPS

推荐让容器只绑定本机端口：

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

然后用 Caddy 或 Nginx 反代。

Caddy 示例：`deploy/caddy/Caddyfile.example`

```caddyfile
your-domain.example.com {
  encode gzip
  reverse_proxy 127.0.0.1:8787
}
```

Nginx 示例：`deploy/nginx/binance-square-autopost.conf.example`

首次部署建议流程：

1. DNS A 记录指向 VPS IP。
2. Docker 服务启动并确认 `curl 127.0.0.1:8787/health` 正常。
3. 配置 Caddy/Nginx HTTPS。
4. 后台设置 `ADMIN_TOKEN`。
5. 保持 `PUBLISH_MODE=preview`，只看生成内容。
6. 内容稳定后再切 `PUBLISH_MODE=live`。

## GitHub Actions 自动部署到 VPS

仓库包含 `.github/workflows/deploy.yml`。它只负责部署代码和重启 Docker，不保存/覆盖你的业务配置。

部署时会通过 SSH 登录 VPS，自动：

1. 安装/检查 `git`、`docker`；
2. clone/pull 当前仓库；
3. 如果 VPS 上还没有 `.env`，复制 `.env.docker.example` 生成一个初始 `.env`；
4. 执行 `docker compose up -d --build`；
5. 调用 `/health` 做健康检查。

### GitHub Secrets

进入仓库：

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`

只需要添加这些 VPS 登录信息：

```text
VPS_HOST=你的 VPS IP
VPS_USER=root
VPS_PORT=22
VPS_APP_DIR=/opt/binance-square-autopost-service
VPS_SSH_KEY=你的 SSH 私钥内容
```

不需要配置 `VPS_ENV`。`.env` 放在 VPS 本地，后续改配置不需要改 GitHub Secrets。

### 首次部署流程

1. 在 GitHub 手动运行：

```text
Actions -> Deploy to VPS -> Run workflow
```

第一次运行会在 VPS 上创建：

```text
/opt/binance-square-autopost-service/.env
```

2. SSH 到 VPS 编辑 `.env`：

```bash
ssh root@YOUR_VPS_IP
cd /opt/binance-square-autopost-service
nano .env
```

如果 DNS 已经解析到 VPS，并想启用内置 Caddy HTTPS 反代，至少改：

```env
COMPOSE_PROFILES=caddy
DOMAIN=你的完整域名
PUBLIC_BASE_URL=https://你的完整域名
ADMIN_TOKEN=换成一个长随机字符串
PUBLISH_MODE=preview
```

测试阶段建议保持：

```env
LLM_PROVIDER=mock
PUBLISH_MODE=preview
```

3. 保存 `.env` 后，重新运行一次：

```text
Actions -> Deploy to VPS -> Run workflow
```

或者直接在 VPS 上执行：

```bash
cd /opt/binance-square-autopost-service
docker compose up -d --build
```

### 以后怎么改配置

以后改模型、中转站、Prompt、域名、发布模式，都直接在 VPS 上改：

```bash
ssh root@YOUR_VPS_IP
cd /opt/binance-square-autopost-service
nano .env
docker compose up -d
```

无需重新配置 GitHub Secrets。只有代码更新时，才重新跑 GitHub Actions 部署。

### 生成部署 SSH key

如果你还没有专用部署 key，在本机执行：

```bash
ssh-keygen -t ed25519 -C "github-actions-binance-autopost" -f ~/.ssh/binance_autopost_actions
```

把公钥放进 VPS：

```bash
cat ~/.ssh/binance_autopost_actions.pub | ssh root@YOUR_VPS_IP 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys'
```

测试：

```bash
ssh -i ~/.ssh/binance_autopost_actions root@YOUR_VPS_IP 'echo ok'
```

`VPS_SSH_KEY` 填私钥内容：

```bash
cat ~/.ssh/binance_autopost_actions
```

如果你已经有可用的本机 SSH key，也可以复用那把 key。

### 域名与 HTTPS

如果使用内置 Caddy：

```env
COMPOSE_PROFILES=caddy
DOMAIN=你的完整域名
PUBLIC_BASE_URL=https://你的完整域名
```

VPS 防火墙/安全组需要放行：

```text
80/tcp
443/tcp
```

如果你使用 Cloudflare 橙云代理，建议：

- SSL/TLS 模式选择 `Full` 或 `Full (strict)`
- 不要用 `Flexible`，否则容易出现 HTTPS 重定向循环

首次部署后访问：

```text
https://你的完整域名
```

## 图片发帖支持（可选）

服务默认仍按纯文本发布。需要图片帖时，在后台“图片素材”上传图片，然后在“任务设置”里开启“启用图片发帖”。

配图策略支持：

- `static`：固定图片路径，最多 4 张。
- `random`：从图片素材库随机选择。
- `rotate`：从图片素材库按发帖次数轮流选择。
- `off`：即使开启了图片模块，本轮也不配图。

Docker 部署时，图片路径建议放在 VPS 项目挂载的数据目录里，例如：

```text
/app/data/images/test.png
```

后台可填写相对路径：

```text
images/test.png
```

也可以直接在后台“图片素材”上传，图片会保存到 `data/images/`。

如果勾选“自动生成行情配图”，服务会基于本轮 lead / peer / anchor 生成一张 1080x1080 的证据图，而不是把正文贴到图上。当前会在真实 15m K 线、盘口挂单墙、合约 OI/资金费率/多空比三类图里按数据可用性随机选择。默认关闭，不影响纯文本发布。`MAX_DAILY_POSTS` 默认 50，`AUTO_IMAGE_MAX_DAILY` / 后台“每日自动生成图上限”默认 20。LIVE 模式下，系统会按“当天剩余图片额度 / 当天剩余发帖额度”做随机分布；达到图片上限后不会停发，只会自动降级为原来的纯文本发帖。

实现参考 Binance 官方 `binance-skills-hub / square-post`：先调用 `/image/presignedUrl` 获取上传 URL，再 PUT 图片，轮询 `/image/imageStatus`，最后发布 `contentType: 1 + bodyTextOnly + imageList`。

不需要新的 Key，仍使用现有 `BINANCE_SQUARE_OPENAPI_KEY`。
