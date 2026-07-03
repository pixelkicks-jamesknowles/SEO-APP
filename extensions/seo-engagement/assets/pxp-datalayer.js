/* Pixelify GTM data layer (Pro) — storefront browse funnel.
 *
 * Pushes GA4-standard ecommerce events AND their Elevar-compatible dl_* mirrors to window.dataLayer on
 * themeable storefront pages, so a merchant's own GTM WEB container gets the full browse funnel:
 *   view_item · view_item_list · add_to_cart · view_cart · begin_checkout · user_data
 * Purchase is deliberately NOT here — Shopify's checkout is no longer themeable, so the purchase
 * conversion is delivered server-side (GA4 MP + reconciliation), never via the page data layer.
 *
 * Product/collection/cart facts come from Shopify's AJAX API (/products/<h>.js, /cart.js,
 * /collections/<h>/products.json) + interception of /cart/add — all theme-agnostic (no fragile
 * selectors). Consent-gated; never throws. Off unless the app proxy /config reports it enabled (the
 * Pro gate lives server-side, so this can't be switched on from the theme editor). No dependencies. */
(function () {
  var cfg = window.__pxpDl || {};
  var base = (cfg.base || "/apps/pixelify-seo").replace(/\/$/, "");
  window.dataLayer = window.dataLayer || [];

  // dl_* names for the Elevar-compatible mirror.
  var DL = {
    view_item: "dl_view_item",
    view_item_list: "dl_view_item_list",
    add_to_cart: "dl_add_to_cart",
    view_cart: "dl_view_cart",
    begin_checkout: "dl_begin_checkout",
    user_data: "dl_user_data",
  };

  function privacy() {
    try {
      return (window.Shopify && window.Shopify.customerPrivacy) || null;
    } catch (e) {
      return null;
    }
  }
  function analyticsAllowed() {
    var cp = privacy();
    if (!cp) return cfg.requireConsent === false; // no CMP → allow only if consent isn't required
    try {
      return !!cp.analyticsProcessingAllowed && cp.analyticsProcessingAllowed();
    } catch (e) {
      return false;
    }
  }

  var money = function (cents) { return Math.round((Number(cents) || 0)) / 100; }; // AJAX API prices are in cents
  function sumValue(items) {
    return Math.round(items.reduce(function (t, i) { return t + i.price * (i.quantity || 1); }, 0) * 100) / 100;
  }
  function currentVariantId() {
    try {
      return new URL(location.href).searchParams.get("variant");
    } catch (e) {
      return null;
    }
  }

  // --- normalizers → a common item shape { item_id,item_name,item_brand,item_category,item_variant,price,quantity,product_id,variant_id } ---
  function itemFromVariant(product, v) {
    return {
      item_id: v.sku || String(product.id),
      item_name: product.title,
      item_brand: product.vendor || undefined,
      item_category: product.type || product.product_type || undefined,
      item_variant: v.title && v.title !== "Default Title" ? v.title : undefined,
      price: money(v.price),
      quantity: 1,
      product_id: product.id,
      variant_id: v.id,
    };
  }
  function itemFromCartLine(l) {
    return {
      item_id: l.sku || String(l.product_id),
      item_name: l.product_title || l.title,
      item_brand: l.vendor || undefined,
      item_category: l.product_type || undefined,
      item_variant: l.variant_title || undefined,
      price: money(l.final_price != null ? l.final_price : l.price),
      quantity: l.quantity || 1,
      product_id: l.product_id,
      variant_id: l.variant_id || l.id,
    };
  }

  // --- push helpers: GA4-standard + the dl_* mirror ---
  function ga4Item(i) {
    return {
      item_id: i.item_id, item_name: i.item_name, item_brand: i.item_brand, item_category: i.item_category,
      item_variant: i.item_variant, price: i.price, quantity: i.quantity || 1,
    };
  }
  function dlProduct(i) {
    return {
      id: i.item_id, name: i.item_name, brand: i.item_brand, category: i.item_category, variant: i.item_variant,
      price: String(i.price), quantity: String(i.quantity || 1),
      product_id: i.product_id != null ? String(i.product_id) : undefined,
      variant_id: i.variant_id != null ? String(i.variant_id) : undefined,
    };
  }
  function userProps() {
    var c = cfg.customer;
    return {
      visitor_type: c ? "logged_in" : "guest",
      customer_id: c && c.id != null ? String(c.id) : undefined,
      customer_email: c && c.email ? c.email : undefined,
    };
  }
  // GA4: clear the previous ecommerce object first (GA4 best practice), then push the event.
  function pushGa4(event, items, extra) {
    var ecommerce = { currency: cfg.currency || undefined, value: sumValue(items), items: items.map(ga4Item) };
    if (extra) for (var k in extra) ecommerce[k] = extra[k];
    window.dataLayer.push({ ecommerce: null });
    window.dataLayer.push({ event: event, ecommerce: ecommerce });
  }
  function pushDl(dlEvent, items, block) {
    var ecommerce = { currencyCode: cfg.currency || undefined };
    ecommerce[block.key] = block.val(items.map(dlProduct));
    window.dataLayer.push({ event: dlEvent, user_properties: userProps(), ecommerce: ecommerce });
  }

  // --- events ---
  var firedCheckout = false;
  function emitUserData() {
    window.dataLayer.push({ event: DL.user_data, user_properties: userProps() });
  }
  function emitViewItem(item) {
    pushGa4("view_item", [item]);
    pushDl(DL.view_item, [item], { key: "detail", val: function (p) { return { actionField: { action: "detail" }, products: p }; } });
  }
  function emitViewItemList(items, listName) {
    pushGa4("view_item_list", items, { item_list_name: listName || undefined });
    pushDl(DL.view_item_list, items, { key: "impressions", val: function (p) { return p; } });
  }
  function emitAddToCart(item) {
    pushGa4("add_to_cart", [item]);
    pushDl(DL.add_to_cart, [item], { key: "add", val: function (p) { return { products: p }; } });
  }
  function emitViewCart(items) {
    pushGa4("view_cart", items);
    pushDl(DL.view_cart, items, { key: "cart_contents", val: function (p) { return { products: p }; } });
  }
  function emitBeginCheckout(items) {
    if (firedCheckout) return;
    firedCheckout = true;
    pushGa4("begin_checkout", items);
    pushDl(DL.begin_checkout, items, { key: "checkout", val: function (p) { return { actionField: { step: "1" }, products: p }; } });
  }

  function getJSON(url) {
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(function (r) {
      return r.ok ? r.json() : null;
    });
  }

  // --- page-load routing ---
  function routeOnLoad() {
    var path = location.pathname;
    emitUserData();
    var pm = path.match(/\/products\/([^/?#]+)/);
    if (pm) {
      getJSON("/products/" + pm[1] + ".js").then(function (p) {
        if (!p || !p.variants) return;
        var vid = currentVariantId();
        var v = (vid && p.variants.filter(function (x) { return String(x.id) === String(vid); })[0]) ||
          p.variants.filter(function (x) { return x.available; })[0] || p.variants[0];
        if (v) emitViewItem(itemFromVariant(p, v));
      }).catch(function () {});
      return;
    }
    var cm = path.match(/\/collections\/([^/?#]+)/);
    if (cm && cm[1] !== "all" && !/\/products\//.test(path)) {
      getJSON("/collections/" + cm[1] + "/products.json?limit=24").then(function (d) {
        if (!d || !d.products) return;
        var items = d.products.map(function (p) {
          var v = (p.variants && p.variants[0]) || {};
          return {
            item_id: v.sku || String(p.id), item_name: p.title, item_brand: p.vendor || undefined,
            item_category: p.product_type || undefined, item_variant: undefined,
            price: parseFloat(v.price) || 0, quantity: 1, product_id: p.id, variant_id: v.id,
          };
        });
        if (items.length) emitViewItemList(items, cm[1]);
      }).catch(function () {});
      return;
    }
    if (/^\/cart\/?$/.test(path)) {
      getJSON("/cart.js").then(function (c) {
        if (c && c.items && c.items.length) emitViewCart(c.items.map(itemFromCartLine));
      }).catch(function () {});
    }
  }

  // --- add_to_cart: intercept the AJAX cart API (theme-agnostic) ---
  function handleAddResponse(json) {
    if (!json) return;
    var lines = json.items && Array.isArray(json.items) ? json.items : [json];
    lines.forEach(function (l) {
      if (l && (l.id || l.variant_id)) emitAddToCart(itemFromCartLine(l));
    });
  }
  function isAddUrl(url) {
    return typeof url === "string" && /\/cart\/add(\.js)?(\?|$)/.test(url);
  }
  function isCheckoutUrl(url) {
    return typeof url === "string" && (/\/checkout(\/|\?|$)/.test(url) || /\/cart\/(checkout)/.test(url));
  }
  function installInterceptors() {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : input && input.url;
        var checkout = isCheckoutUrl(url) || (init && init.body && String(init.body).indexOf("checkout") > -1 && /\/cart/.test(url || ""));
        var add = isAddUrl(url);
        var p = origFetch.apply(this, arguments);
        if (add) p.then(function (res) { res.clone().json().then(handleAddResponse).catch(function () {}); }).catch(function () {});
        if (checkout) beginCheckoutFromCart();
        return p;
      };
    }
    var origSend = window.XMLHttpRequest && window.XMLHttpRequest.prototype.send;
    var origOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
    if (origSend && origOpen) {
      window.XMLHttpRequest.prototype.open = function (method, url) {
        this.__pxpUrl = url;
        return origOpen.apply(this, arguments);
      };
      window.XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        if (isAddUrl(xhr.__pxpUrl)) {
          xhr.addEventListener("load", function () {
            try { handleAddResponse(JSON.parse(xhr.responseText)); } catch (e) { /* not JSON */ }
          });
        }
        return origSend.apply(this, arguments);
      };
    }
    // begin_checkout: capture the classic checkout button / links too (not all themes AJAX the checkout).
    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[name="checkout"], a[href*="/checkout"], button[value~="checkout" i]') : null;
      if (t) beginCheckoutFromCart();
    }, true);
    document.addEventListener("submit", function (e) {
      var f = e.target;
      if (f && f.querySelector && f.querySelector('[name="checkout"]')) beginCheckoutFromCart();
    }, true);
  }
  function beginCheckoutFromCart() {
    getJSON("/cart.js").then(function (c) {
      if (c && c.items && c.items.length) emitBeginCheckout(c.items.map(itemFromCartLine));
    }).catch(function () {});
  }

  // --- config gate: read the effective (Pro) enabled flag, cached for the session ---
  function loadConfig() {
    try {
      var cached = sessionStorage.getItem("pxp_dl_cfg");
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed && parsed.exp > Date.now()) return Promise.resolve(parsed.v);
      }
    } catch (e) { /* sessionStorage unavailable */ }
    return getJSON(base + "/config").then(function (json) {
      var v = (json && json.dataLayer) || { enabled: false };
      try { sessionStorage.setItem("pxp_dl_cfg", JSON.stringify({ v: v, exp: Date.now() + 300000 })); } catch (e) {}
      return v;
    }).catch(function () { return { enabled: false }; });
  }

  function start() {
    if (!analyticsAllowed()) return;
    loadConfig().then(function (dl) {
      if (!dl || !dl.enabled) return;
      installInterceptors();
      routeOnLoad();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
