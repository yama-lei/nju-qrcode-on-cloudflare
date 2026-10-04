import { DurableObject } from "cloudflare:workers";
import { passwordMatches, sessionToken, validSession } from "./auth.ts";
import { campusCode, CampusError, initialCredentials, type Credentials } from "./campus.ts";
import { page } from "./page.ts";
import { startAuthorization, authorizationStatus, type LoginAttempt } from "./authorize.ts";

const headers = {
	"Cache-Control": "no-store, private, max-age=0", "Pragma": "no-cache",
	"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
	"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const json = (data: unknown, status = 200, extra = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
const cookie = (value: string, age: number) => `__Host-nju_session=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Strict`;
type AppEnv = Env & { CAMPUS_BOOTSTRAP?: string };

export class CampusSession extends DurableObject<AppEnv> {
	private state!: Credentials;
	private pending?: LoginAttempt;
	private queue: Promise<unknown> = Promise.resolve();
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const stored = await ctx.storage.get<Credentials>("credentials");
			this.state = initialCredentials(env.CAMPUS_BOOTSTRAP, stored);
			this.state.startedAt ??= Date.now();
			this.pending = await ctx.storage.get<LoginAttempt>("pending");
		});
	}
	private async issue() {
		if (!this.state.owner) throw new CampusError(428, "请先点击 APP 登录，扫码绑定校园码账号");
		try { return await campusCode(this.state); }
		catch (error) {
			this.state.lastError = error instanceof CampusError ? error.message : "校园码服务连接失败";
			throw error;
		} finally {
			await this.ctx.storage.put("credentials", this.state);
			await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000);
		}
	}
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn);
		this.queue = result.catch(() => {});
		return result;
	}
	fetch(request: Request): Promise<Response> {
		return this.serial(async () => {
			const path = new URL(request.url).pathname;
			if (path === "/status") return json({
				startedAt: this.state.startedAt, lastIssuedAt: this.state.lastIssuedAt ?? null,
				renewals: this.state.renewals ?? 0, jwtExpiresAt: this.state.jwtExpiresAt,
				lastError: this.state.lastError ?? null, nextKeepaliveAt: await this.ctx.storage.getAlarm(),
			});
			try {
				if (path === "/authorize/start") {
					if (!this.pending || Date.now() - this.pending.createdAt > 120_000) this.pending = await startAuthorization();
					await this.ctx.storage.put("pending", this.pending);
					return json({ image: this.pending.image });
				}
				if (path === "/authorize/status") {
				if (!this.pending) return json({ status: this.state.owner ? "authorized" : "expired" });
					const result = await authorizationStatus(this.pending, this.state);
					if (result.status === "authorized") {
						this.state = result.credentials;
						await this.ctx.storage.put("credentials", this.state);
						await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000);
					}
					if (result.status === "authorized" || result.status === "expired") {
						this.pending = undefined; await this.ctx.storage.delete("pending");
					} else await this.ctx.storage.put("pending", this.pending);
					return json({ status: result.status });
				}
				return json(await this.issue());
			}
			catch (error) { return json({ error: error instanceof CampusError ? error.message : "校园码服务连接失败，请稍后重试" }, error instanceof CampusError ? error.status : 502); }
		});
	}
	async alarm() { await this.serial(() => this.issue()).catch(() => {}); }
}

export default {
	async fetch(request, env) {
		const path = new URL(request.url).pathname;
		if (path === "/" && request.method === "GET") return new Response(page, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
		if (path === "/favicon.ico") return new Response(null, { status: 204, headers });
		if (request.method !== "POST") return json({ error: "未找到页面" }, 404);
		if (request.headers.get("Origin") !== new URL(request.url).origin) return json({ error: "请求来源无效" }, 403);
		if (!env.WEB_PASSWORD || !env.SESSION_KEY || env.SESSION_KEY.length < 32) return json({ error: "请在 Cloudflare 配置 WEB_PASSWORD 和至少 32 字符的 SESSION_KEY" }, 503);
		if (path === "/api/login") {
			const limited = await env.LOGIN_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "local" });
			if (!limited.success) return json({ error: "尝试次数过多，请一分钟后再试" }, 429, { "Retry-After": "60" });
			if (Number(request.headers.get("Content-Length")) > 2048) return json({ error: "请求过大" }, 413);
			let body: { password?: unknown };
			try {
				const raw = await request.text();
				if (raw.length > 2048) return json({ error: "请求过大" }, 413);
				body = JSON.parse(raw);
			} catch { return json({ error: "请求格式无效" }, 400); }
			if (!body || typeof body.password !== "string" || body.password.length > 128 ||
				!await passwordMatches(body.password, env.WEB_PASSWORD, env.SESSION_KEY)) return json({ error: "密码错误" }, 401);
			return json({ ok: true }, 200, { "Set-Cookie": cookie(await sessionToken(env.SESSION_KEY), 86400) });
		}
		if (path === "/api/logout") return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
		const token = request.headers.get("Cookie")?.match(/(?:^|;\s*)__Host-nju_session=([^;]+)/)?.[1] ?? "";
		if (!await validSession(token, env.SESSION_KEY)) return json({ error: "请先输入访问密码" }, 401);
		if (path === "/api/session") return json({ ok: true });
		if (path === "/api/code") return env.CAMPUS.get(env.CAMPUS.idFromName("owner")).fetch("https://internal/code");
		if (path === "/api/status") return env.CAMPUS.get(env.CAMPUS.idFromName("owner")).fetch("https://internal/status");
		if (path === "/api/authorize/start" || path === "/api/authorize/status") return env.CAMPUS.get(env.CAMPUS.idFromName("owner")).fetch(`https://internal${path.slice(4)}`);
		return json({ error: "未找到页面" }, 404);
	},
} satisfies ExportedHandler<AppEnv>;
