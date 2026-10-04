import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "nju-qr",
		compatibilityDate: "2026-10-01",
		entrypoint,
		exports: { CampusSession: exports.durableObject({ storage: "sqlite" }) },
		env: {
			WEB_PASSWORD: bindings.secret(),
			SESSION_KEY: bindings.secret(),
			CAMPUS: bindings.durableObject({ worker: "nju-qr", exportName: "CampusSession" }),
			LOGIN_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 5, period: 60 } }),
		},
	},
});
