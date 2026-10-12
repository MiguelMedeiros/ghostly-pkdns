/**
 * The pages, each a function from data to an HTML string. Everything that is not the app's own text goes through
 * `esc`: record names and values come from whoever published a key, relay addresses and labels from the person or a
 * backup. Buttons carry `data-action` (and `data-arg`), fields `data-field`; app.ts listens for them at the root.
 * No link has an address: a navigation would end the app (the runner allows none).
 */
import type { DohResult } from "../lib/doh";
import { DOH } from "../lib/doh";
import { LANGUAGES, escapeHtml as esc, getLocale, plural, richText, t } from "../lib/i18n";
import {
  type AppData, type Favorite, type HistoryEntry, type RelayConfig, type RelayOutcome, type Resolution, AUTO_REFRESH_CHOICES_S, CACHE_CHOICES_MS,
  DEFAULT_RELAYS, DOH_PROVIDERS, MAX_LABEL_LENGTH, TIMEOUT_CHOICES_MS, searchFavorites, searchRecent,
} from "../lib/model";
import { truncateKey } from "../lib/pkarr";
import { type DnsRecord, extractWebUrl, getPubkyProfileUrl, hasPubkyProfile } from "../lib/records";
import { historyStats, latencyStats, resolvesPerDay } from "../lib/stats";
import { barList, columnChart, lineChart } from "./charts";
import { ICON } from "./icons";

export type ViewName = "resolver" | "favorites" | "recent" | "history" | "relays" | "settings" | "how";

export type Result =
  | { kind: "key"; resolution: Resolution }
  | { kind: "key-missing"; key: string; failed: boolean; outcomes: RelayOutcome[] }
  | { kind: "dns"; result: DohResult }
  | { kind: "error"; message: string };

export interface Ui {
  view: ViewName;
  query: string;
  busy: boolean;
  result: Result | null;
  favoritesQuery: string;
  favoritesSort: "newest" | "oldest" | "az";
  recentQuery: string;
  /** The key the History page is narrowed to, or "" for all. */
  historyKey: string;
  historyShown: number;
  relayInput: string;
  relayError: string;
  /** Per relay address: its last test. */
  ping: Record<string, { status: "testing" | "online" | "offline"; ms?: number }>;
  countdown: number;
  /** The width charts are drawn at. */
  chartWidth: number;
  persistent: boolean;
  version: string;
}

// --- Formatting ---

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

const ms = (value: number) => `${Math.round(value)} ms`;
/** A figure with its unit, kept in that order inside right-to-left text. */
const figure = (text: string) => `<span class="num">${esc(text)}</span>`;

function dateTime(time: number, style: "full" | "short" = "full"): string {
  const options: Intl.DateTimeFormatOptions = style === "full" ? { dateStyle: "medium", timeStyle: "medium" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(getLocale(), options).format(time);
  } catch {
    return new Date(time).toISOString();
  }
}

function dateOnly(time: number): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(time);
}

