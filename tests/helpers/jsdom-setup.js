// jsdom shims for component tests.
//
// jsdom implements no CSSOM media-query engine, so `window.matchMedia` is simply absent. Polaris's
// MediaQueryProvider calls it during render, so every component test throws before asserting anything.
// A static non-matching stub is correct here: these tests assert content and tone, not responsive layout.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {}, // deprecated, but Polaris still feature-detects it
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Polaris also probes ResizeObserver in a few components.
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
