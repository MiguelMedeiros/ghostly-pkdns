/** What the app keeps, its limits, and the changes to it as plain functions (the storage is in store.ts). */
import { isValidPkarrKey } from "./pkarr";
import type { DnsRecord } from "./records";

export const DEFAULT_RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app", "https://pkarr.miguelmedeiros.dev"] as const;

export const MAX_RECENT_KEYS = 100;
export const MAX_FAVORITES = 50;
export const MAX_CACHE_ENTRIES = 50;
export const MAX_HISTORY_ENTRIES = 1000;
export const MAX_LATENCY_HISTORY = 20;
export const MAX_CUSTOM_RELAYS = 20;
export const MAX_LABEL_LENGTH = 80;
/** Keys whose newest timestamp is remembered, so an older record is refused later too. */
export const MAX_SEEN_KEYS = 500;

export const TIMEOUT_CHOICES_MS = [5_000, 10_000, 15_000, 30_000] as const;
export const CACHE_CHOICES_MS = [0, 60_000, 300_000, 900_000, 1_800_000] as const;
export const AUTO_REFRESH_CHOICES_S = [5, 10, 30, 60, 120] as const;
export const DOH_PROVIDERS = ["cloudflare", "google", "quad9"] as const;
export type DohProviderId = (typeof DOH_PROVIDERS)[number];

export interface Settings {
  requestTimeoutMs: number;
  /** 0 is off. */
  cacheTtlMs: number;
  dohProvider: DohProviderId;
  /** The display language the person chose, or null to follow the client's. */
  locale: string | null;
  autoRefresh: boolean;
  autoRefreshSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  requestTimeoutMs: 15_000,
  cacheTtlMs: 300_000,
  dohProvider: "cloudflare",
  locale: null,
  autoRefresh: false,
  autoRefreshSeconds: 30,
};

export interface Favorite {
  key: string;
  label: string;
  createdAt: number;
}

export interface RecentEntry {
  key: string;
  searchedAt: number;
}

export interface RelayConfig {
  url: string;
  enabled: boolean;
  isDefault: boolean;
}

/**
 * What one relay did in a resolve. `refused` is an answer that failed the payload check; `pending` is a relay that was
 * not waited for once another had answered.
 */
export interface RelayOutcome {
  relay: string;
  status: "ok" | "not-found" | "refused" | "error" | "pending";
  ms?: number;
  /** The refusal code (payload.ts) or a short error text. */
  detail?: string;
}

/** A checked answer for a key. */
export interface Resolution {
  publicKey: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  /** The signed timestamp, microseconds, as decimal text (JSON has no u64). */
  timestampMicros: string;
  records: DnsRecord[];
  rawSize: number;
  relay: string;
  responseTimeMs: number;
  fromCache: boolean;
  outcomes: RelayOutcome[];
}

export interface CacheEntry {
  resolution: Resolution;
  cachedAt: number;
}

export interface HistoryEntry {
  key: string;
  resolvedAt: number;
  rawSize: number;
  responseTimeMs: number;
  relay: string;
  fromCache: boolean;
  recordCount: number;
}

export interface LatencySample {
  ms: number;
  time: number;
}

export interface AppData {
  settings: Settings;
  favorites: Favorite[];
  recent: RecentEntry[];
  relays: RelayConfig[];
  cache: Record<string, CacheEntry>;
  history: HistoryEntry[];
  /** Per key, the newest signed timestamp seen (microseconds, decimal text). */
  seen: Record<string, string>;
  /** Per relay URL, its last test results. */
  latency: Record<string, LatencySample[]>;
}

export function defaultRelays(): RelayConfig[] {
  return DEFAULT_RELAYS.map((url) => ({ url, enabled: true, isDefault: true }));
}

export function emptyData(): AppData {
  return { settings: { ...DEFAULT_SETTINGS }, favorites: [], recent: [], relays: defaultRelays(), cache: {}, history: [], seen: {}, latency: {} };
}

// --- Favorites and recent ---

export function addFavorite(list: Favorite[], key: string, label: string, now = Date.now()): Favorite[] {
  const clean = label.trim().slice(0, MAX_LABEL_LENGTH);
  return [{ key, label: clean, createdAt: now }, ...list.filter((f) => f.key !== key)].slice(0, MAX_FAVORITES);
}

