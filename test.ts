import assert from "node:assert/strict";
import { passwordMatches, sessionToken, validSession } from "./src/auth.ts";
import { campusCode, campusTicket, CampusError, initialCredentials, jwtExpiry, type Credentials } from "./src/campus.ts";
import { startAuthorization, authorizationStatus } from "./src/authorize.ts";

const secret = "test-session-key-that-is-not-a-real-secret";
const now = Date.now();
const token = await sessionToken(secret, now);
assert(await validSession(token, secret, now));
assert(!await validSession(token + "x", secret, now));
assert(!await validSession(token, secret + "x", now));
assert(!await validSession(token, secret, now + 86400_000));
assert(await passwordMatches("correct", "correct", secret));
assert(!await passwordMatches("wrong", "correct", secret));

const jwt = `test.${btoa(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, stuempno: "synthetic-owner" }))}.test`;
assert(jwtExpiry(jwt) > now);
const state: Credentials = { seed: "test", owner: "synthetic-owner", ticket: "old-ticket", jwt: "", jwtExpiresAt: 0 };
const paths: string[] = [];
const mock = (async (url: string | URL | Request, init: RequestInit) => {
	const path = new URL(String(url)).pathname;
	paths.push(path);
	if (path.endsWith("qrexchange")) return Response.json({ jwt, ticket: "renewed-ticket" });
	assert.equal(new Headers(init.headers).get("Authorization"), jwt);
	assert.equal(new Headers(init.headers).get("Ticket"), "renewed-ticket");
	return Response.json({ type: "i", qrcode: "iVBORw0KGgo=", stuempno: state.owner, ticket: "latest-ticket", timestamp: "synthetic-time" });
}) as typeof fetch;
const code = await campusCode(state, mock, () => now);
assert.deepEqual(paths, ["/code/v1/qrexchange", "/code/v1/qrcode"]);
assert.equal(state.ticket, "latest-ticket");
assert.equal(state.renewals, 1);
assert.equal(code.displayUntil - code.issuedAt, 30000);
assert(code.image.startsWith("data:image/png;base64,"));
assert(!("ticket" in code) && !("jwt" in code));

