/**
 * PKDNS Resolver, a Ghostly mini-app (WISP 1200): `view: "full"`, opened alone, with the `internet` permission to
 * reach Pkarr relays and DNS over HTTPS resolvers. `window.ghostly` is the client's broker; the app uses its
 * `context()` (theme, language, version) and its `storage`. Opened outside Ghostly (no broker) it still runs, and
 * keeps its data in memory only.
 */
import "./style.css";
import { App } from "./ui/app";
import type { MiniAppApi } from "./vendor/miniApp";

declare global {
  interface Window {
    ghostly?: MiniAppApi;
  }
}

const root = document.getElementById("app");
if (root) void new App(root, window.ghostly ?? null).start();
