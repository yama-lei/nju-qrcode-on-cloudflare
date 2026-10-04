# 南京大学二维码调查

## 交付约束（G1）
在 Cloudflare 上部署密码保护的网页，使用本人授权账号持续取得当前有效二维码，自动刷新并在过期时停止展示；验证登录续期机制后才能认定支持全天运行。交付形态是 Worker 网页和服务端取码逻辑，不修改原始 APK，不依赖手机全天连接。

## 分类（十三项）
1. observed：爱加密壳，Application=s.h.e.l.l.S，DEX 仅四个壳类。
2. observed：校园码由 qrcode.nju.edu.cn 服务端签发 PNG 图片。
3. observed：校园码 UI 在 WebView 中，业务逻辑是网页 JavaScript；该路线不需要 APK 脱壳。
4. observed：用户要求 Cloudflare、密码访问、自动刷新、全天有效。
5. unverified：签名验证待分析；当前不进行重新签名。
6. observed：连接 Android 16 arm64 真机，preflight 未发现 root；另有模拟器。
7. observed：package manager 选择 arm64-v8a；实际进程映射未验证。
8. unverified：尚未建立取码网络基线。
9. observed：输入将提取自已安装 APP，不使用第三方修改版本。
10. unverified：请求签名依赖待分析。
11. unverified：尚未观察启动，不推断崩溃或反分析。
12. unverified：APP 版本 9.7.10，服务端续期及版本约束待验证。
13. inferred：二维码属于账号资源，需要真实登录；不得伪造会话。

## 环境和能力（G2）
- observed：cf --help、cf cli search、cf deploy --help 已运行；支持 --secrets-file。
- observed：python3 可用，python 命令不存在。
- observed：doctor 报告静态 DEX 脚本可用；DEX 索引 droidasc 已安装到 /tmp/nju-qr-reverse-venv。
- observed：Android SDK build-tools 34/35/36 在本机但不在 PATH；adb 可用。
- observed：preflight 真机通过，未设置代理，时钟偏差 1 秒，无 Frida server。
- unverified：设备动态取凭据需要可用登录流程，或另行确认 root/调试能力。

## 已确认事实
- observed：adb pm list packages 找到 com.wisedu.cpdaily.nju。
- observed：adb dumpsys package：versionName=9.7.10，versionCode=90710，primaryCpuAbi=arm64-v8a。
- observed：项目现状是 cf Worker Hello World 模板，未找到目标 APK。
- observed：原始 APK 位于 .private/reverse/original.apk，SHA-256=a3180a50f226da2c01e0cef02b015a949b260ade74f73cd8818b3dc966b120d8。
- observed：真机校园码标注“消费/通行”，BrowsePageActivity 中是 WebView。
- observed：临时 CONNECT 代理记录 qrcode.nju.edu.cn:443；代理和本任务的 adb reverse 已撤除。
- observed：用户通过官方 CAS 登录二维码授权。请求 /api/h5 携带 wisedu User-Agent 返回网页。
- observed：公开 JS 的 API 链为 POST /api/check → /code/v1/qrexchange → /code/v1/qrcode。主要校园码组件 30 秒刷新一次。
- observed：JWT 含 exp，实测约 1 小时；返回续期 ticket。无 Cookie 重复 qrexchange 成功，新 JWT 无 Cookie 取码成功，账号匹配，图片随请求变化。
- observed：npm test 和 typecheck 通过；cf deploy --dry-run 完成。
- observed：使用 cf deploy --secrets-file 部署到 Cloudflare Worker，版本 e42da8b2-74a9-4add-9933-cd78f75212f7。构建文件 .cloudflare/output/v0/workers/default/bundle/index.js，SHA-256=962f3889560a23c81b41ddd1fc1f7e25b39144c328671faa07df7dc121c35450。
- observed：线上 scripts/verify.mjs 验证页面、密码、CSRF、Cookie 属性、真实取码、两次图片不同、无凭据泄漏、no-store、退出和下次保活时间全部通过。
- observed：让 JWT 元数据到期后，线上票据续期遇到 HTTP 400 + JSON code=401；CAS 恢复后成功换票续期，受保护状态接口显示 renewals=1，lastError=null。
- observed：网页在线授权接口生成官方 QR，以 xdg-open 打开，用户确认扫描登录后 /api/authorize/status 返回 authorized；再次取码通过，renewals=2，凭据保存在 Durable Object。
- observed：最终线上状态于 2026-10-04T01:23:56Z 检查：最近取码成功，已安排 10 分钟后的后台保活。状态证据见 .private/verified-status.json。
- observed：源码 token/appkey 泄漏扫描 clean；真机 http_proxy 恢复 null，任务 reverse 已移除，模拟器测试 APP 已卸载。

## 反证与已排除路线
- 不用静态截图冒充动态二维码。
- 未验证服务端续期前不承诺 24 小时有效。
- observed：模拟器原始 APK 按 x86 路径找不到 libexec；放置原始 ARM64 壳库后能加载，但约 2 秒在 ART/ARM 转译中 SIGSEGV。没有把该失败归因于签名或反分析。测试 APP 已卸载，临时库已清理。
- 本机 curl 的默认代理会干扰 localhost，后续本地 HTTP 检查使用 --noproxy '*'。
- refuted：仅 HTTP 401/403 表示学校授权失败。观察到 HTTP 400 中 JSON code=401 同样表示失效；实现已按两层状态识别，并留下该组合的回归检查。

## 未决问题（G3/G4）
- 服务端票据和 CAS 会话最长存活时间尚未测满 24 小时；自动续期不等于上游永不撤销授权。
- 线上 Cloudflare 取码、密码保护和在线扫码授权已通过；真实门禁/消费扫码仍待用户现场验证。

## 证据和私密资料
原始 APK、设备捕获、真实凭据只放 .private/（已忽略）。不把 token、学号、二维码载荷写入公开文件。
