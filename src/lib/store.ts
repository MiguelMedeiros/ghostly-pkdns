/**
 * Where the app's data is kept: the broker's storage (`ghostly.storage`, WISP 1200), which for an app opened alone is
 * one scope of its own: keys up to 256 bytes, JSON values up to 64 KiB, 5 MiB in all. The history and the cache can
 * pass 64 KiB, so they are written in pieces (`history.0`, `history.1`…), each under the bound.
 *
 * Without a broker (the page opened by itself, or `npm run dev`) the data lives in memory only.
 */
import { MINI_APP_LIMITS, type MiniAppApi, type MiniAppJson } from "../vendor/miniApp";
import {
  type AppData, type CacheEntry, type HistoryEntry, cleanCache, cleanFavorites, cleanHistory, cleanLatency, cleanRecent, cleanRelays, cleanSeen,
  cleanSettings, emptyData,
} from "./model";

export interface Backend {
  get(key: string): Promise<MiniAppJson | undefined>;
  set(key: string, value: MiniAppJson): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Storage in memory, with the broker's bound on a value so tests meet it too. */
export function memoryBackend(valueBytes: number = MINI_APP_LIMITS.storageValueBytes): Backend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => (map.has(key) ? (JSON.parse(map.get(key)!) as MiniAppJson) : undefined),
    set: async (key, value) => {
      const text = JSON.stringify(value);
      if (new TextEncoder().encode(text).length > valueBytes) throw new Error("too-large");
      map.set(key, text);
    },
    delete: async (key) => void map.delete(key),
    keys: async () => [...map.keys()],
  };
}

export function brokerBackend(api: MiniAppApi): Backend {
  return { get: (k) => api.storage.get(k), set: (k, v) => api.storage.set(k, v), delete: (k) => api.storage.delete(k), keys: () => api.storage.keys() };
}

/** A piece stays well under the 64 KiB bound, counted in UTF-8 bytes. */
export const CHUNK_BYTES = 48 * 1024;

/** The items in pieces, each at most `maxBytes` when written as a JSON array. */
export function chunk<T>(items: T[], maxBytes = CHUNK_BYTES): T[][] {
  const encoder = new TextEncoder();
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 2;
  for (const item of items) {
    const bytes = encoder.encode(JSON.stringify(item)).length + 1;
    if (current.length && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

type Part = keyof AppData;
const SINGLE: Part[] = ["settings", "favorites", "recent", "relays", "seen", "latency"];
const CHUNKED: Part[] = ["history", "cache"];
const PARTS: Part[] = [...SINGLE, ...CHUNKED];

export class Store {
  private dirty = new Set<Part>();
  private running: Promise<void> | null = null;
  private chunkCounts: Record<string, number> = { history: 0, cache: 0 };
  private source: () => AppData = emptyData;
  /** Called when a write is refused (`full`, `stopped`…) with the broker's code. */
  onError: (code: string) => void = () => {};

  constructor(private readonly backend: Backend, readonly persistent: boolean) {}

  /** Everything stored, cleaned field by field. A part that cannot be read comes back empty. */
  async load(): Promise<AppData> {
    const data = emptyData();
    let keys: string[] = [];
    try {
      keys = await this.backend.keys();
    } catch {
      return data;
    }
    const read = async (key: string) => {
      try {
        return keys.includes(key) ? await this.backend.get(key) : undefined;
      } catch {
        return undefined;
      }
    };
    const pieces = async (part: string) => {
      const indexes = keys.filter((k) => k.startsWith(`${part}.`)).map((k) => Number(k.slice(part.length + 1))).filter(Number.isInteger).sort((a, b) => a - b);
      this.chunkCounts[part] = indexes.length ? indexes[indexes.length - 1] + 1 : 0;
      const all: unknown[] = [];
      for (const i of indexes) {
        const piece = await read(`${part}.${i}`);
        if (Array.isArray(piece)) all.push(...piece);
      }
      return all;
    };
    data.settings = cleanSettings(await read("settings"));
    data.favorites = cleanFavorites(await read("favorites"));
    data.recent = cleanRecent(await read("recent"));
    data.relays = cleanRelays(await read("relays"));
    data.seen = cleanSeen(await read("seen"));
    data.latency = cleanLatency(await read("latency"));
    data.history = cleanHistory(await pieces("history"));
    const cachePairs = (await pieces("cache")).filter((p): p is [string, unknown] => Array.isArray(p) && p.length === 2 && typeof p[0] === "string");
    data.cache = cleanCache(Object.fromEntries(cachePairs));
    return data;
  }

  /** Where the store reads the data it writes: the app's current state, read when the write runs. */
  bind(source: () => AppData): void {
    this.source = source;
  }

  /** Marks parts as changed. Writes run one after the other, the latest state each time. */
  save(...parts: Part[]): void {
    for (const part of parts) this.dirty.add(part);
    if (!this.running) this.running = this.run().finally(() => (this.running = null));
  }

  /** Settles when nothing is left to write. */
  async flush(): Promise<void> {
    while (this.running) await this.running;
  }

  private async run(): Promise<void> {
    await Promise.resolve();
    while (this.dirty.size) {
      const part = this.dirty.values().next().value as Part;
      this.dirty.delete(part);
      try {
        await this.write(part, this.source());
      } catch (error) {
        this.onError(error instanceof Error ? error.message : "failed");
      }
    }
  }

  private async write(part: Part, data: AppData): Promise<void> {
    if (SINGLE.includes(part)) {
      await this.backend.set(part, data[part] as unknown as MiniAppJson);
      return;
    }
    const items: unknown[] = part === "history" ? (data.history satisfies HistoryEntry[]) : (Object.entries(data.cache) satisfies [string, CacheEntry][]);
    const chunks = chunk(items);
    for (let i = 0; i < chunks.length; i++) await this.backend.set(`${part}.${i}`, chunks[i] as MiniAppJson);
    for (let i = chunks.length; i < this.chunkCounts[part]; i++) await this.backend.delete(`${part}.${i}`);
    this.chunkCounts[part] = chunks.length;
  }

  /** Removes every key the app wrote. */
  async clear(): Promise<void> {
    await this.flush();
    this.dirty.clear();
    for (const key of await this.backend.keys()) await this.backend.delete(key);
    this.chunkCounts = { history: 0, cache: 0 };
  }

  static readonly parts = PARTS;
}
