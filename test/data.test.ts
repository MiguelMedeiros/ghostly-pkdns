// What the app keeps: limits, relay rules, latency and history figures, the CSV, backups and the stored pieces.
import { describe, expect, it } from "vitest";
import { BackupError, exportData, importData } from "../src/lib/backup";
import {
  type AppData, type HistoryEntry, DEFAULT_RELAYS, MAX_CACHE_ENTRIES, MAX_FAVORITES, MAX_HISTORY_ENTRIES, MAX_LATENCY_HISTORY, MAX_RECENT_KEYS,
  RelayError, activeRelays, addFavorite, addHistory, addLatency, addRecent, addRelay, cached, emptyData, normalizeRelayUrl, removeRelay,
  renameFavorite, searchFavorites, searchRecent, toggleRelay, withCached, withSeen,
} from "../src/lib/model";
import { extractPkarrKey, isValidPkarrKey, truncateKey } from "../src/lib/pkarr";
import { csvCell, historyCsv, historyStats, latencyStats, resolvesPerDay } from "../src/lib/stats";
import { CHUNK_BYTES, Store, chunk, memoryBackend } from "../src/lib/store";
import { zbase32Decode, zbase32Encode } from "../src/lib/zbase32";
import { testKey } from "./packets";

const keyOf = (n: number) => testKey(n).key;
const KEY = "7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy";
const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  key: KEY, resolvedAt: Date.parse("2026-10-10T10:00:00Z"), rawSize: 300, responseTimeMs: 100, relay: DEFAULT_RELAYS[0], fromCache: false, recordCount: 3, ...over,
});

describe("keys", () => {
  it("are 52 z-base32 characters that decode to 32 bytes", () => {
    expect(isValidPkarrKey(KEY)).toBe(true);
    expect(isValidPkarrKey(KEY.toUpperCase())).toBe(true);
    expect(isValidPkarrKey(KEY.slice(1))).toBe(false);
    expect(isValidPkarrKey(KEY.replace("7", "l"))).toBe(false); // "l" is not in the alphabet
    expect(isValidPkarrKey(`${KEY.slice(0, 51)}b`)).toBe(false); // spare bits set: no 32 bytes encode to this
    expect(zbase32Encode(zbase32Decode(KEY)!)).toBe(KEY);
  });

  it("are found in what a person pastes", () => {
    for (const text of [KEY, ` ${KEY}\n`, `pk:${KEY}`, `pubky${KEY}`, `pubky://${KEY}`, `pubky://${KEY}/pub/app`, `https://${KEY}/`, `see ${KEY}.`, KEY.toUpperCase()]) {
      expect(extractPkarrKey(text), text).toBe(KEY);
    }
    expect(extractPkarrKey("example.com")).toBeNull();
    expect(extractPkarrKey(`${KEY}y`)).toBeNull();
    expect(truncateKey(KEY)).toBe("7fmjpcuu...bd64cy");
  });
});

describe("favorites and recent keys", () => {
  it("keep at most 50 favorites, the newest first, one per key", () => {
    let list = addFavorite([], KEY, "  Alice  ", 1);
    expect(list).toEqual([{ key: KEY, label: "Alice", createdAt: 1 }]);
    list = addFavorite(list, KEY, "Alice B", 2);
    expect(list).toHaveLength(1);
    for (let i = 0; i < 60; i++) list = addFavorite(list, keyOf(i + 1), `n${i}`, i);
    expect(list).toHaveLength(MAX_FAVORITES);
    expect(list[0].label).toBe("n59");
    expect(renameFavorite(list, list[0].key, " Bob ")[0].label).toBe("Bob");
    expect(searchFavorites(list, "N59")).toHaveLength(1);
    expect(searchFavorites(list, list[3].key.slice(5, 20))).toEqual([list[3]]);
  });

  it("keep at most 100 recent keys, a key resolved again moving to the top", () => {
    let list = addRecent([], KEY, 1);
    for (let i = 0; i < 120; i++) list = addRecent(list, keyOf(i + 1), i + 2);
    expect(list).toHaveLength(MAX_RECENT_KEYS);
    expect(list.some((e) => e.key === KEY)).toBe(false);
    list = addRecent(list, list[40].key, 999);
    expect(list).toHaveLength(MAX_RECENT_KEYS);
    expect(list[0].searchedAt).toBe(999);
    expect(searchRecent(list, "alice", [{ key: list[5].key, label: "Alice", createdAt: 0 }])).toEqual([list[5]]);
  });
});

