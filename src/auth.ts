const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
async function key(secret: string) {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function passwordMatches(candidate: string, expected: string, secret: string) {
	const k = await key(secret);
	const signature = await crypto.subtle.sign("HMAC", k, encoder.encode(expected));
	return crypto.subtle.verify("HMAC", k, signature, encoder.encode(candidate));
}
export async function sessionToken(secret: string, now = Date.now()) {
	const value = `${Math.floor(now / 1000) + 86400}.${crypto.randomUUID()}`;
	return `${value}.${hex(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(value)))}`;
}
export async function validSession(token: string, secret: string, now = Date.now()) {
	const parts = token.split(".");
	if (parts.length !== 3 || !/^\d{10}$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[2])) return false;
	const expiry = Number(parts[0]);
	if (expiry <= now / 1000 || expiry > now / 1000 + 86401) return false;
	const signature = Uint8Array.from(parts[2].match(/../g)!, b => parseInt(b, 16));
	return crypto.subtle.verify("HMAC", await key(secret), signature, encoder.encode(`${parts[0]}.${parts[1]}`));
}
