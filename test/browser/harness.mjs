/**
 * A stand-in for the Ghostly web client, to run the built app (dist/index.html) in a real browser the way Ghostly
 * runs it: in `<iframe sandbox="allow-scripts" allow="">` of the runner page, under the network runner's policy.
 *
 * Real: the runner (app-frame.html, copied unchanged from MiguelMedeiros/ghostly, apps/web/public/app-frame.html at
 * commit 1dae43f82431e3cb1ba29524f95fce653f28ee1b), and its Content-Security-Policy header, the text of
 * NET_RUNNER_CSP in apps/web/runnerPolicy.ts at the same commit. So what the sandbox forbids fails here too.
 *
 * Stubbed: the client around it. The host page below does the broker's part of WISP 1200 (the port, `start`,
 * `writing`, `context`, `storage.*` with the bounds on keys and values, `close`), with the storage in the page's
 * memory, an app opened alone (`inChat: false`), and the theme and locale taken from the address
 * (`/?theme=light&locale=ar`). No profile, no install, no signature check of a bundle.
 *
 *   node test/browser/harness.mjs [port]      serves on http://127.0.0.1:<port>/ until stopped (default 4173)
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const root = new URL("../../", here);

export const NET_RUNNER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; connect-src https: wss:; frame-src 'none'; " +
  "worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const RUNNER_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": NET_RUNNER_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-DNS-Prefetch-Control": "off",
  "Cache-Control": "no-cache",
};

/** The host page: the frame, its one port, and the broker's answers. */
function hostPage(version) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ghostly (test host)</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><script>
(async () => {
  const params = new URLSearchParams(location.search);
  const view = { theme: params.get("theme") === "light" ? "light" : "dark", locale: params.get("locale") || "en" };
  const entry = await (await fetch("/entry")).text();
  const store = new Map();
  const bytes = (text) => new TextEncoder().encode(text).length;
  const refuse = (code) => { throw new Error(code); };
  const key = (value) => (typeof value === "string" && value.length > 0 && bytes(value) <= 256 ? value : refuse("bad-key"));
  let loads = 0;
  let port = null;
  window.__requests = [];
  window.__store = store;
  window.__setView = (next) => Object.assign(view, next);
  const answer = (type, args) => {
    switch (type) {
      case "writing": return undefined;
      case "context": return { version: ${JSON.stringify(version)}, inChat: false, peer: null, theme: view.theme, locale: view.locale };
      case "storage.get": { const k = key(args[0]); return store.has(k) ? JSON.parse(store.get(k)) : undefined; }
      case "storage.set": {
        const k = key(args[0]);
        const text = JSON.stringify(args[1]);
        if (text === undefined) refuse("bad-request");
        if (bytes(text) > 64 * 1024) refuse("too-large");
        let total = bytes(k) + bytes(text);
        for (const [k2, v2] of store) if (k2 !== k) total += bytes(k2) + bytes(v2);
        if (total > 5 * 1024 * 1024) refuse("full");
        store.set(k, text);
        return undefined;
      }
      case "storage.delete": store.delete(key(args[0])); return undefined;
      case "storage.keys": return [...store.keys()];
      case "close": window.__closed = true; return undefined;
      case "file": refuse("no-file");
      case "chat.send": refuse("not-allowed");
      default: refuse("unknown-type");
    }
  };
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");
  frame.title = "PKDNS Resolver";
  frame.addEventListener("load", () => {
    loads += 1;
    window.__loads = loads;
    // One load of the runner, one more after it writes the entry. Any other is a navigation: the app is stopped.
    if (loads > 2) { port && port.close(); frame.remove(); window.__stopped = "navigated"; return; }
    if (loads !== 1) return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event) => {
      const request = event.data;
      if (!request || typeof request.id !== "number") return;
      window.__requests.push(request.type);
      try {
        if (JSON.stringify(request).length > 64 * 1024 + 256) refuse("too-large");
        port.postMessage({ id: request.id, ok: true, value: answer(request.type, request.args || []) });
      } catch (error) {
        port.postMessage({ id: request.id, ok: false, error: error.message });
      }
    };
    frame.contentWindow.postMessage({ ghostly: "port" }, "*", [channel.port2]);
    port.postMessage({ event: "start", data: entry });
  });
  frame.src = "/app-frame-net.html";
  document.body.appendChild(frame);
})();
</script></body></html>`;
}

/** Serves the host page, the runner under its policy and the built entry. Returns the server and its address. */
export function startServer(port = 0) {
  const manifest = JSON.parse(readFileSync(new URL("ghostly-app.json", root), "utf8"));
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split(/[?#]/)[0];
    if (path === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      response.end(hostPage(manifest.version));
    } else if (path === "/app-frame-net.html") {
      response.writeHead(200, RUNNER_HEADERS);
      response.end(readFileSync(new URL("app-frame.html", here)));
    } else if (path === "/entry") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
      response.end(readFileSync(new URL("dist/index.html", root)));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.argv[2]) || 4173);
  console.log(`the test host is at ${url}/  (add ?theme=light or ?locale=ar)`);
}