export function renameFavorite(list: Favorite[], key: string, label: string): Favorite[] {
  return list.map((f) => (f.key === key ? { ...f, label: label.trim().slice(0, MAX_LABEL_LENGTH) } : f));
}

export function removeFavorite(list: Favorite[], key: string): Favorite[] {
  return list.filter((f) => f.key !== key);
}

export function addRecent(list: RecentEntry[], key: string, now = Date.now()): RecentEntry[] {
  return [{ key, searchedAt: now }, ...list.filter((e) => e.key !== key)].slice(0, MAX_RECENT_KEYS);
}

/** Favorites whose label or key holds the text. */
export function searchFavorites(list: Favorite[], query: string): Favorite[] {
  const q = query.trim().toLowerCase();
  return q ? list.filter((f) => f.label.toLowerCase().includes(q) || f.key.includes(q)) : list;
}

/** Recent keys that hold the text, or whose favorite label does. */
export function searchRecent(list: RecentEntry[], query: string, favorites: Favorite[] = []): RecentEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const labels = new Map(favorites.map((f) => [f.key, f.label.toLowerCase()]));
  return list.filter((e) => e.key.includes(q) || (labels.get(e.key) ?? "").includes(q));
}

// --- Relays ---

export type RelayProblem = "empty" | "invalid" | "not-https" | "exists" | "too-many" | "default" | "last-enabled" | "missing";

export class RelayError extends Error {
  constructor(readonly code: RelayProblem) {
    super(code);
    this.name = "RelayError";
  }
}

/**
 * A relay address as the app keeps it: `https://host[:port][/path]`, no trailing slash, no query or fragment, no user.
 * Only HTTPS: the runner of an app with `internet` reaches nothing else.
 */
