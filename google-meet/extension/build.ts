// Build script: compiles src/content.ts → content.js for the Chrome extension
// Run with: bun run build.ts

await Bun.build({
  entrypoints: ["src/content.ts"],
  outdir: ".",
  target: "browser",
  minify: true,
});

console.log("Built content.js");
