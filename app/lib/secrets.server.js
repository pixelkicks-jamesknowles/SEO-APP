// Encryption-at-rest for merchant server-side credentials (GA4 MP secret, Meta CAPI token, sGTM URL).
// These are live ad-platform write credentials — a DB dump must not leak them in plaintext.
//
// Format: "enc:v1:<iv>:<tag>:<ciphertext>" (each part base64url), AES-256-GCM. The key comes from
// APP_ENCRYPTION_KEY (32 bytes as base64 or hex); if that isn't set we derive a stable key from
// SHOPIFY_API_SECRET so the app still runs, but production should set a dedicated APP_ENCRYPTION_KEY
// so credentials survive an app-secret rotation and can be rotated independently.
//
// Legacy plaintext rows (written before encryption) are read back unchanged and re-encrypted on their
// next save — so this migrates transparently with no data migration step.
import crypto from "node:crypto";

const PREFIX = "enc:v1:";

function key() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (raw) {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  }
  // Fallback: a deterministic 32-byte key derived from the app secret (always present at runtime).
  const secret = process.env.SHOPIFY_API_SECRET || "";
  return crypto.createHash("sha256").update(`pixelify-secrets:${secret}`).digest();
}

/** Encrypt a plaintext string → "enc:v1:<iv>:<tag>:<ciphertext>". null/empty pass through. */
export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext ?? null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, enc].map((b) => b.toString("base64url")).join(":");
}

/** Decrypt a value from encryptSecret. Legacy plaintext (no prefix) is returned unchanged; a value
 *  that fails authentication (wrong/rotated key, tampering) returns "" rather than throwing. */
export function decryptSecret(value) {
  if (typeof value !== "string" || value === "") return value ?? null;
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext, pre-encryption
  try {
    const [iv, tag, enc] = value.slice(PREFIX.length).split(":").map((s) => Buffer.from(s, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/** Parse a TrackingSettings.serverSideKeys value (encrypted or legacy plaintext JSON) → object. */
export function readServerSideKeys(settings) {
  const raw = decryptSecret(settings?.serverSideKeys || "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Serialize a keys object for storage, encrypted at rest. */
export function writeServerSideKeys(keys) {
  return encryptSecret(JSON.stringify(keys || {}));
}
