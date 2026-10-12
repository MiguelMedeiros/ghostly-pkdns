/**
 * Export and import of everything the app keeps, as one JSON document. It is the extension's backup format (version
 * 1: favorites, recentKeys, relayConfigs, settings, resolveHistory) with this app's own fields beside them, so a
 * backup made by the extension imports here. A backup is outside data: every field is cleaned as it comes in.
 */
import {
  type AppData, type Favorite, type HistoryEntry, type LatencySample, type RecentEntry, type RelayConfig, type Settings, cleanFavorites,
  cleanHistory, cleanLatency, cleanRecent, cleanRelays, cleanSeen, cleanSettings,
} from "./model";

export const BACKUP_VERSION = 1;
/** A backup is at most this long as text: a full history is about 300 KiB. */
export const MAX_BACKUP_CHARS = 4 * 1024 * 1024;

export interface Backup {
  version: number;
  app: "ghostly-pkdns";
  exportedAt: number;
  favorites: Favorite[];
  recentKeys: RecentEntry[];
  relayConfigs: RelayConfig[];
  settings: Settings;
  resolveHistory: HistoryEntry[];
  latencyHistory: Record<string, LatencySample[]>;
  /** The newest timestamp seen per key: kept, so a restored app still refuses an older record. */
  seen: Record<string, string>;
}

/** Everything but the cache, which is only a copy of what relays answer. */
export function exportData(data: AppData, now = Date.now()): Backup {
  return {
    version: BACKUP_VERSION,
    app: "ghostly-pkdns",
    exportedAt: now,
    favorites: data.favorites,
    recentKeys: data.recent,
    relayConfigs: data.relays,
    settings: data.settings,
    resolveHistory: data.history,
    latencyHistory: data.latency,
    seen: data.seen,
  };
}

export class BackupError extends Error {
  constructor(readonly code: "not-json" | "not-a-backup" | "too-large") {
    super(code);
    this.name = "BackupError";
  }
}

export interface ImportResult {
  data: AppData;
  counts: { favorites: number; recent: number; relays: number; history: number };
}

/**
 * The data after importing a backup's text over `current`: each category the backup holds replaces the current one;
 * one it does not hold stays. The cache is kept as it is.
 */
export function importData(text: string, current: AppData): ImportResult {
  if (text.length > MAX_BACKUP_CHARS) throw new BackupError("too-large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError("not-json");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BackupError("not-a-backup");
  const backup = raw as Record<string, unknown>;
  if (typeof backup.version !== "number" || backup.version < 1) throw new BackupError("not-a-backup");

  const data: AppData = { ...current };
  if (Array.isArray(backup.favorites)) data.favorites = cleanFavorites(backup.favorites);
  if (Array.isArray(backup.recentKeys)) data.recent = cleanRecent(backup.recentKeys);
  if (Array.isArray(backup.relayConfigs)) data.relays = cleanRelays(backup.relayConfigs);
  if (typeof backup.settings === "object" && backup.settings !== null) data.settings = cleanSettings(backup.settings);
  if (Array.isArray(backup.resolveHistory)) data.history = cleanHistory(backup.resolveHistory);
  if (typeof backup.latencyHistory === "object" && backup.latencyHistory !== null) data.latency = cleanLatency(backup.latencyHistory);
  if (typeof backup.seen === "object" && backup.seen !== null) {
    // Never lowered by an import: for a key in both, the newer timestamp stays.
    const merged = { ...cleanSeen(backup.seen) };
    for (const [key, value] of Object.entries(current.seen)) if (merged[key] === undefined || BigInt(merged[key]) < BigInt(value)) merged[key] = value;
    data.seen = cleanSeen(merged);
  }
  return {
    data,
    counts: {
      favorites: Array.isArray(backup.favorites) ? data.favorites.length : 0,
      recent: Array.isArray(backup.recentKeys) ? data.recent.length : 0,
      relays: Array.isArray(backup.relayConfigs) ? data.relays.filter((r) => !r.isDefault).length : 0,
      history: Array.isArray(backup.resolveHistory) ? data.history.length : 0,
    },
  };
}