export function normalizeRelayUrl(input: string): string {
  const text = input.trim();
  if (!text) throw new RelayError("empty");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RelayError("invalid");
  }
  if (url.protocol !== "https:") throw new RelayError("not-https");
  if (!url.hostname || url.username || url.password) throw new RelayError("invalid");
  return `https://${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function addRelay(list: RelayConfig[], input: string): RelayConfig[] {
  const url = normalizeRelayUrl(input);
  if (list.some((r) => r.url === url)) throw new RelayError("exists");
  if (list.filter((r) => !r.isDefault).length >= MAX_CUSTOM_RELAYS) throw new RelayError("too-many");
  return [...list, { url, enabled: true, isDefault: false }];
}

export function removeRelay(list: RelayConfig[], url: string): RelayConfig[] {
  const relay = list.find((r) => r.url === url);
  if (!relay) throw new RelayError("missing");
  if (relay.isDefault) throw new RelayError("default");
  const rest = list.filter((r) => r.url !== url);
  // Never left with nothing to ask: the first one is switched back on.
  return rest.some((r) => r.enabled) ? rest : rest.map((r, i) => (i === 0 ? { ...r, enabled: true } : r));
}

export function toggleRelay(list: RelayConfig[], url: string): RelayConfig[] {
  const relay = list.find((r) => r.url === url);
  if (!relay) throw new RelayError("missing");
  if (relay.enabled && list.filter((r) => r.enabled).length <= 1) throw new RelayError("last-enabled");
  return list.map((r) => (r.url === url ? { ...r, enabled: !r.enabled } : r));
}

export function activeRelays(list: RelayConfig[]): string[] {
  const active = list.filter((r) => r.enabled).map((r) => r.url);
  return active.length ? active : [...DEFAULT_RELAYS];
}

/** The list with every default relay in it, defaults first: a default added in a later version shows up. */
export function withDefaultRelays(list: RelayConfig[]): RelayConfig[] {
  const custom = list.filter((r) => !(DEFAULT_RELAYS as readonly string[]).includes(r.url)).map((r) => ({ ...r, isDefault: false }));
  const defaults = DEFAULT_RELAYS.map((url) => ({ url, enabled: list.find((r) => r.url === url)?.enabled ?? true, isDefault: true }));
  const all = [...defaults, ...custom];
  return all.some((r) => r.enabled) ? all : all.map((r, i) => (i === 0 ? { ...r, enabled: true } : r));
}

// --- Cache, history, seen ---

/** The cached answer for a key while it is fresh, or null. */
export function cached(cache: Record<string, CacheEntry>, key: string, ttlMs: number, now = Date.now()): CacheEntry | null {
  const entry = cache[key];
  if (ttlMs <= 0 || !entry) return null;
  const age = now - entry.cachedAt;
  return age >= 0 && age <= ttlMs ? entry : null;
}

/** The cache with this answer in it, the oldest entries dropped past 50. */
export function withCached(cache: Record<string, CacheEntry>, resolution: Resolution, now = Date.now()): Record<string, CacheEntry> {
  const next = { ...cache, [resolution.publicKey]: { resolution, cachedAt: now } };
  const keys = Object.keys(next);
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys.sort((a, b) => next[a].cachedAt - next[b].cachedAt);
    for (const key of keys.slice(0, keys.length - MAX_CACHE_ENTRIES)) delete next[key];
  }
  return next;
}

export function addHistory(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...list, entry];
  return next.length > MAX_HISTORY_ENTRIES ? next.slice(next.length - MAX_HISTORY_ENTRIES) : next;
}

/** `seen` with this key's timestamp raised (never lowered). Past 500 keys the ones first added go. */
export function withSeen(seen: Record<string, string>, key: string, timestampMicros: string): Record<string, string> {
  const known = seen[key];
  if (known !== undefined && BigInt(known) >= BigInt(timestampMicros)) return seen;
  const next = { ...seen };
  delete next[key];
  next[key] = timestampMicros;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SEEN_KEYS))) delete next[old];
  return next;
}

export function addLatency(latency: Record<string, LatencySample[]>, url: string, sample: LatencySample): Record<string, LatencySample[]> {
  return { ...latency, [url]: [...(latency[url] ?? []), sample].slice(-MAX_LATENCY_HISTORY) };
}

// --- Reading data that came from outside (a backup file, or storage written by another version) ---

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
const pick = <T>(choices: readonly T[], v: unknown, fallback: T): T => (choices.includes(v as T) ? (v as T) : fallback);

export function cleanSettings(raw: unknown): Settings {
  const s = isObject(raw) ? raw : {};
  return {
    requestTimeoutMs: pick(TIMEOUT_CHOICES_MS as readonly number[], s.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs),
    cacheTtlMs: pick(CACHE_CHOICES_MS as readonly number[], s.cacheTtlMs, DEFAULT_SETTINGS.cacheTtlMs),
    dohProvider: pick(DOH_PROVIDERS, s.dohProvider, DEFAULT_SETTINGS.dohProvider),
    locale: typeof s.locale === "string" && s.locale.length <= 16 ? s.locale : null,
    autoRefresh: s.autoRefresh === true,
    autoRefreshSeconds: pick(AUTO_REFRESH_CHOICES_S as readonly number[], s.autoRefreshSeconds, DEFAULT_SETTINGS.autoRefreshSeconds),
  };
}

export function cleanFavorites(raw: unknown): Favorite[] {
  const out: Favorite[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item) || typeof item.key !== "string" || !isValidPkarrKey(item.key) || seen.has(item.key.toLowerCase())) continue;
    const key = item.key.toLowerCase();
    seen.add(key);
    out.push({ key, label: typeof item.label === "string" ? item.label.trim().slice(0, MAX_LABEL_LENGTH) : "", createdAt: count(item.createdAt) ?? 0 });
  }
  return out.slice(0, MAX_FAVORITES);
}

export function cleanRecent(raw: unknown, now = Date.now()): RecentEntry[] {
  const out: RecentEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    // The extension's first versions kept bare keys.
    const key = typeof item === "string" ? item : isObject(item) && typeof item.key === "string" ? item.key : "";
    if (!isValidPkarrKey(key) || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    out.push({ key: key.toLowerCase(), searchedAt: (isObject(item) ? count(item.searchedAt) : null) ?? now });
  }
  return out.slice(0, MAX_RECENT_KEYS);
}

export function cleanRelays(raw: unknown): RelayConfig[] {
  const out: RelayConfig[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item) || typeof item.url !== "string") continue;
    let url: string;
    try {
      url = normalizeRelayUrl(item.url);
    } catch {
      continue; // a relay over plain HTTP from the extension cannot be reached from here
    }
    if (out.some((r) => r.url === url)) continue;
    out.push({ url, enabled: item.enabled !== false, isDefault: false });
  }
  const all = withDefaultRelays(out);
  const custom = all.filter((r) => !r.isDefault).slice(0, MAX_CUSTOM_RELAYS);
  return [...all.filter((r) => r.isDefault), ...custom];
}

export function cleanHistory(raw: unknown): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item) || typeof item.key !== "string" || !isValidPkarrKey(item.key)) continue;
    const resolvedAt = count(item.resolvedAt);
    if (resolvedAt === null) continue;
    out.push({
      key: item.key.toLowerCase(),
      resolvedAt,
      rawSize: count(item.rawSize, 1e6) ?? 0,
      responseTimeMs: count(item.responseTimeMs, 1e7) ?? 0,
      relay: typeof item.relay === "string" ? item.relay.slice(0, 300) : "",
      fromCache: item.fromCache === true,
      recordCount: count(item.recordCount, 1e4) ?? 0,
    });
  }
  out.sort((a, b) => a.resolvedAt - b.resolvedAt);
  return out.slice(-MAX_HISTORY_ENTRIES);
}

export function cleanLatency(raw: unknown): Record<string, LatencySample[]> {
  const out: Record<string, LatencySample[]> = {};
  if (!isObject(raw)) return out;
  for (const [url, samples] of Object.entries(raw).slice(0, DEFAULT_RELAYS.length + MAX_CUSTOM_RELAYS)) {
    if (!/^https:\/\//.test(url) || url.length > 300 || !Array.isArray(samples)) continue;
    const clean: LatencySample[] = [];
    for (const s of samples) {
      if (!isObject(s)) continue;
      const ms = count(s.ms, 1e7);
      const time = count(s.time);
      if (ms !== null && time !== null) clean.push({ ms, time });
    }
    if (clean.length) out[url] = clean.slice(-MAX_LATENCY_HISTORY);
  }
  return out;
}

export function cleanSeen(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(raw)) return out;
  for (const [key, value] of Object.entries(raw).slice(-MAX_SEEN_KEYS)) {
    if (isValidPkarrKey(key) && typeof value === "string" && /^\d{1,20}$/.test(value)) out[key] = value;
  }
  return out;
}

const RECORD_TYPE = /^[A-Z0-9]{1,12}$/;

/** A stored cache, kept only where every field is what the app wrote. Nothing in it is trusted more than a relay. */
export function cleanCache(raw: unknown): Record<string, CacheEntry> {
  const out: Record<string, CacheEntry> = {};
  if (!isObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidPkarrKey(key) || !isObject(value) || !isObject(value.resolution)) continue;
    const r = value.resolution;
    const cachedAt = count(value.cachedAt);
    const timestamp = count(r.timestamp);
    if (cachedAt === null || timestamp === null || r.publicKey !== key || typeof r.timestampMicros !== "string" || !/^\d{1,20}$/.test(r.timestampMicros)) continue;
    if (!Array.isArray(r.records) || typeof r.relay !== "string") continue;
    const records: DnsRecord[] = [];
    for (const rec of r.records) {
      if (isObject(rec) && typeof rec.name === "string" && typeof rec.type === "string" && RECORD_TYPE.test(rec.type) && typeof rec.value === "string") {
        records.push({ name: rec.name, type: rec.type, value: rec.value, ttl: count(rec.ttl) ?? 0 });
      }
    }
    out[key] = {
      cachedAt,
      resolution: { publicKey: key, timestamp, timestampMicros: r.timestampMicros, records, rawSize: count(r.rawSize, 1e6) ?? 0, relay: r.relay.slice(0, 300), responseTimeMs: count(r.responseTimeMs, 1e7) ?? 0, fromCache: false, outcomes: [] },
    };
  }
  const keys = Object.keys(out).sort((a, b) => out[b].cachedAt - out[a].cachedAt);
  for (const key of keys.slice(MAX_CACHE_ENTRIES)) delete out[key];
  return out;
}
