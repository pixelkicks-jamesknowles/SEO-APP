// Used by babel-jest only (Vite/Remix build uses esbuild and ignores this).
module.exports = {
  presets: [["@babel/preset-env", { targets: { node: "current" } }]],
};
