/* Pixelify SEO engagement — scroll depth + engaged-content views.
 * Runs in the storefront DOM (the Web Pixel sandbox can't see scroll), detects milestones, and
 * beacons them to the app proxy /track, which forwards them server-side to GA4 / sGTM as
 * `scroll` / `engaged_view` events. Consent-gated; never throws. ~1KB, no dependencies. */
(function () {
  var cfg = window.__pxpSeo || {};
  var endpoint = (cfg.base || "/apps/pixelify-seo").replace(/\/$/, "") + "/track";

  function privacy() {
    try {
      return (window.Shopify && window.Shopify.customerPrivacy) || null;
    } catch (e) {
      return null;
    }
  }
  // Strict gate: engagement signals aren't worth modelling, so only fire with analytics consent.
  // If there's no CMP and consent isn't required, allow.
  function analyticsAllowed() {
    var cp = privacy();
    if (!cp) return cfg.requireConsent === false;
    try {
      return !!cp.analyticsProcessingAllowed && cp.analyticsProcessingAllowed();
    } catch (e) {
      return false;
    }
  }
  function consentState() {
    var cp = privacy();
    if (!cp) return undefined;
    try {
      return {
        analytics: !!(cp.analyticsProcessingAllowed && cp.analyticsProcessingAllowed()),
        marketing: !!(cp.marketingAllowed && cp.marketingAllowed())
      };
    } catch (e) {
      return undefined;
    }
  }
  function gaClientId() {
    var m = document.cookie.match(/_ga=GA\d\.\d\.([\d.]+)/);
    return m ? m[1] : null;
  }
  function scrollPct() {
    var h = document.documentElement;
    var scrollable = h.scrollHeight - h.clientHeight;
    if (scrollable <= 0) return 100;
    var y = window.pageYOffset || h.scrollTop || 0;
    return Math.min(100, Math.max(0, Math.round((y / scrollable) * 100)));
  }
  function send(name, params) {
    if (!analyticsAllowed() || !navigator.sendBeacon) return;
    try {
      navigator.sendBeacon(
        endpoint,
        JSON.stringify({
          event: {
            name: name,
            id: name + ":" + Date.now() + ":" + Math.random().toString(36).slice(2),
            timestamp: new Date().toISOString(),
            params: params,
            clientId: gaClientId(),
            consent: consentState(),
            context: { document: { location: { href: location.href } } }
          }
        })
      );
    } catch (e) {
      /* best-effort */
    }
  }

  // --- Scroll depth ---
  if (cfg.scroll) {
    var thresholds = (cfg.scrollThresholds || [25, 50, 75, 100])
      .map(Number)
      .filter(function (n) { return n > 0 && n <= 100; })
      .sort(function (a, b) { return a - b; });
    var fired = {};
    var ticking = false;
    function checkScroll() {
      var p = scrollPct();
      for (var i = 0; i < thresholds.length; i++) {
        var t = thresholds[i];
        if (p >= t && !fired[t]) {
          fired[t] = true;
          send("scroll", { percent_scrolled: t });
        }
      }
      var done = thresholds.every(function (t) { return fired[t]; });
      if (done) window.removeEventListener("scroll", onScroll);
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        checkScroll();
        ticking = false;
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    checkScroll(); // short pages may already satisfy a threshold
  }

  // --- Engaged content view: visible + active for N seconds AND scrolled past X% ---
  if (cfg.engaged) {
    var needSecs = (cfg.engagedSeconds || 15) * 1000;
    var needScroll = cfg.engagedScroll || 50;
    var activeMs = 0;
    var maxScroll = 0;
    var lastTick = Date.now();
    var sent = false;
    window.addEventListener(
      "scroll",
      function () {
        var p = scrollPct();
        if (p > maxScroll) maxScroll = p;
      },
      { passive: true }
    );
    var timer = setInterval(function () {
      var now = Date.now();
      if (document.visibilityState !== "visible") {
        lastTick = now;
        return;
      }
      activeMs += now - lastTick;
      lastTick = now;
      if (!sent && activeMs >= needSecs && maxScroll >= needScroll) {
        sent = true;
        send("engaged_view", { engagement_time_msec: Math.round(activeMs), percent_scrolled: maxScroll });
        clearInterval(timer);
      }
    }, 1000);
  }
})();
