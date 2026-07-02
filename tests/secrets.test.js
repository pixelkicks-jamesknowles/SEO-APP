import { encryptSecret, decryptSecret, readServerSideKeys, writeServerSideKeys } from "../app/lib/secrets.server.js";

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
