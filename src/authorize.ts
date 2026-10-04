import { CampusError, campusCode, campusTicket, renewCredentials, universityRequest, type CookieSession, type Credentials } from "./campus.ts";

const auth = "https://authserver.nju.edu.cn/authserver";
const login = `${auth}/login?${new URLSearchParams({ display: "qrLogin", service: "https://qrcode.nju.edu.cn:443/api/h5" })}`;
export interface LoginAttempt extends CookieSession { uuid: string; execution: string; createdAt: number; image: string; }

export async function startAuthorization(request = fetch): Promise<LoginAttempt> {
	const attempt: LoginAttempt = { uuid: "", execution: "", createdAt: Date.now(), image: "" };
	const html = await (await universityRequest(attempt, login, {}, request)).text();
	attempt.execution = html.match(/name="execution"\s+value="([^"]+)"/)?.[1] ?? "";
	if (!attempt.execution) throw new CampusError(502, "无法创建学校登录会话");
	attempt.uuid = (await (await universityRequest(attempt, `${auth}/qrCode/getToken`, {}, request)).text()).trim();
	if (!/^[A-Za-z0-9_-]{10,128}$/.test(attempt.uuid)) throw new CampusError(502, "无法创建登录二维码");
	const response = await universityRequest(attempt, `${auth}/qrCode/getCode?${new URLSearchParams({ uuid: attempt.uuid })}`, {}, request);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (!response.ok || bytes.length > 64_000 || bytes[0] !== 137 || bytes[1] !== 80) throw new CampusError(502, "登录二维码图片异常");
	attempt.image = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
	return attempt;
}
export async function authorizationStatus(attempt: LoginAttempt, state: Credentials, request = fetch) {
	if (Date.now() - attempt.createdAt > 180_000) return { status: "expired" as const };
	const status = (await (await universityRequest(attempt, `${auth}/qrCode/getStatus.htl?${new URLSearchParams({ uuid: attempt.uuid })}`, {}, request)).text()).trim();
	if (status === "3") return { status: "expired" as const };
	if (status !== "1") return { status: status === "2" ? "scanned" as const : "waiting" as const };
	const body = new URLSearchParams({ uuid: attempt.uuid, execution: attempt.execution, cllt: "qrLogin", dllt: "generalLogin",
		lt: "", _eventId: "submit", rmShown: "1", rememberMe: "true" });
	await universityRequest(attempt, login, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, request);
	const next = { ...state, cookies: attempt.cookies, jwt: "", jwtExpiresAt: 0 };
	next.ticket = await campusTicket(next, request);
	await renewCredentials(next, request);
	if (!next.owner) {
		const owner = JSON.parse(atob(next.jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).stuempno;
		if (typeof owner !== "string" || !owner || owner.length > 128) throw new CampusError(502, "学校未返回有效账号");
		next.owner = owner;
	}
	await campusCode(next, request); // Verify the real account before replacing the working credentials.
	return { status: "authorized" as const, credentials: next };
}
