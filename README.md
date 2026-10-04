# nju-qrcode-on-cloudflare

把你的实时南大二维码共享给别人，方便带人进校园。

网页使用密码访问，每 25 秒刷新校园码。后台自动续期，首次扫码绑定南大账号，后续重新授权使用同一账号。
>注意，国内无法访问worker.dev，出于方便，建议在Cloudflare Console-->Workers里面给对应的Worker加上托管的域名（如果有的话）； 或者让AI把服务部署在任何其他的服务器/Pages托管服务。

## 方法一：Cloudflare CLI 部署

需要 Node.js 22.18+、Python 3.9+ 和 curl。安装 [Cloudflare CLI](https://github.com/cloudflare/cf)：

```bash
git clone https://github.com/yama-lei/nju-qrcode-on-cloudflare.git
cd nju-qrcode-on-cloudflare
npm install -g cf
npm ci
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r scripts/requirements.txt
cf auth login

npm test
npm run typecheck
python3 scripts/authorize.py
cf deploy --secrets-file .private/deploy-secrets.json
node scripts/verify.mjs https://YOUR-WORKER.workers.dev
```

授权脚本首次运行会询问网页访问密码，在**终端输出可扫描的二维码**，并保存到项目根目录的 **`qrcode.png`**。用已登录的南京大学 APP 扫描并确认后，凭据保存到 `.private/deploy-secrets.json`。二维码过期时重新运行脚本即可。

## 方法二：一键部署，网页认证

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yama-lei/nju-qrcode-on-cloudflare)

1. 点击按钮，在 Cloudflare 中克隆该公开仓库，保留默认 Worker 名称 `nju-qr`。
2. 配置 `WEB_PASSWORD`（网页访问密码）与 `SESSION_KEY`（至少 32 字符的随机密钥）。可用 `python3 -c 'import secrets; print(secrets.token_hex(32))'` 生成密钥。
3. 保留构建命令 `npm run build`、部署命令 `npm run deploy`。部署按钮通过 `wrangler.jsonc` 识别资源，实际构建和部署使用 `cf` 与 `cloudflare.config.ts`。
4. 打开部署后的网页，输入访问密码，点击“用南京大学 APP 登录 / 重新授权”，在 APP 中扫码确认。