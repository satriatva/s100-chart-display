const { defineConfig } = require("vite");

// Set BASE_PATH when the app is served from a sub-path, e.g. BASE_PATH=/s100/ npm run build
module.exports = defineConfig({
  root: "src",
  publicDir: "../public",
  base: process.env.BASE_PATH || "/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: true,
  },
});
