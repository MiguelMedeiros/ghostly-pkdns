// Puts what `ghostly app publish` bundles into one folder: the built dist/index.html, the icon (assets/icon.png, drawn
// by scripts/icon.mjs) and the manifest, ghostly-app.json, as it is. `ghostly app publish` takes every file in the folder it is given, so it must never be
// run on the repository itself. See README.md, "Sign and publish".
//
//   npm run build && npm run stage [-- <folder>]    (default: release/)
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = resolve(process.argv[2] ?? resolve(root, "release"));
const page = resolve(root, "dist/index.html");
if (!existsSync(page)) {
  console.error("no dist/index.html: run npm run build first");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(resolve(root, "ghostly-app.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(page, resolve(out, "index.html"));
copyFileSync(resolve(root, "assets/icon.png"), resolve(out, "icon.png"));
copyFileSync(resolve(root, "ghostly-app.json"), resolve(out, "ghostly-app.json"));
console.log(`staged PKDNS Resolver ${manifest.version} in ${out}`);
