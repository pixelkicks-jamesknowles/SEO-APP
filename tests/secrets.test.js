import { encryptSecret, decryptSecret, readServerSideKeys, writeServerSideKeys, assertEncryptionKey } from "../app/lib/secrets.server.js";

describe("encryptSecret / decryptSecret", () => {
  test("round-trips a value", () => {
    const enc = encryptSecret("super-secret-token");
    expect(enc).toMatch(/^enc:v1:/);
    expect(enc).not.toContain("super-secret-token"); // not stored in the clear
    expect(decryptSecret(enc)).toBe("super-secret-token");
  });

  test("produces a fresh IV each call (ciphertexts differ, both decrypt)", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  test("legacy plaintext (no prefix) is returned unchanged", () => {
    expect(decryptSecret('{"ga4ApiSecret":"s"}')).toBe('{"ga4ApiSecret":"s"}');
  });

  test("tampered / undecryptable ciphertext returns empty string, never throws", () => {
    const enc = encryptSecret("value");
    const tampered = enc.slice(0, -4) + "AAAA";
    expect(decryptSecret(tampered)).toBe("");
  });

  test("null / empty pass through", () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret("")).toBe("");
  });
});

describe("assertEncryptionKey", () => {
  const OLD_ENV = process.env;
  let warn;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = OLD_ENV;
    warn.mockRestore();
  });

  test("THROWS in production when the key is unset (fail-fast, no silent fallback)", () => {
    delete process.env.APP_ENCRYPTION_KEY;
    delete process.env.ALLOW_INSECURE_ENCRYPTION_FALLBACK;
    process.env.NODE_ENV = "production";
    expect(() => assertEncryptionKey()).toThrow(/APP_ENCRYPTION_KEY is not set/);
  });

  test("downgrades to a warning when the insecure fallback is explicitly allowed", () => {
    delete process.env.APP_ENCRYPTION_KEY;
    process.env.ALLOW_INSECURE_ENCRYPTION_FALLBACK = "true";
    process.env.NODE_ENV = "production";
    expect(() => assertEncryptionKey()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("APP_ENCRYPTION_KEY is not set"));
  });

  test("stays silent outside production when unset", () => {
    delete process.env.APP_ENCRYPTION_KEY;
    process.env.NODE_ENV = "development";
    expect(() => assertEncryptionKey()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  test("THROWS in production when the key is present but not 32 bytes", () => {
    process.env.APP_ENCRYPTION_KEY = "too-short";
    delete process.env.ALLOW_INSECURE_ENCRYPTION_FALLBACK;
    process.env.NODE_ENV = "production";
    expect(() => assertEncryptionKey()).toThrow(/not a valid 32-byte key/);
  });

  test("stays silent for a valid 32-byte base64 key", () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.NODE_ENV = "production";
    assertEncryptionKey();
    expect(warn).not.toHaveBeenCalled();
  });

  test("stays silent for a valid 64-char hex key", () => {
    process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
    process.env.NODE_ENV = "production";
    assertEncryptionKey();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("readServerSideKeys / writeServerSideKeys", () => {
  test("round-trips a keys object through encryption", () => {
    const stored = writeServerSideKeys({ ga4ApiSecret: "s", metaCapiToken: "t" });
    expect(stored).toMatch(/^enc:v1:/);
    expect(readServerSideKeys({ serverSideKeys: stored })).toEqual({ ga4ApiSecret: "s", metaCapiToken: "t" });
  });

  test("reads legacy plaintext JSON (pre-encryption rows)", () => {
    expect(readServerSideKeys({ serverSideKeys: '{"ga4ApiSecret":"s"}' })).toEqual({ ga4ApiSecret: "s" });
  });

  test("missing / malformed → empty object", () => {
    expect(readServerSideKeys(null)).toEqual({});
    expect(readServerSideKeys({ serverSideKeys: "" })).toEqual({});
    expect(readServerSideKeys({ serverSideKeys: "not json" })).toEqual({});
  });
});
