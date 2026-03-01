import { join } from "path";

const distDir = join(import.meta.dir, "dist");

// Build both client bundles on startup
const [hlsBuildResult, shakaBuildResult] = await Promise.all([
  Bun.build({
    entrypoints: [join(import.meta.dir, "main.ts")],
    outdir: distDir,
    target: "browser",
    minify: true,
    external: ["hls.js"],
  }),
  Bun.build({
    entrypoints: [join(import.meta.dir, "shaka-main.ts")],
    outdir: distDir,
    target: "browser",
    minify: true,
  }),
]);

if (!hlsBuildResult.success) {
  console.error("[build] hls failed:");
  for (const msg of hlsBuildResult.logs) {
    console.error(" ", msg);
  }
  process.exit(1);
}
console.log("[build] hls done —", hlsBuildResult.outputs.map((o) => o.path).join(", "));

if (!shakaBuildResult.success) {
  console.error("[build] shaka failed:");
  for (const msg of shakaBuildResult.logs) {
    console.error(" ", msg);
  }
  process.exit(1);
}
console.log("[build] shaka done —", shakaBuildResult.outputs.map((o) => o.path).join(", "));

// Copy wasm binary alongside the bundle (Bun bundler keeps the new URL() pattern
// but doesn't auto-copy the .wasm file into outdir)
const wasmSrc = join(import.meta.dir, "../../packages/web/plinth-js/wasm/plinth_core_bg.wasm");
const wasmDest = join(distDir, "plinth_core_bg.wasm");
await Bun.write(wasmDest, Bun.file(wasmSrc));
console.log("[build] Copied plinth_core_bg.wasm →", wasmDest);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Beacon endpoint
    if (req.method === "POST" && url.pathname === "/beacon") {
      const body = await req.json();
      console.log("[beacon]", JSON.stringify(body, null, 2));
      return new Response("OK", { status: 200, headers: CORS_HEADERS });
    }

    // Serve shaka.html for /shaka
    if (req.method === "GET" && url.pathname === "/shaka") {
      const file = Bun.file(join(import.meta.dir, "shaka.html"));
      return new Response(file, {
        headers: { "Content-Type": "text/html", ...CORS_HEADERS },
      });
    }

    // Serve index.html for root
    if (req.method === "GET" && url.pathname === "/") {
      const file = Bun.file(join(import.meta.dir, "index.html"));
      return new Response(file, {
        headers: { "Content-Type": "text/html", ...CORS_HEADERS },
      });
    }

    // Serve static files from dist/
    if (req.method === "GET") {
      const filePath = join(distDir, url.pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: CORS_HEADERS });
      }
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
});

console.log("[server] Listening on http://localhost:3000");