describe("relays", () => {
  it("are HTTPS addresses, kept without a trailing slash", () => {
    expect(normalizeRelayUrl(" https://Relay.Example.com/ ")).toBe("https://relay.example.com");
    expect(normalizeRelayUrl("https://relay.example.com:8443/pkarr/")).toBe("https://relay.example.com:8443/pkarr");
    const problem = (input: string) => {
      try {
        normalizeRelayUrl(input);
        return "ok";
      } catch (error) {
        return (error as RelayError).code;
      }
    };
    expect(problem("")).toBe("empty");
    expect(problem("relay.example.com")).toBe("invalid");
    expect(problem("http://relay.example.com")).toBe("not-https");
    expect(problem("javascript:alert(1)")).toBe("not-https");
    expect(problem("https://user:pass@relay.example.com")).toBe("invalid");
  });

  it("can be added, switched off and removed, but never all off, and a default never removed", () => {
    let list = emptyData().relays;
    expect(list.map((r) => r.url)).toEqual([...DEFAULT_RELAYS]);
    list = addRelay(list, "https://my.relay.example/");
    expect(() => addRelay(list, "https://my.relay.example")).toThrow("exists");
    expect(() => removeRelay(list, DEFAULT_RELAYS[0])).toThrow("default");
    for (const url of DEFAULT_RELAYS) list = toggleRelay(list, url);
    expect(activeRelays(list)).toEqual(["https://my.relay.example"]);
    expect(() => toggleRelay(list, "https://my.relay.example")).toThrow("last-enabled");
    list = removeRelay(list, "https://my.relay.example");
    expect(activeRelays(list)).toEqual([DEFAULT_RELAYS[0]]);
  });
});

describe("relay latency", () => {
  it("gives min, average and max of the tests kept", () => {
    expect(latencyStats([])).toBeNull();
    expect(latencyStats([{ ms: 120, time: 1 }])).toEqual({ count: 1, min: 120, avg: 120, max: 120, last: 120 });
    expect(latencyStats([{ ms: 100, time: 1 }, { ms: 301, time: 2 }, { ms: 50, time: 3 }])).toEqual({ count: 3, min: 50, avg: 150, max: 301, last: 50 });
  });

  it("keeps the last 20 tests of a relay", () => {
    let latency = {};
    for (let i = 0; i < 25; i++) latency = addLatency(latency, DEFAULT_RELAYS[0], { ms: i, time: i });
    const samples = (latency as Record<string, { ms: number }[]>)[DEFAULT_RELAYS[0]];
    expect(samples).toHaveLength(MAX_LATENCY_HISTORY);
    expect(latencyStats(samples as never)).toMatchObject({ min: 5, max: 24, last: 24 });
  });
});

