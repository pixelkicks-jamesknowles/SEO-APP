// Used by babel-jest only (Vite/Remix build uses esbuild and ignores this).
// preset-react is needed for the component tests, which render real JSX under jsdom.
module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" } }],
    ["@babel/preset-react", { runtime: "automatic" }],
  ],
};
