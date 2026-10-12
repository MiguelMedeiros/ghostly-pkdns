/**
 * The app: its data, what the person does, and the page. Views are strings (views.ts) written into `<main>`; one
 * listener at the root reads `data-action`, `data-field` and `data-change`. The page never navigates: no link has an
 * address, no form submits, and views change in memory only (a navigation would end the app in the runner).
 */
import { BackupError, exportData, importData } from "../lib/backup";
import { DOH, dohLookup, domainOf } from "../lib/doh";
import { getLocale, isRtl, pickLocale, setLocale, t } from "../lib/i18n";
import {
  type AppData, type Resolution, RelayError, activeRelays, addFavorite, addHistory, addLatency, addRecent, addRelay, cached, cleanSettings,
  defaultRelays, emptyData, removeFavorite, removeRelay, renameFavorite, toggleRelay, withCached, withSeen,
} from "../lib/model";
import { extractPkarrKey } from "../lib/pkarr";
import { resolveFromRelays, testRelay } from "../lib/resolver";
import { historyCsv } from "../lib/stats";
import { Store, brokerBackend, memoryBackend } from "../lib/store";
import type { MiniAppApi, MiniAppContext } from "../vendor/miniApp";
import { type DialogSpec, type Ui, type ViewName, dialogBody, renderDialog, renderBar, renderNav, renderView } from "./views";

/** How long a relay test waits. */
const TEST_TIMEOUT_MS = 10_000;
const HISTORY_PAGE = 50;
/** style.css: the page's side padding, a card's padding, the gap of the two-column grid and where it starts. */
const LAYOUT = { card: 16, gap: 16, twoColumns: 760 };
/** style.css: up to this width the tabs give way to the bar at the bottom. */
const PHONE_MAX = 480;

type DialogHandler = (action: string, root: HTMLElement) => boolean | void | Promise<boolean | void>;

export class App {
  data: AppData = emptyData();
  ui: Ui = {
    view: "resolver", query: "", busy: false, result: null, favoritesQuery: "", favoritesSort: "newest", recentQuery: "", historyKey: "",
    historyShown: HISTORY_PAGE, relayInput: "", relayError: "", ping: {}, countdown: 0, chartWidth: 320, persistent: false, version: "",
  };
  private store: Store;
  private readonly nav: HTMLElement;
  private readonly main: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly dialogRoot: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly tip: HTMLElement;
  private dialog: { handler: DialogHandler; opener: Element | null } | null = null;
  private resolveToken = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private context: MiniAppContext | null = null;
  private testing = false;
  private navKey = "";
  private moreOpen = false;

  constructor(private readonly root: HTMLElement, private readonly api: MiniAppApi | null, private readonly doFetch: typeof fetch = (...args) => fetch(...args)) {
    this.store = api ? new Store(brokerBackend(api), true) : new Store(memoryBackend(), false);
    this.ui.persistent = this.store.persistent;
    root.innerHTML = `<header class="top"></header><main id="main"></main><div id="dock"></div><div id="dialog-root"></div><div id="toasts" role="status" aria-live="polite"></div><div id="tip" role="tooltip" hidden></div>`;
    this.nav = root.querySelector(".top")!;
    this.main = root.querySelector("#main")!;
    this.bar = root.querySelector("#dock")!;
    this.dialogRoot = root.querySelector("#dialog-root")!;
    this.toasts = root.querySelector("#toasts")!;
    this.tip = root.querySelector("#tip")!;
  }

  async start(): Promise<void> {
    this.data = await this.store.load();
    this.store.bind(() => this.data);
    this.store.onError = (code) => this.toast(code === "full" ? t("app.storageFull") : t("toast.exportFailed"), "bad");
    await this.readContext();
    this.listen();
    this.measure();
    this.render();
    this.main.querySelector<HTMLElement>("#query")?.focus();
  }

  // --- The client: theme, language, version ---