let calls = 0;
const retryMock = (async (url: string | URL | Request) => {
	if (String(url).endsWith("qrexchange")) return Response.json({ jwt, ticket: "fresh-ticket" });
	if (++calls === 1) return new Response(null, { status: 401 });
	return Response.json({ type: "i", qrcode: "iVBORw0KGgo=", stuempno: state.owner });
}) as typeof fetch;
await campusCode(state, retryMock, () => now);
assert.equal(calls, 2);
assert.equal(state.renewals, 2);
await assert.rejects(campusCode(state, (async () => Response.json({ stuempno: "different-owner" })) as typeof fetch), (e: unknown) => e instanceof CampusError && e.message === "校园码账号不匹配");
await assert.rejects(campusCode(state, (async () => new Response(null, { status: 503 })) as typeof fetch), (e: unknown) => e instanceof CampusError && e.status === 502);
state.cookies = [{ host: "authserver.nju.edu.cn", name: "CASTGC", value: "synthetic-cookie", path: "/authserver" }];
const casPaths: string[] = [];
const casMock = (async (url: string | URL | Request, init: RequestInit) => {
	const u = new URL(String(url)); casPaths.push(u.pathname);
	if (u.pathname === "/api/h5") return new Response(null, { status: 302, headers: { Location: "https://authserver.nju.edu.cn/authserver/login" } });
	if (u.hostname === "authserver.nju.edu.cn") {
		assert(new Headers(init.headers).get("Cookie")?.includes("CASTGC=synthetic-cookie"));
		return new Response(null, { status: 302, headers: { Location: "https://qrcode.nju.edu.cn/api/check" } });
	}
	assert(!new Headers(init.headers).get("Cookie")?.includes("CASTGC"));
	return new Response("synthetic-renewal-ticket", { headers: { "Set-Cookie": "SESSION=synthetic; Path=/api/; HttpOnly" } });
}) as typeof fetch;
assert.equal(await campusTicket(state, casMock), "synthetic-renewal-ticket");
assert(state.cookies.some(c => c.host === "qrcode.nju.edu.cn" && c.name === "SESSION"));
await assert.rejects(campusTicket(state, (async () => new Response(null, { status: 302, headers: { Location: "https://untrusted.example/" } })) as typeof fetch), (e: unknown) => e instanceof CampusError && e.message === "校园码登录跳转异常");
let scanStatus = "0";
let loginPosted = false;
const loginMock = (async (url: string | URL | Request, init: RequestInit) => {
	const path = new URL(String(url)).pathname;
	if (path === "/authserver/login") {
		if (init.method === "POST") {
			assert.equal(new URLSearchParams(String(init.body)).get("uuid"), "synthetic-authorization-uuid");
			loginPosted = true;
		}
		return new Response('<input name="execution" value="e1s1">', { headers: { "Set-Cookie": "JSESSIONID=synthetic; Path=/authserver; HttpOnly" } });
	}
	if (path.endsWith("getToken")) return new Response("synthetic-authorization-uuid");
	if (path.endsWith("getCode")) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
	if (path.endsWith("getStatus.htl")) return new Response(scanStatus);
	if (path === "/api/h5") return new Response("authorized page");
	if (path === "/api/check") return new Response("synthetic-renewal-ticket");
	if (path.endsWith("qrexchange")) return Response.json({ jwt, ticket: "synthetic-new-ticket" });
	if (path.endsWith("qrcode")) return Response.json({ stuempno: state.owner, type: "i", qrcode: "iVBORw0KGgo=" });
	throw new Error("Unexpected request");
}) as typeof fetch;
const attempt = await startAuthorization(loginMock);
assert(attempt.image.startsWith("data:image/png;base64,"));
assert.equal((await authorizationStatus(attempt, state, loginMock)).status, "waiting");
assert(!loginPosted);
scanStatus = "2";
assert.equal((await authorizationStatus(attempt, state, loginMock)).status, "scanned");
scanStatus = "1";
const previousTicket = state.ticket;
const authorized = await authorizationStatus(attempt, state, loginMock);
assert.equal(authorized.status, "authorized");
assert(loginPosted);
assert.equal(state.ticket, previousTicket, "Do not replace the current session before validation succeeds");
const empty = initialCredentials();
assert.equal(empty.owner, "");
assert.equal(initialCredentials(undefined, state), state, "Keep web-authorized credentials without a bootstrap secret");
await assert.rejects(campusCode(empty, loginMock), (e: unknown) => e instanceof CampusError && e.status === 428);
const firstLogin = await authorizationStatus(attempt, empty, loginMock);
assert.equal(firstLogin.status, "authorized");
if (firstLogin.status === "authorized") assert.equal(firstLogin.credentials.owner, "synthetic-owner");
assert.equal(empty.owner, "", "Bind only after successful code retrieval");
await assert.rejects(authorizationStatus(attempt, { ...state, owner: "another-owner" }, loginMock), (e: unknown) => e instanceof CampusError && e.message === "校园码账号不匹配");
scanStatus = "3";
assert.equal((await authorizationStatus(attempt, state, loginMock)).status, "expired");
state.jwtExpiresAt = 0;
let exchanges = 0;
const fallbackMock = (async (url: string | URL | Request, init: RequestInit) => {
	if (String(url).endsWith("qrexchange")) return ++exchanges === 1
		? Response.json({ code: 401, message: "JWT或签名校验错误！" }, { status: 400 })
		: Response.json({ jwt, ticket: "synthetic-recovered-ticket" });
	if (String(url).endsWith("qrcode")) return Response.json({ stuempno: state.owner, type: "i", qrcode: "iVBORw0KGgo=" });
	return casMock(url, init);
}) as typeof fetch;
await campusCode(state, fallbackMock, () => now);
assert.equal(exchanges, 2, "HTTP 400 with JSON code 401 must recover through CAS");
console.log("PASS: password/session security, expiry, JWT renewal, CAS recovery, owner matching, safe QR response, online scan authorization");
