/* Pixelify SEO engagement — scroll depth + engaged-content views.
 * Runs in the storefront DOM (the Web Pixel sandbox can't see scroll), detects milestones, and
 * beacons them to the app proxy /track, which forwards them server-side to GA4 / sGTM as
 * `scroll` / `engaged_view` events. Consent-gated; never throws. ~1KB, no dependencies. */
(function () {
  var cfg = window.__pxpSeo || {};
  var base = (cfg.base || "/apps/pixelify-seo").replace(/\/$/, "");
  var endpoint = base + "/track";

  // Durable first-party id (pxp_id). The app proxy mints one (or echoes the one we send back) and also
  // returns a Set-Cookie — but Shopify's App Proxy does NOT reliably pass Set-Cookie through to the
  // browser, so we cannot depend on it: we persist the id returned in the JSON body ourselves.
  //
  //   * If the server's Set-Cookie DOES land, that cookie wins and is genuinely ITP-proof (server-set
  //     cookies aren't capped by Safari's 7-day script-cookie rule) — we never overwrite it.
  //   * If it doesn't (the normal App Proxy case), this JS cookie carries the id instead. It IS subject
  //     to the 7-day cap on Safari, but a 7-day stable id beats no id at all, and on Chrome/Firefox it
  //     lasts the full 400 days.
  //
  // Either way the id is stable: once persisted we send it back, and the server echoes the same one.
  // The pixel reads this cookie, and /track reads it server-side, so both paths carry ONE id.
  function readPxpId() {
    var m = document.cookie.match(/(?:^|;\s*)pxp_id=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  try {
    if (window.fetch) {
      fetch(base + "/id", { credentials: "same-origin", keepalive: true })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (d) {
          // Only write if the server's own Set-Cookie didn't land — never clobber the ITP-proof one.
          if (d && d.id && !readPxpId()) {
            document.cookie = "pxp_id=" + encodeURIComponent(d.id) + "; Path=/; Max-Age=34560000; SameSite=Lax; Secure";
          }
        })
        // Fire the visit beacon AFTER the id is ensured, so the pxp_id cookie rides along on the /visit
        // request (the server reads it there to stitch identity). Runs even if /id failed — we still link
        // whatever _ga id exists. Guarded once-per-session inside sendVisit.
        .then(sendVisit)
        .catch(sendVisit);
    }
  } catch (e) {
    /* best-effort — without the id we simply fall back to _ga */
  }

  // First-touch capture. The Attribution page's top-of-funnel (visitors, first-touch sources, journeys)
  // is fed by this: a lightweight /visit beacon carrying the visit's UTMs and EXTERNAL referrer plus the
  // GA client id. The server derives first-touch from it (UTMs, else referrer → organic/social/referral)
  // and links durableId ↔ clientId. It does NOT fan out to GA4, so it can't double-count page views.
  function utmFromSearch() {
    try {
      var q = new URLSearchParams(location.search);
      var u = {};
      ["source", "medium", "campaign", "term", "content"].forEach(function (k) {
        var v = q.get("utm_" + k);
        if (v) u["utm_" + k] = v;
      });
      return Object.keys(u).length ? u : null;
    } catch (e) {
      return null;
    }
  }
  // Only an EXTERNAL referrer is a new source — internal navigation (same host) would look like a
  // self-referral and pollute attribution, so drop it here rather than on the server (which only knows the
  // myshopify domain, not a custom storefront domain).
  function externalReferrer() {
    try {
      if (!document.referrer) return null;
      var r = new URL(document.referrer);
      return r.host && r.host !== location.host ? document.referrer : null;
    } catch (e) {
      return null;
    }
  }
  function sendVisit() {
    try {
      if (!analyticsAllowed() || !window.fetch) return;
      // Once per session: first-touch is preserved server-side regardless, and this avoids a write on
      // every pageview. If consent isn't granted yet we return WITHOUT marking done, so a later
      // visitorConsentCollected retry still fires.
      try {
        if (window.sessionStorage && sessionStorage.getItem("pxp_visit")) return;
      } catch (e) {
        /* private mode — just send */
      }
      fetch(base + "/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: gaClientId(), utm: utmFromSearch(), referrer: externalReferrer() }),
        credentials: "same-origin",
        keepalive: true
      })
        .then(function () {
          try {
            if (window.sessionStorage) sessionStorage.setItem("pxp_visit", "1");
          } catch (e) {
            /* ignore */
          }
        })
        .catch(function () {});
    } catch (e) {
      /* never throw on the storefront */
    }
  }

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
  // GA4 session id, from the per-property `_ga_<CONTAINER>` cookie. Two formats in the wild:
  //   GS1.1.<sessionId>.<n>...           (older)
  //   GS2.1.s<sessionId>$o9$g1$t...      (current — note the `s` prefix and $-delimiters)
  // Accept both. A correctly-configured store runs one GA4 property, so the first match is the right one.
  function gaSessionId() {
    var m = document.cookie.match(/_ga_[A-Z0-9]+=GS\d\.\d\.s?(\d+)/);
    return m ? m[1] : null;
  }

  // Carry the visitor's REAL GA4 client_id + session_id onto the cart, so they arrive on the order as
  // note attributes. orders/paid then sends the server-side purchase with the SAME pair, letting GA4 join
  // it to this browser session and inherit its traffic source. Without them a webhook conversion opens a
  // fresh, source-less session and lands in "Unassigned" — losing the channel.
  // Analytics-consent gated, once per session (and again if the session rolls), best-effort.
  function syncCartIds() {
    try {
      if (!analyticsAllowed() || !window.fetch) return;
      var cid = gaClientId();
      var sid = gaSessionId();
      if (!cid) return; // the session id is only meaningful paired with its own client id
      var stamp = cid + "|" + (sid || "");
      try {
        if (window.sessionStorage && sessionStorage.getItem("pxp_cart_ids") === stamp) return;
      } catch (e) {
        /* private mode — just re-send */
      }
      var attrs = { ga_client_id: cid };
      if (sid) attrs.ga_session_id = sid;
      fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: attrs }),
        credentials: "same-origin",
        keepalive: true
      })
        .then(function () {
          try {
            if (window.sessionStorage) sessionStorage.setItem("pxp_cart_ids", stamp);
          } catch (e) {
            /* ignore */
          }
        })
        .catch(function () {});
    } catch (e) {
      /* never throw on the storefront */
    }
  }
  // gtag may not have written _ga/_ga_* yet on a first hit, and consent may land later — so try now,
  // once shortly after, and again when the shopper's consent is collected.
  syncCartIds();
  try {
    setTimeout(syncCartIds, 3000);
    document.addEventListener("visitorConsentCollected", syncCartIds);
    // Consent may land after load; retry the visit beacon too (once-per-session guarded).
    document.addEventListener("visitorConsentCollected", sendVisit);
  } catch (e) {
    /* best-effort */
  }
  function scrollPct() {
    var h = document.documentElement;
    var scrollable = h.scrollHeight - h.clientHeight;
    if (scrollable <= 0) return 100;
    var y = window.pageYOffset || h.scrollTop || 0;
    return Math.min(100, Math.max(0, Math.round((y / scrollable) * 100)));
  }
  function send(name, params, custom) {
    if (!analyticsAllowed() || !navigator.sendBeacon) return;
    try {
      navigator.sendBeacon(
        endpoint,
        JSON.stringify({
          platforms: custom ? ["ga4", "gtm", "meta"] : undefined,
          event: {
            name: name,
            id: name + ":" + Date.now() + ":" + Math.random().toString(36).slice(2),
            timestamp: new Date().toISOString(),
            custom: custom || undefined,
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

  // Public API for the theme/agency to fire custom + lead events (RFQ, quote, sample request, finance
  // application, etc.):  window.pxp.track("generate_lead", { value: 50, currency: "GBP", form: "quote" })
  // Delivered server-side to every configured destination (GA4 as the given name / Meta mapped to a
  // standard event where known). Respects analytics consent like the engagement signals above.
  window.pxp = window.pxp || {};
  window.pxp.track = function (name, params) {
    if (typeof name === "string" && name) send(name, params && typeof params === "object" ? params : {}, true);
  };

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