  /** The client's theme and language, asked again from time to time: the broker gives the current ones each call. */
  private async readContext(): Promise<void> {
    if (this.api) {
      try {
        this.context = await this.api.context();
      } catch {
        /* keeps the last one */
      }
    }
    this.ui.version = this.context?.version ?? "";
    const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = this.context?.theme ?? (dark ? "dark" : "light");
    const locale = pickLocale(this.data.settings.locale, this.context?.locale, typeof navigator === "undefined" ? null : navigator.language);
    const html = document.documentElement;
    const changed = html.dataset.theme !== theme || getLocale() !== locale || html.lang !== locale;
    html.dataset.theme = theme;
    setLocale(locale);
    html.lang = locale;
    html.dir = isRtl() ? "rtl" : "ltr";
    if (changed && this.main.firstChild) this.render();
  }

  // --- Rendering ---

  private measure(): boolean {
    const width = this.main.clientWidth || 360;
    const columns = width >= LAYOUT.twoColumns ? 2 : 1;
    const chartWidth = Math.max(220, Math.floor((width - LAYOUT.gap * (columns - 1)) / columns) - 2 * LAYOUT.card - 2);
    const changed = chartWidth !== this.ui.chartWidth;
    this.ui.chartWidth = chartWidth;
    return changed;
  }

