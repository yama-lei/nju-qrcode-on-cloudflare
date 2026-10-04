import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const base = new URL(process.argv[2] ?? "http://localhost:5173").origin;
const { WEB_PASSWORD } = JSON.parse(await readFile(".private/deploy-secrets.json", "utf8"));
let cookie = "";
async function post(path, body = {}, origin = base) {
	return fetch(base + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
}
assert.equal((await fetch(base)).status, 200);
assert.equal((await post("/api/code")).status, 401);
assert.equal((await post("/api/login", { password: WEB_PASSWORD }, "https://untrusted.example")).status, 403);
assert.equal((await post("/api/login", { password: "invalid-test-password" })).status, 401);
const login = await post("/api/login", { password: WEB_PASSWORD });
assert.equal(login.status, 200);
const setCookie = login.headers.get("set-cookie");
assert(setCookie.includes("HttpOnly") && setCookie.includes("Secure") && setCookie.includes("SameSite=Strict"));
cookie = setCookie.split(";")[0];
const first = await post("/api/code");
assert.equal(first.status, 200, "Authenticated code request failed");
assert(first.headers.get("Cache-Control").includes("no-store"));
const data = await first.json();
assert(data.image.startsWith("data:image/png;base64,"));
assert(!("ticket" in data) && !("jwt" in data));
assert(data.displayUntil > data.issuedAt);
await writeFile(".private/verified-code.png", Buffer.from(data.image.split(",")[1], "base64"));
const second = await post("/api/code");
assert.equal(second.status, 200);
const next = await second.json();
assert.notEqual(data.image, next.image, "Code must refresh");
const status = await (await post("/api/status")).json();
assert(status.nextKeepaliveAt > Date.now());
assert(status.jwtExpiresAt > Date.now());
assert.equal(status.lastError, null);
await writeFile(".private/verified-status.json", JSON.stringify({ base, checkedAt: new Date().toISOString(), ...status }, null, 2));
assert.equal((await post("/api/logout")).status, 200);
cookie = "";
assert.equal((await post("/api/code")).status, 401);
console.log("PASS: page, authentication, CSRF, secure cookie, real QR, refreshed QR, scheduled keepalive, no browser credentials, no cache, logout");
