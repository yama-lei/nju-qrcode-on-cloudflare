export interface CookieSession {
	cookies?: { host: string; name: string; value: string; path: string }[];
}
export interface Credentials extends CookieSession {
	seed: string;
	owner: string;
	ticket: string;
	jwt: string;
	jwtExpiresAt: number;
	lastIssuedAt?: number;
	renewals?: number;
	lastError?: string;
	startedAt?: number;
}
export interface CampusCode {
	image: string;
	issuedAt: number;
	displayUntil: number;
	timestamp: string;
}
export class CampusError extends Error {
	readonly status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
export function initialCredentials(bootstrap?: string, stored?: Credentials): Credentials {
	const seed = bootstrap?.trim() ? JSON.parse(bootstrap) as Credentials : undefined;
	if (stored && (!seed || stored.seed === seed.seed)) return stored;
	return seed ?? { seed: "web", owner: "", ticket: "", jwt: "", jwtExpiresAt: 0 };
}
export function jwtExpiry(jwt: string) {
	try {
		const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
		if (!Number.isFinite(payload.exp)) throw new Error();
		return payload.exp * 1000;
	} catch { throw new CampusError(502, "校园码服务返回了无效凭据"); }
}

// Only the two observed university hosts participate in the CAS redirect chain.
export async function universityRequest(state: CookieSession, start: string, options: RequestInit = {}, request = fetch) {
	const cookies = state.cookies ?? [];
	let method = options.method ?? "GET", body = options.body;
		let url = new URL(start);
		for (let hop = 0; hop < 8; hop++) {
			if (url.protocol !== "https:" || !["qrcode.nju.edu.cn", "authserver.nju.edu.cn"].includes(url.hostname) || (url.port && url.port !== "443"))
				throw new CampusError(502, "校园码登录跳转异常");
			const response = await request(url, { method, body, redirect: "manual", signal: AbortSignal.timeout(8000),
				headers: { ...options.headers, "User-Agent": "wisedu", Cookie: cookies.filter(c => c.host === url.hostname && url.pathname.startsWith(c.path))
					.map(c => `${c.name}=${c.value}`).join("; ") } });
			for (const raw of response.headers.getSetCookie()) {
				const parts = raw.split(";").map(p => p.trim());
				const separator = parts[0].indexOf("=");
				if (separator < 1) continue;
				const name = parts[0].slice(0, separator), value = parts[0].slice(separator + 1);
				const path = parts.find(p => /^path=/i.test(p))?.slice(5) ?? "/";
				const index = cookies.findIndex(c => c.host === url.hostname && c.name === name && c.path === path);
				if (index >= 0) cookies.splice(index, 1);
				if (value && !parts.some(p => /^max-age=0$/i.test(p))) cookies.push({ host: url.hostname, name, value, path });
			}
			state.cookies = cookies;
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("Location");
				if (!location) throw new CampusError(502, "校园码登录跳转异常");
				url = new URL(location, url);
				if ([301, 302, 303].includes(response.status)) { method = "GET"; body = undefined; }
				continue;
			}
			return response;
		}
		throw new CampusError(502, "校园码登录跳转过多");
}
export async function campusTicket(state: Credentials, request = fetch): Promise<string> {
	const cookies = state.cookies ?? [];
	if (!cookies.length) throw new CampusError(503, "授权已失效，需要重新扫码登录");
	await universityRequest(state, "https://qrcode.nju.edu.cn/api/h5", {}, request);
	const response = await universityRequest(state, "https://qrcode.nju.edu.cn/api/check", { method: "POST" }, request);
	const ticket = (await response.text()).trim().replace(/^"|"$/g, "");
	if (!response.ok || !/^[A-Za-z0-9:_-]{16,256}$/.test(ticket)) throw new CampusError(503, "授权已失效，需要重新扫码登录");
	return ticket;
}
async function postCode(state: Credentials, path: string, withJwt: boolean, request: typeof fetch) {
		const response = await request(`https://qrcode.nju.edu.cn${path}`, {
			method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
			headers: { "Content-Type": "application/json", "User-Agent": "wisedu", Ticket: state.ticket,
				...(withJwt ? { Authorization: state.jwt } : {}) }, body: "{}",
		});
		let data: Record<string, unknown> | null = null;
		try { data = await response.json() as Record<string, unknown>; } catch { /* Some gateways return HTML. */ }
		if (!response.ok || data?.code === 401 || data?.code === 403) throw new CampusError(
			response.status === 401 || response.status === 403 || data?.code === 401 || data?.code === 403 ? 503 : 502,
			"校园码服务暂不可用，可能需要重新扫码授权");
		if (!data || typeof data !== "object") throw new CampusError(502, "校园码服务返回异常");
		return data;
}
export async function renewCredentials(state: Credentials, request = fetch) {
		let data: Record<string, unknown>;
		try { data = await postCode(state, "/code/v1/qrexchange", false, request); }
		catch (error) {
			if (!(error instanceof CampusError) || error.status !== 503) throw error;
			state.ticket = await campusTicket(state, request);
			data = await postCode(state, "/code/v1/qrexchange", false, request);
		}
		if (typeof data.jwt !== "string" || typeof data.ticket !== "string") throw new CampusError(502, "校园码续期失败");
		state.jwtExpiresAt = jwtExpiry(data.jwt);
		state.jwt = data.jwt;
		state.ticket = data.ticket;
		state.renewals = (state.renewals ?? 0) + 1;
}
export async function campusCode(state: Credentials, request = fetch, now = Date.now): Promise<CampusCode> {
	if (!state.owner || !state.ticket) throw new CampusError(428, "请先点击 APP 登录，扫码绑定校园码账号");
	if (!state.jwt || state.jwtExpiresAt <= now() + 300_000) await renewCredentials(state, request);
	let data: Record<string, unknown>;
	try { data = await postCode(state, "/code/v1/qrcode", true, request); }
	catch (error) {
		if (!(error instanceof CampusError) || error.status !== 503) throw error;
		await renewCredentials(state, request);
		data = await postCode(state, "/code/v1/qrcode", true, request);
	}
	if (data.stuempno !== state.owner) throw new CampusError(502, "校园码账号不匹配");
	if (data.type !== "i" || typeof data.qrcode !== "string" || data.qrcode.length > 1_000_000 ||
		!/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(data.qrcode)) throw new CampusError(502, "校园码图片格式异常");
	if (typeof data.ticket === "string" && data.ticket) state.ticket = data.ticket;
	const issuedAt = now();
	state.lastIssuedAt = issuedAt;
	delete state.lastError;
	// The official page refreshes at 30s. This is our display limit, not a server expiry claim.
	return { image: `data:image/png;base64,${data.qrcode}`, issuedAt, displayUntil: issuedAt + 30_000,
		timestamp: typeof data.timestamp === "string" ? data.timestamp : "" };
}