  /** What identifies the focused control, to find it again in the new markup. */
  private focusMark(): { id: string; action: string; arg: string; start: number | null; end: number | null } | null {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !this.root.contains(el) || el === document.body) return null;
    const input = el instanceof HTMLInputElement && /^(text|search|url)$/.test(el.type) ? el : null;
    return { id: el.id, action: el.dataset.action ?? el.dataset.change ?? "", arg: el.dataset.arg ?? "", start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null };
  }

  private restoreFocus(mark: ReturnType<App["focusMark"]>): void {
    if (!mark) return;
    let target: HTMLElement | null = mark.id ? this.root.querySelector<HTMLElement>(`#${mark.id}`) : null;
    if (!target && mark.action) {
      for (const el of this.root.querySelectorAll<HTMLElement>("[data-action],[data-change]")) {
        if ((el.dataset.action ?? el.dataset.change) === mark.action && (el.dataset.arg ?? "") === mark.arg) {
          target = el;
          break;
        }
      }
    }
    if (!target) return;
    target.focus({ preventScroll: true });
    if (target instanceof HTMLInputElement && mark.start !== null) {
      try {
        target.setSelectionRange(mark.start, mark.end);
      } catch {
        /* a field that has no selection */
      }
    }
  }

  render(): void {
    const mark = this.focusMark();
    this.hideTip();
    // The tabs are written again only when they change, so the strip keeps its scroll position on a phone.
    const navKey = `${getLocale()} ${this.ui.view}`;
    if (navKey !== this.navKey) {
      this.navKey = navKey;
      this.nav.innerHTML = renderNav(this.ui.view);
      this.bar.innerHTML = renderBar(this.ui.view, this.moreOpen);
      const tabs = this.nav.querySelector<HTMLElement>(".tabs");
      const active = this.nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (tabs && active && tabs.scrollWidth > tabs.clientWidth) {
        const middle = active.offsetLeft - tabs.offsetLeft + active.offsetWidth / 2 - tabs.clientWidth / 2;
        tabs.scrollLeft = isRtl() ? Math.min(0, middle) : Math.max(0, middle);
      }
    }
    this.main.innerHTML = renderView(this.data, this.ui);
    this.restoreFocus(mark);
  }

  /** Only the part of the page under a search field, so the field being typed in is never replaced. */
  private renderRegion(): void {
    const fresh = document.createElement("template");
    fresh.innerHTML = renderView(this.data, this.ui);
    const from = fresh.content.querySelector("#region");
    const to = this.main.querySelector("#region");
    if (from && to) to.replaceChildren(...Array.from(from.childNodes));
    else this.render();
  }

  /** The phone's "More" sheet. The page behind it is out of reach while it is open; the bar stays in reach. */
  private setMore(open: boolean, focus = true): void {
    if (open === this.moreOpen) return;
    this.moreOpen = open;
    this.bar.innerHTML = renderBar(this.ui.view, open);
    this.main.inert = open;
    this.nav.inert = open;
    if (focus) this.bar.querySelector<HTMLElement>(open ? ".sheet-item" : '[data-action="more"]')?.focus({ preventScroll: true });
  }

  private go(view: ViewName): void {
    const fromMore = this.moreOpen;
    this.setMore(false, false);
    this.ui.view = view;
    this.ui.relayError = "";
    this.ui.historyShown = HISTORY_PAGE;
    this.measure();
    this.render();
    this.schedule();
    // A page picked in the sheet leaves the focus on "More", which now marks it.
    const more = fromMore ? this.bar.querySelector<HTMLElement>('[data-action="more"][aria-current]') : null;
    (more ?? this.main.querySelector<HTMLElement>("h1"))?.focus({ preventScroll: true });
    try {
      window.scrollTo(0, 0);
    } catch {
      /* no window to scroll */
    }
  }

  toast(text: string, tone: "good" | "bad" | "" = "good"): void {
    const el = document.createElement("div");
    el.className = `toast ${tone}`;
    el.textContent = text;
    this.toasts.replaceChildren(el);
    setTimeout(() => el.remove(), 3500);
  }

  // --- Dialogs ---

  private openDialog(spec: DialogSpec, handler: DialogHandler): void {
    this.setMore(false, false);
    this.dialog = { handler, opener: document.activeElement };
    this.dialogRoot.innerHTML = renderDialog(spec);
    this.main.inert = true;
    this.nav.inert = true;
    this.bar.inert = true;
    const first = this.dialogRoot.querySelector<HTMLElement>("input:not([type=file]),textarea") ?? this.dialogRoot.querySelector<HTMLElement>(".dialog-buttons .btn:last-child");
    first?.focus();
    if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) first.select();
  }

  private closeDialog(): void {
    const opener = this.dialog?.opener;
    this.dialog = null;
    this.dialogRoot.replaceChildren();
    this.main.inert = false;
    this.nav.inert = false;
    this.bar.inert = false;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    else this.main.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }

  private async dialogAction(action: string): Promise<void> {
    if (!this.dialog) return;
    if (action === "cancel") return this.closeDialog();
    const keepOpen = await this.dialog.handler(action, this.dialogRoot);
    if (keepOpen !== true) this.closeDialog();
  }

  private confirm(title: string, message: string, confirmLabel: string, onConfirm: () => void, detail = ""): void {
    this.openDialog({ title, body: dialogBody.message(message, detail), buttons: [{ action: "cancel", label: t("common.cancel") }, { action: "ok", label: confirmLabel, kind: "danger" }] }, () => {
      // The dialog closes first, so the page is drawn with the focus already back on it.
      queueMicrotask(onConfirm);
    });
  }

  /** A text to copy, shown in full: where the clipboard is refused, the person selects it. */
  private showText(title: string, description: string, text: string): void {
    this.openDialog({ title, body: dialogBody.text(description, text), buttons: [{ action: "cancel", label: t("common.cancel") }, { action: "copy", label: t("common.copy"), kind: "brand" }] }, async (_action, root) => {
      const area = root.querySelector<HTMLTextAreaElement>("#dialog-text")!;
      if (await this.copy(area.value, area)) this.toast(t("app.copied"));
      else this.toast(t("app.copyManually"), "");
      return true;
    });
  }

  // --- Clipboard ---

  /** Copies a text. In the runner's frame the Clipboard API is refused, so the old command is tried next. */
  private async copy(text: string, field?: HTMLInputElement | HTMLTextAreaElement): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* not allowed here */
    }
    try {
      const area = field ?? document.createElement("textarea");
      if (!field) {
        area.value = text;
        area.setAttribute("readonly", "");
        area.className = "offscreen";
        this.root.appendChild(area);
      }
      const active = document.activeElement;
      area.focus({ preventScroll: true });
      area.select();
      const ok = document.execCommand("copy");
      if (!field) {
        area.remove();
        if (active instanceof HTMLElement) active.focus({ preventScroll: true });
      }
      return ok;
    } catch {
      return false;
    }
  }

  private async copyOrShow(text: string, toastKey: string): Promise<void> {
    if (await this.copy(text)) this.toast(t(toastKey));
    else this.showText(t("common.copy"), t("app.copyManually"), text);
  }

  // --- Resolving ---

  private submit(): void {
    const text = this.ui.query.trim();
    if (!text) return this.toast(t("toast.pleaseEnterKey"), "bad");
    const key = extractPkarrKey(text);
    if (key) return void this.resolveKey(key);
    if (domainOf(text)) return void this.lookup(text);
    this.toast(t("toast.invalidKey"), "bad");
  }

  async resolveKey(key: string, skipCache = false): Promise<void> {
    const token = ++this.resolveToken;
    if (this.ui.view !== "resolver") {
      this.ui.view = "resolver";
      window.scrollTo(0, 0);
    }
    this.ui.query = key;
    const now = Date.now();
    const hit = skipCache ? null : cached(this.data.cache, key, this.data.settings.cacheTtlMs, now);
    let resolution: Resolution | null = null;
    if (hit) {
      resolution = { ...hit.resolution, fromCache: true, outcomes: [] };
    } else {
      this.ui.busy = true;
      this.ui.result = null;
      this.render();
      this.schedule();
      const result = await resolveFromRelays(key, activeRelays(this.data.relays), { timeoutMs: this.data.settings.requestTimeoutMs, newestSeenMicros: this.data.seen[key], fetch: this.doFetch }).catch(() => null);
      if (token !== this.resolveToken) return;
      this.ui.busy = false;
      if (!result || result.status !== "found") {
        this.ui.result = { kind: "key-missing", key, failed: !result || result.status === "failed", outcomes: result ? result.outcomes : [] };
        return this.render();
      }
      resolution = result.resolution;
      this.data.seen = withSeen(this.data.seen, key, resolution.timestampMicros);
      this.store.save("seen");
      if (this.data.settings.cacheTtlMs > 0) {
        this.data.cache = withCached(this.data.cache, resolution);
        this.store.save("cache");
      }
    }
    this.data.recent = addRecent(this.data.recent, key);
    this.data.history = addHistory(this.data.history, {
      key, resolvedAt: Date.now(), rawSize: resolution.rawSize, responseTimeMs: resolution.fromCache ? 0 : resolution.responseTimeMs, relay: resolution.relay,
      fromCache: resolution.fromCache, recordCount: resolution.records.length,
    });
    this.store.save("recent", "history");
    this.ui.result = { kind: "key", resolution };
    this.render();
    this.schedule();
  }

  private async lookup(text: string): Promise<void> {
    const token = ++this.resolveToken;
    this.ui.busy = true;
    this.ui.result = null;
    this.render();
    try {
      const result = await dohLookup(text, DOH[this.data.settings.dohProvider], this.data.settings.requestTimeoutMs, this.doFetch);
      if (token !== this.resolveToken) return;
      this.ui.result = { kind: "dns", result };
    } catch {
      if (token !== this.resolveToken) return;
      this.ui.result = { kind: "error", message: `${t("app.lookupFailed")} · ${DOH[this.data.settings.dohProvider].name}` };
    }
    this.ui.busy = false;
    this.render();
  }

  // --- Relays ---

  private async testOne(url: string): Promise<void> {
    this.ui.ping[url] = { status: "testing" };
    if (this.ui.view === "relays") this.render();
    try {
      const ms = await testRelay(url, TEST_TIMEOUT_MS, this.doFetch);
      this.ui.ping[url] = { status: "online", ms };
      this.data.latency = addLatency(this.data.latency, url, { ms, time: Date.now() });
      this.store.save("latency");
    } catch {
      this.ui.ping[url] = { status: "offline" };
    }
    if (this.ui.view === "relays") this.render();
  }

  private async testAll(): Promise<void> {
    if (this.testing) return;
    this.testing = true;
    try {
      await Promise.all(this.data.relays.filter((r) => r.enabled).map((r) => this.testOne(r.url)));
    } finally {
      this.testing = false;
    }
  }

  /** The auto-refresh timer: it runs only on the Relays page, with the setting on, and while the page is visible. */
  private schedule(): void {
    const wanted = this.ui.view === "relays" && this.data.settings.autoRefresh;
    if (!wanted) {
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      this.ui.countdown = 0;
      return;
    }
    if (this.refreshTimer) return;
    this.ui.countdown = this.data.settings.autoRefreshSeconds;
    void this.testAll();
    this.refreshTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      this.ui.countdown -= 1;
      if (this.ui.countdown <= 0) {
        this.ui.countdown = this.data.settings.autoRefreshSeconds;
        void this.testAll();
      }
      const line = this.main.querySelector("#countdown");
      if (line) line.textContent = t("relays.nextTestIn", { seconds: this.ui.countdown });
    }, 1000);
  }

  private restartSchedule(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.schedule();
  }

  private relayProblem(error: unknown): string {
    const code = error instanceof RelayError ? error.code : "invalid";
    const key = { empty: "relays.enterRelayUrl", invalid: "relays.invalidUrl", "not-https": "app.httpsOnly", exists: "app.relayExists", "too-many": "app.tooManyRelays", "last-enabled": "app.lastRelay" }[code as string];
    return t(key ?? "relays.invalidUrl");
  }

  // --- What the person does ---

  private act(action: string, arg: string, el: HTMLElement): void {
    const d = this.data;
    switch (action) {
      case "go":
        return this.go(arg as ViewName);
      case "more":
        return this.setMore(!this.moreOpen);
      case "more-close":
        return this.setMore(false);
      case "resolve":
        return this.submit();
      case "clear-query":
        this.resolveToken++;
        this.ui.query = "";
        this.ui.result = null;
        this.ui.busy = false;
        this.render();
        return this.main.querySelector<HTMLElement>("#query")?.focus();
      case "resolve-key":
        return void this.resolveKey(arg);
      case "refresh":
        return void this.resolveKey(arg, true);
      case "copy":
        return void this.copyOrShow(arg, el.dataset.toast ?? "toast.keyCopied");
      case "open-link":
        return this.openDialog({ title: t("app.openLinkTitle"), body: dialogBody.link(arg), buttons: [{ action: "cancel", label: t("common.cancel") }, { action: "copy", label: t("app.copyLink"), kind: "brand" }] }, async (_a, root) => {
          const field = root.querySelector<HTMLInputElement>("#dialog-text")!;
          if (await this.copy(field.value, field)) this.toast(t("app.copied"));
          else this.toast(t("app.copyManually"), "");
          return true;
        });
      case "favorite":
      case "edit-favorite": {
        const existing = d.favorites.find((f) => f.key === arg);
        return this.openDialog(
          { title: t(existing ? "favorites.editLabel" : "modal.addToFavorites"), body: dialogBody.label(arg, existing?.label ?? ""), buttons: [{ action: "cancel", label: t("common.cancel") }, { action: "save", label: t("common.save"), kind: "brand" }] },
          (_a, root) => {
            const label = root.querySelector<HTMLInputElement>("#dialog-input")!.value;
            d.favorites = existing ? renameFavorite(d.favorites, arg, label) : addFavorite(d.favorites, arg, label);
            this.store.save("favorites");
            this.toast(t(existing ? "toast.labelUpdated" : "toast.addedToFavorites"));
            queueMicrotask(() => this.render());
          },
        );
      }
      case "unfavorite":
        d.favorites = removeFavorite(d.favorites, arg);
        this.store.save("favorites");
        this.toast(t("toast.removedFromFavorites"));
        return this.render();
      case "ask-unfavorite":
        return this.confirm(t("favorites.removeFavorite"), t("favorites.removeFavoriteMsg"), t("common.remove"), () => this.act("unfavorite", arg, el), d.favorites.find((f) => f.key === arg)?.label || arg);
      case "ask-remove-recent":
        return this.confirm(t("recent.removeEntryTitle"), t("recent.removeEntryMsg"), t("common.remove"), () => {
          d.recent = d.recent.filter((e) => e.key !== arg);
          this.store.save("recent");
          this.toast(t("toast.entryRemoved"));
          this.render();
        }, arg);
      case "ask-clear-recent":
        return this.confirm(t("recent.clearAllTitle"), t("recent.clearAllMsg"), t("common.clearAll"), () => {
          d.recent = [];
          this.store.save("recent");
          this.toast(t("toast.historyCleared"));
          this.render();
        });
      case "history-of":
        this.ui.historyKey = arg;
        return this.go("history");
      case "history-more":
        this.ui.historyShown += HISTORY_PAGE;
        return this.render();
      case "export-csv": {
        const entries = this.ui.historyKey ? d.history.filter((e) => e.key === this.ui.historyKey) : d.history;
        return this.showText(t("history.exportCsv"), t("app.csvDesc"), historyCsv(entries));
      }
      case "ask-clear-history":
        return this.confirm(t("history.clearHistoryTitle"), t("history.clearHistoryMsg"), t("history.clearHistory"), () => {
          d.history = [];
          this.ui.historyKey = "";
          this.store.save("history");
          this.toast(t("toast.historyCleared"));
          this.render();
        });
      case "test-relay":
        return void this.testOne(arg);
      case "test-all":
        return void this.testAll();
      case "add-relay":
        try {
          d.relays = addRelay(d.relays, this.ui.relayInput);
          this.ui.relayInput = "";
          this.ui.relayError = "";
          this.store.save("relays");
          this.toast(t("toast.relayAdded"));
        } catch (error) {
          this.ui.relayError = this.relayProblem(error);
        }
        return this.render();
      case "ask-remove-relay":
        return this.confirm(t("relays.removeRelayTitle"), t("relays.removeRelayMsg"), t("common.remove"), () => {
          d.relays = removeRelay(d.relays, arg);
          delete this.ui.ping[arg];
          const { [arg]: _gone, ...latency } = d.latency;
          d.latency = latency;
          this.store.save("relays", "latency");
          this.toast(t("toast.relayRemoved"));
          this.render();
        }, arg);
      case "ask-reset-relays":
        return this.confirm(t("relays.resetRelaysTitle"), t("relays.resetRelaysMsg"), t("common.reset"), () => {
          d.relays = defaultRelays();
          this.ui.ping = {};
          this.store.save("relays");
          this.toast(t("toast.relaysReset"));
          this.render();
        });
      case "clear-cache":
        d.cache = {};
        this.store.save("cache");
        this.toast(t("toast.cacheCleared"));
        return this.render();
      case "export-data":
        return this.showText(t("common.export"), t("app.exportDesc"), JSON.stringify(exportData(d), null, 2));
      case "import-data":
        return this.openImport();
      case "ask-clear-all":
        return this.confirm(t("settings.clearAllDataTitle"), t("settings.clearAllDataMsg"), t("settings.clearEverything"), () => void this.clearAll());
    }
  }

  private openImport(): void {
    this.openDialog({ title: t("common.import"), body: dialogBody.import(), buttons: [{ action: "cancel", label: t("common.cancel") }, { action: "import", label: t("common.import"), kind: "brand" }] }, (_a, root) => {
      const text = root.querySelector<HTMLTextAreaElement>("#dialog-text")!.value.trim();
      const error = root.querySelector<HTMLElement>("#dialog-error")!;
      if (!text) {
        error.textContent = t("toast.noDataToImport");
        return true;
      }
      try {
        const { data, counts } = importData(text, this.data);
        this.data = data;
        this.store.save(...Store.parts);
        const details = [`${counts.favorites} ${t("nav.favorites")}`, `${counts.recent} ${t("nav.recent")}`, `${counts.relays} ${t("relays.customRelays")}`, `${counts.history} ${t("nav.history")}`].join(", ");
        this.toast(t("toast.imported", { details }));
        this.ui.ping = {};
        queueMicrotask(() => void this.readContext().then(() => this.render()));
      } catch (e) {
        error.textContent = e instanceof BackupError ? t("toast.importFailed") : t("toast.importFailed");
        return true;
      }
    });
  }

  private async clearAll(): Promise<void> {
    this.resolveToken++;
    await this.store.clear();
    this.data = emptyData();
    this.ui = { ...this.ui, query: "", busy: false, result: null, favoritesQuery: "", recentQuery: "", historyKey: "", relayInput: "", relayError: "", ping: {} };
    await this.readContext();
    this.restartSchedule();
    this.toast(t("toast.allDataCleared"));
    this.render();
  }

  private setField(field: string, value: string): void {
    const s = this.data.settings;
    switch (field) {
      case "query": {
        this.ui.query = value;
        // The field being typed in is never replaced: only the button beside it shows or hides.
        const clear = this.main.querySelector<HTMLElement>('[data-action="clear-query"]');
        if (clear) clear.hidden = !value;
        // A whole key, typed or pasted: resolved without a press of the button.
        const key = extractPkarrKey(value);
        const shown = this.ui.result?.kind === "key" ? this.ui.result.resolution.publicKey : null;
        if (key && key !== shown && !this.ui.busy) void this.resolveKey(key);
        return;
      }
      case "favoritesQuery":
        this.ui.favoritesQuery = value;
        return this.renderRegion();
      case "recentQuery":
        this.ui.recentQuery = value;
        return this.renderRegion();
      case "relayInput":
        this.ui.relayInput = value;
        return;
      case "favoritesSort":
        this.ui.favoritesSort = value as Ui["favoritesSort"];
        return this.render();
      case "historyKey":
        this.ui.historyKey = value;
        this.ui.historyShown = HISTORY_PAGE;
        return this.render();
      case "requestTimeoutMs":
        this.data.settings = cleanSettings({ ...s, requestTimeoutMs: Number(value) });
        this.toast(t("toast.timeoutUpdated"));
        break;
      case "cacheTtlMs":
        this.data.settings = cleanSettings({ ...s, cacheTtlMs: Number(value) });
        this.toast(t(this.data.settings.cacheTtlMs ? "toast.cacheDurationUpdated" : "toast.cacheDisabled"));
        break;
      case "dohProvider":
        this.data.settings = cleanSettings({ ...s, dohProvider: value });
        break;
      case "autoRefreshSeconds":
        this.data.settings = cleanSettings({ ...s, autoRefreshSeconds: Number(value) });
        this.restartSchedule();
        break;
      case "locale":
        this.data.settings = { ...s, locale: value || null };
        this.store.save("settings");
        void this.readContext().then(() => {
          this.render();
          this.toast(t("toast.languageChanged"));
        });
        return;
      default:
        return;
    }
    this.store.save("settings");
    this.render();
  }

  private change(name: string, arg: string, checked: boolean): void {
    if (name === "toggle-relay") {
      try {
        this.data.relays = toggleRelay(this.data.relays, arg);
        this.store.save("relays");
      } catch (error) {
        this.toast(this.relayProblem(error), "bad");
      }
      return this.render();
    }
    if (name === "auto-refresh") {
      this.data.settings = { ...this.data.settings, autoRefresh: checked };
      this.store.save("settings");
      this.toast(t(checked ? "relays.autoRefreshEnabled" : "relays.autoRefreshDisabled"), checked ? "good" : "");
      this.restartSchedule();
      this.render();
    }
  }

  // --- Tooltip ---

  private showTip(target: Element): void {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    this.tip.textContent = text;
    this.tip.hidden = false;
    const box = target.getBoundingClientRect();
    const tip = this.tip.getBoundingClientRect();
    const left = Math.min(Math.max(4, box.left + box.width / 2 - tip.width / 2), window.innerWidth - tip.width - 4);
    const above = box.top - tip.height - 6;
    this.tip.style.left = `${Math.round(left + window.scrollX)}px`;
    this.tip.style.top = `${Math.round((above < 4 ? Math.min(box.bottom + 6, window.innerHeight - tip.height - 4) : above) + window.scrollY)}px`;
  }

  private hideTip(): void {
    this.tip.hidden = true;
  }

  // --- Events ---

  private listen(): void {
    const root = this.root;
    const closest = (target: EventTarget | null, selector: string) => (target instanceof Element ? target.closest<HTMLElement>(selector) : null);

    root.addEventListener("click", (event) => {
      const dialogEl = closest(event.target, "[data-dialog]");
      if (dialogEl) return void this.dialogAction(dialogEl.dataset.dialog!);
      const el = closest(event.target, "[data-action]");
      if (el && !(el as HTMLButtonElement).disabled) this.act(el.dataset.action!, el.dataset.arg ?? "", el);
    });

    root.addEventListener("input", (event) => {
      const el = event.target;
      if (el instanceof HTMLInputElement && el.dataset.field && el.type !== "checkbox") this.setField(el.dataset.field, el.value);
    });

    root.addEventListener("change", (event) => {
      const el = event.target;
      if (el instanceof HTMLSelectElement && el.dataset.field) this.setField(el.dataset.field, el.value);
      else if (el instanceof HTMLInputElement && el.dataset.change) this.change(el.dataset.change, el.dataset.arg ?? "", el.checked);
      else if (el instanceof HTMLInputElement && el.id === "dialog-file" && el.files?.[0]) {
        const file = el.files[0];
        const area = this.dialogRoot.querySelector<HTMLTextAreaElement>("#dialog-text");
        const error = this.dialogRoot.querySelector<HTMLElement>("#dialog-error");
        if (file.size > 4 * 1024 * 1024) return void (error && (error.textContent = t("toast.importFailed")));
        void file.text().then((text) => area && (area.value = text), () => error && (error.textContent = t("toast.importFailed")));
      }
    });

    root.addEventListener("keydown", (event) => {
      const el = event.target;
      if (event.key === "Escape") {
        if (this.dialog) return void this.dialogAction("cancel");
        if (this.moreOpen) return this.setMore(false);
        return this.hideTip();
      }
      if (event.key === "Enter" && el instanceof HTMLInputElement && !event.isComposing) {
        if (el.id === "query") return this.submit();
        if (el.id === "relay-input") return this.act("add-relay", "", el);
        if (el.id === "dialog-input") return void this.dialogAction("save");
      }
      // Tab stays inside an open dialog.
      if (event.key === "Tab" && this.dialog) {
        const items = Array.from(this.dialogRoot.querySelectorAll<HTMLElement>("button,input,textarea,select")).filter((i) => !(i as HTMLButtonElement).disabled);
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });

    root.addEventListener("pointerover", (event) => {
      const el = closest(event.target, "[data-tip]");
      if (el) this.showTip(el);
      else this.hideTip();
    });
    root.addEventListener("pointerleave", () => this.hideTip());
    root.addEventListener("focusin", (event) => {
      const el = closest(event.target, "[data-tip]");
      if (el) this.showTip(el);
      else this.hideTip();
    });

    let resizing: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener("resize", () => {
      if (window.innerWidth > PHONE_MAX) this.setMore(false, false);
      if (resizing) clearTimeout(resizing);
      resizing = setTimeout(() => {
        if (this.measure() && (this.ui.view === "history" || this.ui.view === "relays")) this.render();
      }, 150);
    });

    // The client's theme or language may have changed while the app was out of sight.
    const recheck = () => document.visibilityState !== "hidden" && void this.readContext();
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    setInterval(recheck, 15_000);
    window.addEventListener("pagehide", () => void this.store.flush());
  }
}

