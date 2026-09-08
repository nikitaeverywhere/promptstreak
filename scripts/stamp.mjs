// Stamps the bundle hash into index.html so a redeploy can never serve a stale
// app.js from cache — which is exactly how the page silently rendered empty.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const hash = createHash("sha256").update(readFileSync("web/app.js")).digest("hex").slice(0, 10);
const html = readFileSync("web/index.html", "utf8");
const next = html.replace(/src="\.\/app\.js(\?v=[a-f0-9]+)?"/, `src="./app.js?v=${hash}"`);
writeFileSync("web/index.html", next);
console.log(`stamped app.js?v=${hash}`);