/** "5 minutes ago", in the display language. */
export function relativeTime(time: number, now = Date.now()): string {
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto", style: "short" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  return format.format(Math.trunc(seconds / 60), "minute");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const button = (action: string, label: string, options: { arg?: string; kind?: string; icon?: string; title?: string; disabled?: boolean } = {}) =>
  `<button type="button" class="btn ${options.kind ?? ""}" data-action="${action}"${options.arg === undefined ? "" : ` data-arg="${esc(options.arg)}"`}${options.title ? ` title="${esc(options.title)}" aria-label="${esc(options.title)}"` : ""}${options.disabled ? " disabled" : ""}>${options.icon ?? ""}${label ? `<span>${esc(label)}</span>` : ""}</button>`;

const iconButton = (action: string, title: string, icon: string, arg?: string, kind = "") => button(action, "", { arg, icon, title, kind: `icon ${kind}` });

const pageHead = (title: string, subtitle: string, aside = "") =>
  `<header class="page-head"><div><h1 tabindex="-1">${esc(title)}</h1><p class="sub">${esc(subtitle)}</p></div>${aside ? `<div class="head-actions">${aside}</div>` : ""}</header>`;

const empty = (title: string, text: string, action = "") => `<div class="empty"><p class="empty-title">${esc(title)}</p><p>${esc(text)}</p>${action}</div>`;

// --- Shell ---

const NAV: [ViewName, string][] = [["resolver", "nav.resolver"], ["favorites", "nav.favorites"], ["recent", "nav.recent"], ["history", "nav.history"], ["relays", "nav.relays"], ["settings", "nav.settings"], ["how", "footer.howItWorks"]];

export function renderNav(view: ViewName): string {
  const items = NAV.map(([name, key]) => `<button type="button" class="tab" data-action="go" data-arg="${name}"${name === view ? ' aria-current="page"' : ""}>${esc(t(key))}</button>`).join("");
  return `<div class="brand">${ICON.logo}<span>${esc(t("popup.title"))}</span></div><nav class="tabs" aria-label="${esc(t("popup.title"))}">${items}</nav>`;
}

const BAR: [ViewName, string, string][] = [["resolver", "bar.resolver", ICON.search], ["favorites", "bar.favorites", ICON.starBar], ["recent", "bar.recent", ICON.clockBar], ["relays", "bar.relays", ICON.server]];
const MORE: [ViewName, string, string][] = [["history", "nav.history", ICON.chart], ["settings", "nav.settings", ICON.sliders], ["how", "footer.howItWorks", ICON.help]];

/** The phone's navigation (style.css shows it at 480 px and under): a bar of five places, and the sheet "More" opens. */
export function renderBar(view: ViewName, open: boolean): string {
  const current = (on: boolean) => (on ? ' aria-current="page"' : "");
  const inMore = MORE.some(([name]) => name === view);
  const place = (icon: string, label: string) => `<span class="dock-icon">${icon}</span><span class="dock-label">${esc(t(label))}</span>`;
  const items = BAR.map(([name, label, icon]) => `<button type="button" class="dock-item" data-action="go" data-arg="${name}"${current(name === view)}>${place(icon, label)}</button>`).join("");
  const more = `<button type="button" class="dock-item" data-action="more" aria-haspopup="dialog" aria-expanded="${open}" aria-controls="more-sheet"${current(inMore)}>${place(ICON.more, "bar.more")}</button>`;
  const sheet = open
    ? `<div class="sheet-overlay" data-action="more-close"></div><div id="more-sheet" class="sheet" role="dialog" aria-label="${esc(t("bar.more"))}"><ul>${MORE.map(
        ([name, label, icon]) => `<li><button type="button" class="sheet-item" data-action="go" data-arg="${name}"${current(name === view)}>${icon}<span>${esc(t(label))}</span></button></li>`,
      ).join("")}</ul></div>`
    : "";
  return `${sheet}<nav class="dock" aria-label="${esc(t("popup.title"))}">${items}${more}</nav>`;
}

export function renderView(data: AppData, ui: Ui): string {
  switch (ui.view) {
    case "favorites":
      return favoritesView(data, ui);
    case "recent":
      return recentView(data, ui);
    case "history":
      return historyView(data, ui);
    case "relays":
      return relaysView(data, ui);
    case "settings":
      return settingsView(data, ui);
    case "how":
      return howView(data);
    default:
      return resolverView(data, ui);
  }
}

// --- Resolver ---

/** The table of records. A value is a button that copies it. */
export function recordsTable(records: DnsRecord[]): string {
  if (!records.length) return `<p class="muted">${esc(t("resolve.noRecords"))}</p>`;
  const rows = records
    .map(
      (r) =>
        `<tr><td data-label="${esc(t("resolve.type"))}"><span class="type type-${/^[A-Z]+$/.test(r.type) ? r.type.toLowerCase() : "other"}">${esc(r.type)}</span></td>` +
        `<td data-label="${esc(t("resolve.name"))}" class="mono">${esc(r.name)}</td>` +
        `<td data-label="${esc(t("resolve.value"))}"><button type="button" class="value mono" data-action="copy" data-arg="${esc(r.value)}" data-toast="toast.valueCopied" title="${esc(t("common.copy"))}">${esc(r.value)}</button></td>` +
        `<td data-label="${esc(t("resolve.ttl"))}" class="num">${r.ttl}</td></tr>`,
    )
    .join("");
  return `<table class="records dns"><thead><tr><th>${esc(t("resolve.type"))}</th><th>${esc(t("resolve.name"))}</th><th>${esc(t("resolve.value"))}</th><th class="num">${esc(t("resolve.ttl"))}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function outcomeText(o: RelayOutcome): [string, "good" | "bad" | "quiet"] {
  if (o.status === "ok") return o.detail === "older" ? [t("app.statusOlder"), "quiet"] : [t("app.statusValid"), "good"];
  if (o.status === "not-found") return [t("app.statusNotFound"), "quiet"];
  if (o.status === "pending") return [t("app.statusPending"), "quiet"];
  if (o.status === "refused") {
    const key = { "bad-signature": "app.statusBadSignature", stale: "app.statusStale", future: "app.statusFuture", "too-large": "app.statusTooLarge" }[o.detail ?? ""] ?? "app.statusBadPacket";
    return [t(key), "bad"];
  }
  if (o.detail === "timeout") return [t("app.statusTimeout"), "bad"];
  if (o.detail?.startsWith("HTTP ")) return [o.detail, "bad"];
  return [t("app.statusUnreachable"), "bad"];
}

function outcomesCard(outcomes: RelayOutcome[]): string {
  if (!outcomes.length) return "";
  const items = outcomes
    .map((o) => {
      const [text, tone] = outcomeText(o);
      const time = o.ms !== undefined && o.status !== "pending" ? `<span class="num muted">${ms(o.ms)}</span>` : "";
      return `<li><span class="dot-${tone}" aria-hidden="true"></span><span class="mono grow">${esc(hostOf(o.relay))}</span><span class="tone-${tone}">${esc(text)}</span>${time}</li>`;
    })
    .join("");
  return `<section class="card"><h2>${esc(t("app.relayAnswers"))}</h2><ul class="outcomes">${items}</ul></section>`;
}

function keyResult(data: AppData, r: Resolution): string {
  const favorite = data.favorites.find((f) => f.key === r.publicKey);
  const site = extractWebUrl(r.records);
  const profile = hasPubkyProfile(r.records) ? getPubkyProfileUrl(r.publicKey) : null;
  const entries = data.history.filter((e) => e.key === r.publicKey);
  const stats = historyStats(entries);
  const via = `${esc(hostOf(r.relay))}${r.fromCache ? "" : ` <span class="muted num">${ms(r.responseTimeMs)}</span>`}`;
  const star = favorite
    ? iconButton("unfavorite", t("popup.removeFromFavorites"), ICON.starFilled, r.publicKey, "starred")
    : iconButton("favorite", t("popup.addToFavorites"), ICON.star, r.publicKey);
  const visit =
    (profile ? button("open-link", t("resolve.visitPubkyProfile"), { arg: profile, kind: "brand", icon: ICON.external }) : "") +
    (site ? button("open-link", t("resolve.visitWebsite"), { arg: site, kind: profile ? "" : "brand", icon: ICON.external }) : "");
  const history = entries.length
    ? `<section class="card"><h2>${esc(t("history.title"))}</h2><p>${esc(t("history.resolvedTimes", { count: entries.length }))}${
        stats.avgResponseTimeMs ? ` · ${esc(t("history.avg"))} ${ms(stats.avgResponseTimeMs)}` : ""
      }</p><div class="row">${button("history-of", t("history.viewFullHistory"), { arg: r.publicKey })}</div></section>`
    : "";
  return (
    `<section class="card result"><div class="card-top"><span class="badge good" title="${esc(t("app.verifiedDesc"))}">${ICON.check}${esc(t("app.verified"))}</span>` +
    `${r.fromCache ? `<span class="badge">${esc(t("resolve.cached"))}</span>` : ""}<span class="grow"></span>${star}${iconButton("refresh", t("app.refresh"), ICON.refresh, r.publicKey)}</div>` +
    `<p class="muted small">${esc(t("app.verifiedDesc"))}</p>` +
    `<dl class="facts">` +
    `<div class="wide"><dt>${esc(t("resolve.publicKey"))}${favorite?.label ? ` · ${esc(favorite.label)}` : ""}</dt><dd><button type="button" class="value mono" data-action="copy" data-arg="${r.publicKey}" data-toast="toast.keyCopied" title="${esc(t("common.copy"))}">${r.publicKey}</button></dd></div>` +
    `<div><dt>${esc(t("resolve.lastUpdated"))}</dt><dd>${esc(dateTime(r.timestamp))}</dd></div>` +
    `<div><dt>${esc(t("resolve.payloadSize"))}</dt><dd>${figure(formatBytes(r.rawSize))}</dd></div>` +
    `<div><dt>${esc(t("resolve.records"))}</dt><dd class="num">${r.records.length}</dd></div>` +
    `<div><dt>${esc(t("resolve.resolvedVia"))}</dt><dd>${via}</dd></div>` +
    `</dl>${visit ? `<div class="row">${visit}</div>` : ""}</section>` +
    `<section class="card"><h2>${esc(t("resolve.dnsRecords"))}</h2>${recordsTable(r.records)}</section>` +
    outcomesCard(r.outcomes) +
    history
  );
}

function dnsResult(result: DohResult): string {
  const site = result.records.some((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME" || r.type === "HTTPS") ? `https://${result.name}` : null;
  return (
    `<section class="card result"><div class="card-top"><span class="badge">DNS over HTTPS</span></div>` +
    `<p class="muted small">${esc(t("app.dohNotSigned"))}</p><dl class="facts">` +
    `<div class="wide"><dt>${esc(t("app.domain"))}</dt><dd><button type="button" class="value mono" data-action="copy" data-arg="${esc(result.name)}" data-toast="toast.valueCopied">${esc(result.name)}</button></dd></div>` +
    `<div><dt>${esc(t("app.answeredBy"))}</dt><dd>${esc(result.provider.name)} <span class="muted num">${ms(result.responseTimeMs)}</span></dd></div>` +
    `<div><dt>${esc(t("resolve.records"))}</dt><dd class="num">${result.records.length}</dd></div></dl>` +
    `${result.failed.length ? `<p class="tone-bad small">${esc(t("app.typesFailed", { types: result.failed.join(", ") }))}</p>` : ""}` +
    `${site ? `<div class="row">${button("open-link", t("resolve.visitWebsite"), { arg: site, kind: "brand", icon: ICON.external })}</div>` : ""}</section>` +
    `<section class="card"><h2>${esc(t("resolve.dnsRecords"))}</h2>${result.noSuchName && !result.records.length ? `<p class="muted">${esc(t("app.noSuchName"))}</p>` : recordsTable(result.records)}</section>`
  );
}

function keyRow(key: string, title: string, meta: string, actions: string, icon: string): string {
  return `<li class="item"><button type="button" class="item-main" data-action="resolve-key" data-arg="${key}"><span class="item-icon">${icon}</span><span class="item-text"><span class="item-title">${title}</span><span class="item-meta">${meta}</span></span></button><span class="item-actions">${actions}</span></li>`;
}

function favoriteRow(f: Favorite): string {
  return keyRow(
    f.key,
    esc(f.label || truncateKey(f.key, 16, 12)),
    `<span class="mono">${truncateKey(f.key, 12, 8)}</span> · ${esc(dateOnly(f.createdAt))}`,
    iconButton("copy", t("common.copy"), ICON.copy, f.key) + iconButton("edit-favorite", t("favorites.editLabel"), ICON.edit, f.key) + iconButton("ask-unfavorite", t("common.remove"), ICON.close, f.key, "danger"),
    `<span class="starred">${ICON.starFilled}</span>`,
  );
}

function recentRow(key: string, searchedAt: number, label: string | undefined): string {
  return keyRow(
    key,
    `<span class="mono">${truncateKey(key, 16, 12)}</span>`,
    `${esc(relativeTime(searchedAt))}${label ? ` · <span class="starred">${ICON.starMini}</span> ${esc(label)}` : ""}`,
    iconButton("copy", t("common.copy"), ICON.copy, key) + iconButton("ask-remove-recent", t("common.remove"), ICON.close, key, "danger"),
    ICON.clock,
  );
}

function resolverView(data: AppData, ui: Ui): string {
  let body = "";
  if (ui.busy) body = `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span></div>`;
  else if (ui.result?.kind === "key") body = keyResult(data, ui.result.resolution);
  else if (ui.result?.kind === "dns") body = dnsResult(ui.result.result);
  else if (ui.result?.kind === "key-missing") {
    body =
      `<section class="card"><p class="${ui.result.failed ? "tone-bad" : ""}">${esc(t(ui.result.failed ? "app.allRefused" : "toast.noRecordsFound"))}</p><p class="mono small muted">${ui.result.key}</p><div class="row">${button("refresh", t("common.retry"), { arg: ui.result.key, icon: ICON.refresh })}</div></section>` +
      outcomesCard(ui.result.outcomes);
  } else if (ui.result?.kind === "error") body = `<section class="card"><p class="tone-bad">${esc(ui.result.message)}</p></section>`;
  else {
    const labels = new Map(data.favorites.map((f) => [f.key, f.label]));
    if (data.favorites.length) {
      body += `<section class="card"><div class="card-top"><h2>${esc(t("nav.favorites"))}</h2><span class="grow"></span>${button("go", t("common.viewAll"), { arg: "favorites", kind: "link" })}</div><ul class="items">${data.favorites.slice(0, 3).map(favoriteRow).join("")}</ul></section>`;
    }
    if (data.recent.length) {
      body += `<section class="card"><div class="card-top"><h2>${esc(t("nav.recent"))}</h2><span class="grow"></span>${button("go", t("common.viewAll"), { arg: "recent", kind: "link" })}</div><ul class="items">${data.recent.slice(0, 3).map((e) => recentRow(e.key, e.searchedAt, labels.get(e.key))).join("")}</ul></section>`;
    }
    body += `<p class="center">${button("go", t("popup.howDoesItWork"), { arg: "how", kind: "link" })}</p>`;
  }
  return (
    `<header class="hero"><h1 tabindex="-1">${esc(t("resolve.title"))}</h1><p class="sub">${esc(t("resolve.subtitle"))}</p>` +
    `<div class="search"><input id="query" class="field mono" type="text" data-field="query" value="${esc(ui.query)}" placeholder="${esc(t("app.inputPlaceholder"))}" aria-label="${esc(t("app.inputPlaceholder"))}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="600"/>` +
    `<button type="button" class="btn icon" data-action="clear-query" title="${esc(t("common.clear"))}" aria-label="${esc(t("common.clear"))}"${ui.query ? "" : " hidden"}>${ICON.close}</button>${button("resolve", t("common.resolve"), { kind: "brand", disabled: ui.busy })}</div>` +
    `<p class="hint">${esc(t("app.inputHint"))}</p></header>${body}`
  );
}

// --- Favorites and recent ---

function sortedFavorites(list: Favorite[], sort: Ui["favoritesSort"]): Favorite[] {
  const copy = [...list];
  if (sort === "oldest") copy.sort((a, b) => a.createdAt - b.createdAt);
  else if (sort === "az") copy.sort((a, b) => a.label.localeCompare(b.label, getLocale()));
  else copy.sort((a, b) => b.createdAt - a.createdAt);
  return copy;
}

function favoritesView(data: AppData, ui: Ui): string {
  const total = data.favorites.length;
  if (!total) return pageHead(t("favorites.title"), t("favorites.subtitle")) + empty(t("favorites.noFavorites"), t("favorites.noFavoritesDesc"), button("go", t("common.goToResolver"), { arg: "resolver", kind: "brand" }));
  const shown = sortedFavorites(searchFavorites(data.favorites, ui.favoritesQuery), ui.favoritesSort);
  const count = ui.favoritesQuery ? t("favorites.of", { filtered: shown.length, total }) : plural(total, "favorites.favorite", "favorites.favorites_count");
  const sorts = (["newest", "oldest", "az"] as const).map((s) => `<option value="${s}"${s === ui.favoritesSort ? " selected" : ""}>${esc(t(`common.${s}`))}</option>`).join("");
  return (
    pageHead(t("favorites.title"), t("favorites.subtitle")) +
    `<div class="toolbar"><input id="favorites-query" class="field grow" type="search" data-field="favoritesQuery" value="${esc(ui.favoritesQuery)}" placeholder="${esc(t("favorites.searchPlaceholder"))}" aria-label="${esc(t("favorites.searchPlaceholder"))}" autocomplete="off"/>` +
    `<select id="favorites-sort" class="field" data-field="favoritesSort" aria-label="${esc(t("app.sortBy"))}">${sorts}</select></div>` +
    `<div id="region"><p class="muted small">${esc(count)}</p>` +
    (shown.length ? `<ul class="items card">${shown.map(favoriteRow).join("")}</ul>` : `<p class="muted center">${esc(t("favorites.noResults"))}</p>`) +
    `</div>`
  );
}

function recentView(data: AppData, ui: Ui): string {
  const total = data.recent.length;
  if (!total) return pageHead(t("recent.title"), t("recent.subtitle")) + empty(t("recent.noRecent"), t("recent.noRecentDesc"), button("go", t("common.goToResolver"), { arg: "resolver", kind: "brand" }));
  const shown = searchRecent(data.recent, ui.recentQuery, data.favorites);
  const labels = new Map(data.favorites.map((f) => [f.key, f.label]));
  const count = ui.recentQuery ? t("recent.of", { filtered: shown.length, total }) : plural(total, "recent.search", "recent.searches");
  return (
    pageHead(t("recent.title"), t("recent.subtitle"), button("ask-clear-recent", t("common.clearAll"), { kind: "danger" })) +
    `<div class="toolbar"><input id="recent-query" class="field grow" type="search" data-field="recentQuery" value="${esc(ui.recentQuery)}" placeholder="${esc(t("recent.searchPlaceholder"))}" aria-label="${esc(t("recent.searchPlaceholder"))}" autocomplete="off"/></div>` +
    `<div id="region"><p class="muted small">${esc(count)}</p>` +
    (shown.length ? `<ul class="items card">${shown.map((e) => recentRow(e.key, e.searchedAt, labels.get(e.key))).join("")}</ul>` : `<p class="muted center">${esc(t("recent.noResults"))}</p>`) +
    `</div>`
  );
}

// --- History ---

const tile = (label: string, value: string) => `<div class="tile"><span class="tile-label">${esc(label)}</span><span class="tile-value">${figure(value)}</span></div>`;

function historyView(data: AppData, ui: Ui): string {
  if (!data.history.length) return pageHead(t("history.pageTitle"), t("history.pageSubtitle")) + empty(t("history.noHistory"), t("history.noHistoryDesc"), button("go", t("common.goToResolver"), { arg: "resolver", kind: "brand" }));
  const keys = [...new Set(data.history.map((e) => e.key))];
  const labels = new Map(data.favorites.map((f) => [f.key, f.label]));
  const entries = ui.historyKey ? data.history.filter((e) => e.key === ui.historyKey) : data.history;
  const stats = historyStats(entries);
  const fresh = entries.filter((e) => !e.fromCache);
  const w = ui.chartWidth;
  const options = [`<option value="">${esc(t("history.allKeys"))} (${data.history.length})</option>`]
    .concat(keys.map((k) => `<option value="${k}"${k === ui.historyKey ? " selected" : ""}>${esc(labels.get(k) || truncateKey(k, 10, 6))}</option>`))
    .join("");
  const chart = (title: string, body: string) => `<section class="card chart-card"><h2>${esc(title)}</h2><div class="plot">${body}</div></section>`;
  const none = `<p class="muted small">${esc(t("history.noFreshResolves"))}</p>`;
  const timeChart = fresh.length
    ? lineChart({ width: w, labels: fresh.map((e) => dateTime(e.resolvedAt, "short")), series: [{ name: t("history.responseTime"), slot: 1, values: fresh.map((e) => e.responseTimeMs) }], format: ms, title: t("history.responseTimeOverTime") })
    : none;
  const sizeChart = lineChart({ width: w, labels: entries.map((e) => dateTime(e.resolvedAt, "short")), series: [{ name: t("history.payloadSize"), slot: 1, values: entries.map((e) => e.rawSize) }], format: formatBytes, title: t("history.payloadSizeOverTime") });
  const days = resolvesPerDay(entries);
  const dayChart = columnChart({ width: w, columns: days.map((d) => ({ label: dateOnly(new Date(`${d.day}T12:00:00`).getTime()), value: d.count })), format: (v) => String(Math.round(v * 10) / 10), title: t("history.resolvesPerDay") });
  const relayChart = stats.relays.length
    ? barList(
        stats.relays.map((r) => ({
          label: hostOf(r.relay),
          value: r.avgResponseTimeMs,
          text: ms(r.avgResponseTimeMs),
          tip: [`${hostOf(r.relay)} (${r.count})`, t("relays.minLatency", { ms: r.minResponseTimeMs }), t("relays.avgLatency", { ms: r.avgResponseTimeMs }), t("relays.maxLatency", { ms: r.maxResponseTimeMs })].join("\n"),
        })),
        t("history.relayPerformance"),
      )
    : none;
  const newestFirst = [...entries].reverse();
  const rows = newestFirst
    .slice(0, ui.historyShown)
    .map(
      (e) =>
        `<tr><td data-label="${esc(t("history.date"))}">${esc(dateTime(e.resolvedAt, "short"))}</td>` +
        `<td data-label="${esc(t("history.key"))}"><button type="button" class="value mono" data-action="resolve-key" data-arg="${e.key}">${esc(labels.get(e.key) || truncateKey(e.key, 8, 6))}</button></td>` +
        `<td data-label="${esc(t("history.relay"))}">${e.fromCache ? `<span class="badge">${esc(t("popup.cached"))}</span>` : esc(hostOf(e.relay))}</td>` +
        `<td data-label="${esc(t("history.time"))}" class="num">${e.fromCache ? "–" : figure(ms(e.responseTimeMs))}</td><td data-label="${esc(t("history.size"))}" class="num">${figure(formatBytes(e.rawSize))}</td></tr>`,
    )
    .join("");
  return (
    pageHead(t("history.pageTitle"), t("history.pageSubtitle"), button("export-csv", t("history.exportCsv")) + button("ask-clear-history", t("history.clearHistory"), { kind: "danger" })) +
    `<div class="toolbar"><select id="history-key" class="field grow" data-field="historyKey" aria-label="${esc(t("history.key"))}">${options}</select></div>` +
    `<div class="tiles">${tile(t("history.totalResolves"), String(stats.totalResolves))}${tile(t("history.avgTime"), fresh.length ? ms(stats.avgResponseTimeMs) : "–")}${tile(t("history.avgSize"), formatBytes(stats.avgPayloadSize))}</div>` +
    `<div class="grid2">${chart(t("history.responseTimeOverTime"), timeChart)}${chart(t("history.payloadSizeOverTime"), sizeChart)}${chart(t("history.resolvesPerDay"), dayChart)}${chart(`${t("history.relayPerformance")} · ${t("history.avgTimeLabel")}`, relayChart)}</div>` +
    `<section class="card"><div class="card-top"><h2>${esc(t("history.allEntries"))}</h2><span class="grow"></span><span class="muted small">${esc(plural(entries.length, "common.entry", "common.entries"))}</span></div>` +
    `<table class="records history"><thead><tr><th>${esc(t("history.date"))}</th><th>${esc(t("history.key"))}</th><th>${esc(t("history.relay"))}</th><th class="num">${esc(t("history.time"))}</th><th class="num">${esc(t("history.size"))}</th></tr></thead><tbody>${rows}</tbody></table>` +
    `${newestFirst.length > ui.historyShown ? `<p class="center">${button("history-more", t("app.showMore"))}</p>` : ""}</section>`
  );
}

// --- Relays ---

function relayRow(relay: RelayConfig, data: AppData, ui: Ui): string {
  const ping = ui.ping[relay.url];
  const lastEnabled = relay.enabled && data.relays.filter((r) => r.enabled).length <= 1;
  const stats = latencyStats(data.latency[relay.url] ?? []);
  const status = !ping
    ? `<span class="ping unknown" aria-hidden="true"></span>`
    : ping.status === "testing"
      ? `<span class="ping testing" aria-hidden="true"></span>`
      : ping.status === "online"
        ? `<span class="ping online" aria-hidden="true"></span><span class="num tone-good">${ms(ping.ms ?? 0)}</span>`
        : `<span class="ping offline" aria-hidden="true"></span><span class="tone-bad">${esc(t("relays.offline"))}</span>`;
  const figures = stats ? `<span class="muted small num">${esc(t("relays.minLatency", { ms: stats.min }))} · ${esc(t("relays.avgLatency", { ms: stats.avg }))} · ${esc(t("relays.maxLatency", { ms: stats.max }))}</span>` : "";
  return (
    `<li class="relay${relay.enabled ? "" : " off"}"><label class="switch"><input type="checkbox" data-change="toggle-relay" data-arg="${esc(relay.url)}"${relay.enabled ? " checked" : ""}${lastEnabled ? " disabled" : ""} aria-label="${esc(hostOf(relay.url))}"/><span class="slider" aria-hidden="true"></span></label>` +
    `<span class="relay-text"><span class="item-title">${esc(hostOf(relay.url))}</span><span class="item-meta mono">${esc(relay.url)}</span>${figures}</span>` +
    `<span class="relay-status" role="status">${status}</span>` +
    `<span class="item-actions always">${iconButton("test-relay", t("app.testRelay"), ICON.bolt, relay.url)}${relay.isDefault ? "" : iconButton("ask-remove-relay", t("common.remove"), ICON.trash, relay.url, "danger")}</span></li>`
  );
}

/** A relay's place in the palette: its place in the list, so its colour is the same in both charts. Eight at most. */
function slots(relays: RelayConfig[]): Map<string, number> {
  return new Map(relays.slice(0, 8).map((r, i) => [r.url, i + 1]));
}

function relaysView(data: AppData, ui: Ui): string {
  const defaults = data.relays.filter((r) => r.isDefault);
  const custom = data.relays.filter((r) => !r.isDefault);
  const enabled = data.relays.filter((r) => r.enabled).length;
  const slot = slots(data.relays);
  const tested = data.relays.filter((r) => slot.has(r.url) && (data.latency[r.url]?.length ?? 0) > 0);
  const intervals = AUTO_REFRESH_CHOICES_S.map((s) => `<option value="${s}"${s === data.settings.autoRefreshSeconds ? " selected" : ""}>${s}s</option>`).join("");
  const comparison = tested.length
    ? barList(
        tested.map((r) => {
          const s = latencyStats(data.latency[r.url])!;
          return { label: hostOf(r.url), value: s.avg, text: ms(s.avg), slot: slot.get(r.url), tip: [hostOf(r.url), t("relays.minLatency", { ms: s.min }), t("relays.avgLatency", { ms: s.avg }), t("relays.maxLatency", { ms: s.max })].join("\n") };
        }),
        t("relays.latencyComparison"),
      )
    : `<p class="muted small">${esc(t("relays.noTestResults"))}</p>`;
  const steps = Math.max(0, ...tested.map((r) => data.latency[r.url].length));
  // Tests run together, so the newest of each relay line up at the right; an older relay's line starts later.
  const longest = tested.find((r) => data.latency[r.url].length === steps);
  const timeline =
    steps > 1 && longest
      ? lineChart({
          width: ui.chartWidth,
          labels: data.latency[longest.url].map((s) => new Intl.DateTimeFormat(getLocale(), { timeStyle: "medium" }).format(s.time)),
          series: tested.map((r) => {
            const samples = data.latency[r.url];
            return { name: hostOf(r.url), slot: slot.get(r.url)!, values: [...Array<null>(steps - samples.length).fill(null), ...samples.map((s) => s.ms)] };
          }),
          format: ms,
          title: t("relays.latencyHistory"),
        })
      : "";
  return (
    pageHead(t("relays.title"), t("relays.subtitle"), button("test-all", t("relays.testAll"), { kind: "brand", icon: ICON.bolt }) + button("ask-reset-relays", t("common.reset"))) +
    `<section class="card note"><h2>${esc(t("relays.decentralizedTitle"))}</h2><p class="muted">${esc(t("relays.decentralizedDesc"))}</p></section>` +
    `<div class="toolbar"><span class="grow"><strong>${esc(t("relays.active", { enabled, total: data.relays.length }))}</strong></span>` +
    `<label class="switch-row"><span class="switch"><input type="checkbox" data-change="auto-refresh"${data.settings.autoRefresh ? " checked" : ""}/><span class="slider" aria-hidden="true"></span></span><span>${esc(t("relays.autoRefresh"))}</span></label>` +
    `<select id="auto-interval" class="field" data-field="autoRefreshSeconds" aria-label="${esc(t("relays.autoRefresh"))}">${intervals}</select></div>` +
    `<p id="countdown" class="muted small" aria-live="off">${data.settings.autoRefresh && ui.countdown > 0 ? esc(t("relays.nextTestIn", { seconds: ui.countdown })) : ""}</p>` +
    `<section class="card"><h2>${esc(t("relays.defaultRelays"))}</h2><ul class="relays">${defaults.map((r) => relayRow(r, data, ui)).join("")}</ul></section>` +
    `<section class="card"><h2>${esc(t("relays.customRelays"))}</h2>${custom.length ? `<ul class="relays">${custom.map((r) => relayRow(r, data, ui)).join("")}</ul>` : `<p class="muted">${esc(t("relays.noCustomRelays"))}</p>`}` +
    `<div class="search"><input id="relay-input" class="field mono grow" type="url" inputmode="url" data-field="relayInput" value="${esc(ui.relayInput)}" placeholder="${esc(t("relays.addRelayPlaceholder"))}" aria-label="${esc(t("relays.addRelayPlaceholder"))}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="300"/>${button("add-relay", t("common.add"), { kind: "brand" })}</div>` +
    `<p class="${ui.relayError ? "tone-bad" : "muted"} small" role="${ui.relayError ? "alert" : "note"}">${esc(ui.relayError || `${t("relays.addRelayHint")} ${t("app.httpsOnly")}.`)}</p></section>` +
    `<div class="grid2"><section class="card chart-card"><h2>${esc(t("relays.latencyComparison"))}</h2><div class="plot">${comparison}</div></section>` +
    `${timeline ? `<section class="card chart-card"><h2>${esc(t("relays.latencyHistory"))}</h2><div class="plot">${timeline}</div></section>` : ""}</div>`
  );
}

// --- Settings ---

const setting = (title: string, desc: string, control: string) => `<div class="setting"><div class="setting-text"><span class="item-title">${esc(title)}</span><span class="item-meta">${esc(desc)}</span></div><div class="setting-control">${control}</div></div>`;

function settingsView(data: AppData, ui: Ui): string {
  const s = data.settings;
  const select = (field: string, label: string, options: string) => `<select id="set-${field}" class="field" data-field="${field}" aria-label="${esc(label)}">${options}</select>`;
  const timeouts = TIMEOUT_CHOICES_MS.map((v) => `<option value="${v}"${v === s.requestTimeoutMs ? " selected" : ""}>${esc(t("settings.seconds", { count: v / 1000 }))}</option>`).join("");
  const caches = CACHE_CHOICES_MS.map((v) => `<option value="${v}"${v === s.cacheTtlMs ? " selected" : ""}>${esc(v === 0 ? t("settings.disabled") : plural(v / 60_000, "settings.minute", "settings.minutes"))}</option>`).join("");
  const resolvers = DOH_PROVIDERS.map((id) => `<option value="${id}"${id === s.dohProvider ? " selected" : ""}>${esc(DOH[id].name)}</option>`).join("");
  const languages = [`<option value=""${s.locale === null ? " selected" : ""}>${esc(t("app.followClient"))}</option>`]
    .concat(LANGUAGES.map((l) => `<option value="${l.code}" lang="${l.code}"${l.code === s.locale ? " selected" : ""}>${esc(l.name)}</option>`))
    .join("");
  return (
    pageHead(t("settings.title"), t("settings.subtitle")) +
    `<section class="card"><h2>${esc(t("settings.resolution"))}</h2>` +
    setting(t("settings.requestTimeout"), t("settings.requestTimeoutDesc"), select("requestTimeoutMs", t("settings.requestTimeout"), timeouts)) +
    setting(t("app.dohResolver"), t("app.dohResolverDesc"), select("dohProvider", t("app.dohResolver"), resolvers)) +
    `</section><section class="card"><h2>${esc(t("settings.cache"))}</h2>` +
    setting(t("settings.cacheDuration"), t("settings.cacheDurationDesc"), select("cacheTtlMs", t("settings.cacheDuration"), caches)) +
    setting(t("settings.cachedEntries"), String(Object.keys(data.cache).length), button("clear-cache", t("settings.clearCache"), { disabled: !Object.keys(data.cache).length })) +
    `</section><section class="card"><h2>${esc(t("settings.language"))}</h2>` +
    setting(t("settings.language"), LANGUAGES.find((l) => l.code === getLocale())?.name ?? "", select("locale", t("settings.language"), languages)) +
    `</section><section class="card"><h2>${esc(t("settings.data"))}</h2>` +
    setting(t("settings.exportImport"), t("settings.exportImportDesc"), button("export-data", t("common.export")) + button("import-data", t("common.import"))) +
    setting(t("settings.clearAllData"), t("settings.clearAllDataDesc"), button("ask-clear-all", t("settings.clearAllData"), { kind: "danger" })) +
    `<p class="${ui.persistent ? "muted" : "tone-bad"} small">${esc(t(ui.persistent ? "app.storageNote" : "app.memoryNote"))}</p></section>` +
    `<p class="muted small center">${esc(t("popup.title"))} ${esc(ui.version)}</p>`
  );
}

// --- How it works ---

function howView(data: AppData): string {
  const h = (key: string) => esc(t(`howItWorks.${key}`));
  const p = (key: string) => `<p>${richText(t(`howItWorks.${key}`))}</p>`;
  const step = (n: number, title: string, body: string) => `<li class="step"><span class="step-n" aria-hidden="true">${n}</span><div><h3>${h(title)}</h3>${body}</div></li>`;
  const relays = `<ul class="mono small plain">${(data.relays.length ? data.relays.filter((r) => r.enabled).map((r) => r.url) : [...DEFAULT_RELAYS]).map((url) => `<li>${esc(url)}</li>`).join("")}</ul>`;
  const layout =
    `<table class="records plainrows"><thead><tr><th>${h("tableBytes")}</th><th>${h("tableSize")}</th><th>${h("tableContent")}</th></tr></thead><tbody>` +
    `<tr><td class="mono" data-label="${h("tableBytes")}">0–63</td><td data-label="${h("tableSize")}" class="num">64</td><td data-label="${h("tableContent")}">${h("tableSignature")}</td></tr>` +
    `<tr><td class="mono" data-label="${h("tableBytes")}">64–71</td><td data-label="${h("tableSize")}" class="num">8</td><td data-label="${h("tableContent")}">${h("tableTimestamp")}</td></tr>` +
    `<tr><td class="mono" data-label="${h("tableBytes")}">72+</td><td data-label="${h("tableSize")}" class="num">≤ 1000</td><td data-label="${h("tableContent")}">${h("tableDnsPacket")}</td></tr></tbody></table>`;
  const arrow = (label: string) => `<span class="flow-arrow"><span>${esc(label)}</span><span aria-hidden="true">⟷</span></span>`;
  const architecture =
    `<div class="flow"><div class="flow-box"><strong>${h("browser")}</strong><span>${h("thisExtension")}</span></div>${arrow("HTTPS")}` +
    `<div class="flow-box brand"><strong>${h("httpRelay")}</strong><span>${h("bridge")}</span></div>${arrow("UDP")}` +
    `<div class="flow-box"><strong>${h("dht")}</strong><span>${h("millionsOfNodes")}</span></div></div>`;
  const trust = (title: string, body: string) => `<div class="trust"><h3>${h(title)}</h3>${p(body)}</div>`;
  const faq = [1, 2, 3, 4, 5].map((n) => `<details><summary>${h(`faq${n}Title`)}</summary>${p(`faq${n}Answer`)}</details>`).join("");
  return (
    pageHead(t("howItWorks.title"), t("howItWorks.subtitle")) +
    `<section class="card prose"><h2>${h("whatIsPkarr")}</h2>${p("whatIsPkarrDesc1")}${p("whatIsPkarrDesc2")}</section>` +
    `<section class="card prose"><h2>${h("problemTitle")}</h2>${p("problemDesc1")}${p("problemDesc2")}</section>` +
    `<section class="card prose"><h2>${h("solutionTitle")}</h2>${p("solutionDesc1")}${p("solutionDesc2")}</section>` +
    `<section class="card prose"><h2>${h("flowTitle")}</h2><p class="muted">${h("flowSubtitle")}</p><ol class="steps">` +
    step(1, "step1Title", p("step1Desc")) +
    step(2, "step2Title", p("step2Desc1") + relays + p("step2Desc2")) +
    step(3, "step3Title", p("step3Desc1") + p("step3Desc2")) +
    step(4, "step4Title", p("step4Desc") + layout) +
    step(5, "step5Title", p("step5Desc1") + p("step5Desc2")) +
    step(6, "step6Title", p("step6Desc")) +
    `</ol></section>` +
    `<section class="card prose"><h2>${h("architectureTitle")}</h2>${architecture}${p("httpsExplainer")}${p("udpExplainer")}</section>` +
    `<section class="card prose"><h2>${h("trustTitle")}</h2><p class="muted">${h("trustIntro")}</p>${trust("signedTitle", "signedDesc")}${trust("redundancyTitle", "redundancyDesc")}${trust("cannotForgeTitle", "cannotForgeDesc")}</section>` +
    `<section class="card prose"><h2>${h("faqTitle")}</h2>${faq}</section>`
  );
}

// --- Dialogs ---

export interface DialogSpec {
  title: string;
  body: string;
  /** Buttons, the main one last. `action` comes back to the dialog's handler. */
  buttons: { action: string; label: string; kind?: string }[];
}

export function renderDialog(spec: DialogSpec): string {
  const buttons = spec.buttons.map((b) => `<button type="button" class="btn ${b.kind ?? ""}" data-dialog="${b.action}"><span>${esc(b.label)}</span></button>`).join("");
  return `<div class="overlay" data-dialog="cancel"></div><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title">${esc(spec.title)}</h2>${spec.body}<div class="dialog-buttons">${buttons}</div></div>`;
}

export const dialogBody = {
  message: (text: string, detail = "") => `<p>${esc(text)}</p>${detail ? `<p class="mono small muted wrap">${esc(detail)}</p>` : ""}`,
  label: (key: string, value: string) =>
    `<p class="mono small muted wrap">${esc(key)}</p><label class="stack"><span>${esc(t("favorites.label"))}</span><input id="dialog-input" class="field" type="text" value="${esc(value)}" maxlength="${MAX_LABEL_LENGTH}" placeholder="${esc(t("favorites.labelPlaceholder"))}" autocomplete="off"/></label>`,
  text: (description: string, text: string) => `<p class="muted">${esc(description)}</p><textarea id="dialog-text" class="field mono" rows="8" readonly spellcheck="false">${esc(text)}</textarea>`,
  link: (url: string) => `<p class="muted">${esc(t("app.openLinkDesc"))}</p><input id="dialog-text" class="field mono" type="text" readonly value="${esc(url)}"/>`,
  import: () =>
    `<p class="muted">${esc(t("app.importDesc"))}</p><textarea id="dialog-text" class="field mono" rows="8" spellcheck="false" autocomplete="off"></textarea>` +
    `<label class="btn file"><span>${esc(t("app.chooseFile"))}</span><input id="dialog-file" type="file" accept="application/json,.json,text/plain"/></label><p id="dialog-error" class="tone-bad small" role="alert"></p>`,
};