describe("the resolve history", () => {
  const entries = [
    entry({ responseTimeMs: 100, rawSize: 200 }),
    entry({ responseTimeMs: 300, rawSize: 400, resolvedAt: Date.parse("2026-10-10T11:00:00Z") }),
    entry({ responseTimeMs: 50, rawSize: 300, relay: DEFAULT_RELAYS[1], resolvedAt: Date.parse("2026-10-12T11:00:00Z") }),
    entry({ responseTimeMs: 0, rawSize: 300, fromCache: true, resolvedAt: Date.parse("2026-10-12T11:01:00Z") }),
  ];

  it("gives totals and averages, cached answers left out of the times", () => {
    expect(historyStats([])).toEqual({ totalResolves: 0, avgResponseTimeMs: 0, avgPayloadSize: 0, relays: [] });
    expect(historyStats(entries)).toEqual({
      totalResolves: 4,
      avgResponseTimeMs: 150,
      avgPayloadSize: 300,
      relays: [
        { relay: DEFAULT_RELAYS[0], count: 2, avgResponseTimeMs: 200, minResponseTimeMs: 100, maxResponseTimeMs: 300 },
        { relay: DEFAULT_RELAYS[1], count: 1, avgResponseTimeMs: 50, minResponseTimeMs: 50, maxResponseTimeMs: 50 },
      ],
    });
  });

  it("counts resolves per day, with the empty days between", () => {
    const local = (iso: string) => new Date(iso).getTime();
    const days = resolvesPerDay([entry({ resolvedAt: local("2026-10-10T09:00:00") }), entry({ resolvedAt: local("2026-10-10T23:30:00") }), entry({ resolvedAt: local("2026-10-12T00:10:00") })]);
    expect(days).toEqual([{ day: "2026-10-10", count: 2 }, { day: "2026-10-11", count: 0 }, { day: "2026-10-12", count: 1 }]);
    expect(resolvesPerDay([])).toEqual([]);
  });

  it("keeps the last 1000", () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) list = addHistory(list, entry({ resolvedAt: i }));
    expect(list).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(list[0].resolvedAt).toBe(5);
  });

  it("exports as CSV", () => {
    const csv = historyCsv([entries[0], entries[3]]);
    expect(csv).toBe(
      '"Date","Key","Relay","Response Time (ms)","Payload Size (bytes)","From Cache","Record Count"\r\n' +
        `"2026-10-10T10:00:00.000Z","${KEY}","https://pkarr.pubky.org","100","200","false","3"\r\n` +
        `"2026-10-12T11:01:00.000Z","${KEY}","https://pkarr.pubky.org","0","300","true","3"\r\n`,
    );
    expect(historyCsv([])).toBe('"Date","Key","Relay","Response Time (ms)","Payload Size (bytes)","From Cache","Record Count"\r\n');
  });

  it("quotes a cell, and keeps a spreadsheet from running one as a formula", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("=HYPERLINK(1)")).toBe("\"'=HYPERLINK(1)\"");
    expect(csvCell("@cmd")).toBe("\"'@cmd\"");
    expect(csvCell(-5)).toBe('"-5"');
  });
});

describe("the cache and the newest timestamp seen", () => {
  const resolution = (key: string) => ({ publicKey: key, timestamp: 1, timestampMicros: "1000", records: [], rawSize: 100, relay: DEFAULT_RELAYS[0], responseTimeMs: 5, fromCache: false, outcomes: [] });

  it("serves an entry while it is fresh, and never when the cache is off", () => {
    const cache = withCached({}, resolution(KEY), 1000);
    expect(cached(cache, KEY, 60_000, 1000 + 60_000)?.resolution.publicKey).toBe(KEY);
    expect(cached(cache, KEY, 60_000, 1000 + 60_001)).toBeNull();
    expect(cached(cache, KEY, 0, 1000)).toBeNull();
    expect(cached(cache, keyOf(1), 60_000, 1000)).toBeNull();
  });

  it("keeps at most 50 entries, the oldest dropped", () => {
    let cache = {};
    for (let i = 0; i < MAX_CACHE_ENTRIES + 3; i++) cache = withCached(cache, resolution(keyOf(i + 1)), i);
    expect(Object.keys(cache)).toHaveLength(MAX_CACHE_ENTRIES);
    expect(cache).not.toHaveProperty(keyOf(1));
    expect(cache).toHaveProperty(keyOf(MAX_CACHE_ENTRIES + 3));
  });

  it("only ever raises the newest timestamp of a key", () => {
    let seen = withSeen({}, KEY, "1760000000000000");
    seen = withSeen(seen, KEY, "1750000000000000");
    expect(seen[KEY]).toBe("1760000000000000");
    seen = withSeen(seen, KEY, "1760000000000001");
    expect(seen[KEY]).toBe("1760000000000001");
  });
});

function sample(): AppData {
  const data = emptyData();
  data.settings = { requestTimeoutMs: 30_000, cacheTtlMs: 0, dohProvider: "quad9", locale: "pt-BR", autoRefresh: true, autoRefreshSeconds: 60 };
  data.favorites = addFavorite(addFavorite([], KEY, "Alice", 10), keyOf(2), "Bob's \"server\" <b>", 20);
  data.recent = addRecent(addRecent([], KEY, 30), keyOf(3), 40);
  data.relays = toggleRelay(addRelay(data.relays, "https://my.relay.example"), DEFAULT_RELAYS[1]);
  data.history = [entry(), entry({ fromCache: true, responseTimeMs: 0, resolvedAt: Date.parse("2026-10-11T10:00:00Z") })];
  data.latency = addLatency(addLatency({}, DEFAULT_RELAYS[0], { ms: 80, time: 1 }), "https://my.relay.example", { ms: 200, time: 2 });
  data.seen = { [KEY]: "1760000000000000" };
  return data;
}

