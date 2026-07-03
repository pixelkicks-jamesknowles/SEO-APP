import { isSafePublicHttpsUrl, fetchWithTimeout } from "../app/lib/net.server.js";

describe("isSafePublicHttpsUrl (SSRF guard for outbound URLs)", () => {
  test("accepts a public https URL", () => {
    expect(isSafePublicHttpsUrl("https://sgtm.example.com/g/collect").ok).toBe(true);
    expect(isSafePublicHttpsUrl("https://sgtm.example.com").ok).toBe(true);
  });

  test("rejects non-https", () => {
    expect(isSafePublicHttpsUrl("http://sgtm.example.com").ok).toBe(false);
    expect(isSafePublicHttpsUrl("ftp://sgtm.example.com").ok).toBe(false);
  });

  test("rejects cloud metadata + loopback + private ranges", () => {
    expect(isSafePublicHttpsUrl("https://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(isSafePublicHttpsUrl("https://127.0.0.1/collect").ok).toBe(false);
    expect(isSafePublicHttpsUrl("https://localhost/collect").ok).toBe(false);
    expect(isSafePublicHttpsUrl("https://10.0.0.5/collect").ok).toBe(false);
    expect(isSafePublicHttpsUrl("https://192.168.1.1/collect").ok).toBe(false);
    expect(isSafePublicHttpsUrl("https://172.16.0.1/collect").ok).toBe(false);
    expect(isSafePublicHttpsUrl("https://[::1]/collect").ok).toBe(false);
    expect(isSafePublicHttpsUrl("https://sgtm.internal/collect").ok).toBe(false);
  });

  test("rejects garbage", () => {
    expect(isSafePublicHttpsUrl("not a url").ok).toBe(false);
    expect(isSafePublicHttpsUrl("").ok).toBe(false);
  });
});

describe("fetchWithTimeout (outbound-request deadline)", () => {
  afterEach(() => (global.fetch = undefined));

  test("aborts a hung request once the deadline passes", async () => {
    // A fetch that never resolves on its own — it only settles when the AbortController fires.
    global.fetch = jest.fn(
      (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    await expect(fetchWithTimeout("https://slow.example.com", {}, 5)).rejects.toMatchObject({ name: "AbortError" });
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test("returns the response and does not abort when the request completes in time", async () => {
    const res = { ok: true, status: 204 };
    global.fetch = jest.fn(async (url, opts) => {
      expect(opts.signal.aborted).toBe(false);
      return res;
    });
    await expect(fetchWithTimeout("https://fast.example.com", { method: "POST" }, 1000)).resolves.toBe(res);
  });
});
