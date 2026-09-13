// Post-build smoke test: does the thing we actually ship start up?
//
// Why this exists: the unit suite mocks Prisma and fetch, so it can only prove the SOURCE behaves. It
// cannot catch a failure that only exists in the built bundle or in the production server — which is
// exactly the class of bug that took the app down before (`Response.json` does not exist on remix-serve's
// fetch polyfill, so every cron tick 500'd in production while dev and tests stayed green).
//
// Boots the built server against a throwaway DATABASE_URL, waits for it to answer, and asserts it
// responds at all. It does NOT need a database: we only require that the process starts and serves HTTP.
// Run after `npm run build`. Exits non-zero on failure so CI fails.
import { spawn } from "node:child_process";

const PORT = Number(process.env.SMOKE_PORT || 3999);
const BOOT_TIMEOUT_MS = 45_000;

const env = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: "production",
  DATABASE_URL: process.env.DATABASE_URL || "postgresql://smoke:smoke@127.0.0.1:5432/smoke",
  SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY || "smoke-key",
  SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET || "smoke-secret",
  SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL || `http://localhost:${PORT}`,
  SCOPES: process.env.SCOPES || "read_products",
  // The app fails fast in production without a real key — supply one so we test the boot path, not the
  // guard. 32 bytes of base64.
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64"),
};

const server = spawn("npm", ["run", "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (d) => (output += d));
server.stderr.on("data", (d) => (output += d));

const done = (code, msg) => {
  if (msg) console[code ? "error" : "log"](msg);
  if (code) console.error(`\n--- server output ---\n${output.slice(-4000)}`);
  server.kill("SIGTERM");
  setTimeout(() => process.exit(code), 100);
};

server.on("exit", (code) => {
  if (code !== null && code !== 0) done(1, `smoke: server exited early with code ${code}`);
});

const deadline = Date.now() + BOOT_TIMEOUT_MS;
async function poll() {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
      // Any HTTP response proves the bundle loaded and the server is serving. A 5xx does not: that is
      // precisely the production-only failure this exists to catch.
      if (res.status >= 500) return done(1, `smoke: server responded ${res.status} — the built bundle is broken`);
      return done(0, `smoke: OK — built server booted and responded ${res.status}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  done(1, `smoke: server did not respond within ${BOOT_TIMEOUT_MS}ms`);
}
poll();