describe("export and import", () => {
  it("brings everything back after a round trip through text", () => {
    const original = sample();
    const text = JSON.stringify(exportData(original, 123));
    const { data, counts } = importData(text, emptyData());
    expect(data).toEqual(original);
    expect(counts).toEqual({ favorites: 2, recent: 2, relays: 1, history: 2 });
    // And again, unchanged.
    expect(JSON.stringify(exportData(data, 123))).toBe(text);
  });

  it("takes a backup of the extension, and leaves what it does not hold as it is", () => {
    const extension = {
      version: 1,
      exportedAt: 1,
      favorites: [{ key: KEY, label: "Alice", createdAt: 5 }],
      recentKeys: [KEY],
      relayConfigs: [
        { url: "https://pkarr.pubky.org", enabled: false, isDefault: true },
        { url: "https://pkarr.pubky.app", enabled: true, isDefault: true },
        { url: "http://plain.relay.example", enabled: true, isDefault: false },
        { url: "https://custom.relay.example/", enabled: true, isDefault: false },
      ],
      settings: { autoRedirect: true, cacheTtlMs: 900_000, requestTimeoutMs: 10_000 },
    };
    const current = sample();
    const { data, counts } = importData(JSON.stringify(extension), current);
    expect(data.favorites).toEqual([{ key: KEY, label: "Alice", createdAt: 5 }]);
    expect(data.recent.map((e) => e.key)).toEqual([KEY]);
    // The plain-HTTP relay cannot be reached from the app and is left out; the third default is added.
    expect(data.relays).toEqual([
      { url: "https://pkarr.pubky.org", enabled: false, isDefault: true },
      { url: "https://pkarr.pubky.app", enabled: true, isDefault: true },
      { url: "https://pkarr.miguelmedeiros.dev", enabled: true, isDefault: true },
      { url: "https://custom.relay.example", enabled: true, isDefault: false },
    ]);
    expect(data.settings).toMatchObject({ cacheTtlMs: 900_000, requestTimeoutMs: 10_000, dohProvider: "cloudflare" });
    expect(data.history).toEqual(current.history);
    expect(counts).toEqual({ favorites: 1, recent: 1, relays: 1, history: 0 });
  });

  it("cleans what a backup holds: no bad key, no odd setting, no relay off HTTPS, no extra field", () => {
    const hostile = {
      version: 1,
      favorites: [{ key: "nope", label: "x" }, { key: KEY, label: "L".repeat(500), createdAt: "soon", evil: true }, { key: KEY, label: "again" }, null, 7],
      recentKeys: [{ key: KEY, searchedAt: -1 }, { key: 42 }],
      relayConfigs: [{ url: "javascript:alert(1)" }, { url: "https://ok.example", enabled: "yes" }, "https://text.example"],
      settings: { requestTimeoutMs: 1, cacheTtlMs: 1e12, dohProvider: "https://evil.example/dns-query", locale: {}, autoRefreshSeconds: 0.001 },
      resolveHistory: [{ key: KEY, resolvedAt: 5, rawSize: "big", relay: 9, fromCache: "true", recordCount: -3 }, { key: KEY }, { key: "bad", resolvedAt: 1 }],
      latencyHistory: { "http://plain.example": [{ ms: 1, time: 1 }], "https://ok.example": [{ ms: "fast", time: 1 }, { ms: 12, time: 3 }] },
      seen: { [KEY]: "12x", [keyOf(4)]: "55" },
      __proto__: { polluted: true },
    };
    const { data } = importData(JSON.stringify(hostile), emptyData());
    expect(data.favorites).toEqual([{ key: KEY, label: "L".repeat(80), createdAt: 0 }]);
    expect(data.recent).toHaveLength(1);
    expect(data.relays.filter((r) => !r.isDefault)).toEqual([{ url: "https://ok.example", enabled: true, isDefault: false }]);
    expect(data.settings).toEqual(emptyData().settings);
    expect(data.history).toEqual([{ key: KEY, resolvedAt: 5, rawSize: 0, responseTimeMs: 0, relay: "", fromCache: false, recordCount: 0 }]);
    expect(data.latency).toEqual({ "https://ok.example": [{ ms: 12, time: 3 }] });
    expect(data.seen).toEqual({ [keyOf(4)]: "55" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never lowers a newest timestamp by importing", () => {
    const current = sample();
    const { data } = importData(JSON.stringify({ version: 1, seen: { [KEY]: "5", [keyOf(4)]: "9" } }), current);
    expect(data.seen).toEqual({ [keyOf(4)]: "9", [KEY]: "1760000000000000" });
  });

  it("refuses what is not a backup", () => {
    const code = (text: string) => {
      try {
        importData(text, emptyData());
        return "ok";
      } catch (error) {
        return (error as BackupError).code;
      }
    };
    expect(code("not json")).toBe("not-json");
    expect(code("[]")).toBe("not-a-backup");
    expect(code("null")).toBe("not-a-backup");
    expect(code('{"favorites":[]}')).toBe("not-a-backup");
    expect(code(`{"version":1,"x":"${"a".repeat(4 * 1024 * 1024)}"}`)).toBe("too-large");
  });
});

describe("the store", () => {
  it("cuts a long list into pieces under the broker's 64 KiB a value", () => {
    const items = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => entry({ resolvedAt: i, relay: `https://${"r".repeat(200)}.example` }));
    const chunks = chunk(items);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(items);
    for (const piece of chunks) expect(new TextEncoder().encode(JSON.stringify(piece)).length).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(chunk([])).toEqual([]);
  });

  it("writes everything and reads it back, a full history and cache included", async () => {
    const backend = memoryBackend();
    const store = new Store(backend, true);
    const data = sample();
    data.history = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => entry({ resolvedAt: i + 1 }));
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      const key = keyOf(i + 1);
      const records = Array.from({ length: 12 }, (_, n) => ({ name: `n${n}`, type: "TXT", ttl: 300, value: "v".repeat(70) }));
      data.cache = withCached(data.cache, { publicKey: key, timestamp: 5, timestampMicros: "5000", records, rawSize: 900, relay: DEFAULT_RELAYS[0], responseTimeMs: 9, fromCache: false, outcomes: [] }, i);
    }
    store.bind(() => data);
    store.save(...Store.parts);
    await store.flush();
    expect([...backend.map.keys()].filter((k) => k.startsWith("history.")).length).toBeGreaterThan(1);

    const loaded = await new Store(backend, true).load();
    expect(loaded).toEqual(data);
  });

  it("removes the pieces a shorter list no longer needs", async () => {
    const backend = memoryBackend();
    const store = new Store(backend, true);
    const data = emptyData();
    data.history = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => entry({ resolvedAt: i + 1 }));
    store.bind(() => data);
    store.save("history");
    await store.flush();
    const before = [...backend.map.keys()].length;
    data.history = [entry()];
    store.save("history");
    await store.flush();
    expect(before).toBeGreaterThan(2);
    expect([...backend.map.keys()]).toEqual(["history.0"]);
    // A second store that starts from what is there also knows how many pieces to remove.
    const second = new Store(backend, true);
    const again = await second.load();
    again.history = [];
    second.bind(() => again);
    second.save("history");
    await second.flush();
    expect([...backend.map.keys()]).toEqual([]);
  });

  it("reports a refused write and keeps going", async () => {
    const backend = memoryBackend();
    const refused: string[] = [];
    const store = new Store({ ...backend, set: async (key, value) => (key === "favorites" ? Promise.reject(new Error("full")) : backend.set(key, value)) }, true);
    store.onError = (code) => refused.push(code);
    const data = sample();
    store.bind(() => data);
    store.save("favorites", "recent");
    await store.flush();
    expect(refused).toEqual(["full"]);
    expect(backend.map.has("recent")).toBe(true);
  });

  it("clears every key", async () => {
    const backend = memoryBackend();
    const store = new Store(backend, true);
    const data = sample();
    store.bind(() => data);
    store.save(...Store.parts);
    await store.clear();
    expect(backend.map.size).toBe(0);
    expect(await store.load()).toEqual(emptyData());
  });
});
