// Asking relays: every answer is checked, the newest signed record wins, and a relay that lies only loses.
import { describe, expect, it } from "vitest";
import { DOH, dohLookup } from "../src/lib/doh";
import { encodeName } from "../src/lib/dnswire";
import { resolveFromRelays, testRelay } from "../src/lib/resolver";
import { dnsPacket, micros, signedPayload, testKey } from "./packets";

const owner = testKey(7);
const NOW = Date.parse("2026-10-12T12:00:00Z");
const packet = (ip: number) => dnsPacket([{ name: owner.key, type: 1, data: Uint8Array.from([203, 0, 113, ip]) }]);
const payloadAt = (iso: string, ip = 1) => signedPayload(owner, micros(iso), packet(ip));

type Reply = { status?: number; body?: Uint8Array; delayMs?: number; fail?: boolean };

/** A fetch that answers from a table by relay host, and records what was asked. */
function fakeFetch(replies: Record<string, Reply>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const doFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    asked.push(url);
    const reply = replies[new URL(url).host] ?? { fail: true };
    if (reply.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, reply.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (reply.fail) throw new TypeError("Failed to fetch");
    return new Response(reply.body as BodyInit | undefined, { status: reply.status ?? 200 });
  };
  return { fetch: doFetch as typeof fetch, asked };
}

const A = "https://a.relay.test";
const B = "https://b.relay.test";
const C = "https://c.relay.test";
const options = (fetch: typeof globalThis.fetch, more = {}) => ({ timeoutMs: 500, graceMs: 100, nowMs: NOW, fetch, ...more });

describe("resolving a key", () => {
  it("asks every relay for the key and takes a signed answer", async () => {
    const { fetch, asked } = fakeFetch({ "a.relay.test": { body: payloadAt("2026-10-12T10:00:00Z") }, "b.relay.test": { status: 404 } });
    const result = await resolveFromRelays(owner.key, [A, B], options(fetch));
    expect(asked.sort()).toEqual([`${A}/${owner.key}`, `${B}/${owner.key}`]);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.resolution).toMatchObject({ publicKey: owner.key, relay: A, fromCache: false, timestampMicros: String(micros("2026-10-12T10:00:00Z")) });
    expect(result.resolution.records).toEqual([{ name: "@", type: "A", ttl: 300, value: "203.0.113.1" }]);
    expect(result.resolution.outcomes.map((o) => o.status)).toEqual(["ok", "not-found"]);
  });

  it("takes the newest record when relays disagree, and marks the relay that is behind", async () => {
    const { fetch } = fakeFetch({
      "a.relay.test": { body: payloadAt("2026-10-11T10:00:00Z", 1) },
      "b.relay.test": { body: payloadAt("2026-10-12T10:00:00Z", 2), delayMs: 30 },
    });
    const result = await resolveFromRelays(owner.key, [A, B], options(fetch));
    expect(result.status === "found" && result.resolution.relay).toBe(B);
    expect(result.status === "found" && result.resolution.records[0].value).toBe("203.0.113.2");
    expect(result.status === "found" && result.resolution.outcomes[0]).toMatchObject({ relay: A, status: "ok", detail: "older" });
  });

  it("refuses a forged answer and still resolves from an honest relay", async () => {
    const forged = payloadAt("2026-10-12T11:00:00Z", 66);
    forged[forged.length - 1] = 99; // the relay changed the address
    const { fetch } = fakeFetch({ "a.relay.test": { body: forged }, "b.relay.test": { body: payloadAt("2026-10-12T10:00:00Z", 2), delayMs: 20 } });
    const result = await resolveFromRelays(owner.key, [A, B], options(fetch));
    expect(result.status === "found" && result.resolution.relay).toBe(B);
    expect(result.status === "found" && result.resolution.outcomes[0]).toMatchObject({ relay: A, status: "refused", detail: "bad-signature" });
  });

  it("fails, with no records, when the only answers are forged, replayed or too large", async () => {
    const forged = payloadAt("2026-10-12T11:00:00Z");
    forged[0] ^= 1;
    const { fetch } = fakeFetch({
      "a.relay.test": { body: forged },
      "b.relay.test": { body: payloadAt("2026-10-01T10:00:00Z") },
      "c.relay.test": { body: new Uint8Array(5000) },
    });
    const result = await resolveFromRelays(owner.key, [A, B, C], options(fetch, { newestSeenMicros: String(micros("2026-10-12T10:00:00Z")) }));
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.outcomes.map((o) => [o.status, o.detail])).toEqual([["refused", "bad-signature"], ["refused", "stale"], ["refused", "too-large"]]);
  });

  it("says not found when a relay answers 404 and none has the key", async () => {
    const { fetch } = fakeFetch({ "a.relay.test": { status: 404 }, "b.relay.test": { fail: true }, "c.relay.test": { status: 500 } });
    const result = await resolveFromRelays(owner.key, [A, B, C], options(fetch));
    expect(result.status).toBe("not-found");
    expect(result.status === "not-found" && result.outcomes.map((o) => [o.status, o.detail])).toEqual([["not-found", undefined], ["error", "unreachable"], ["error", "HTTP 500"]]);
  });

  it("stops waiting for a relay at the timeout", async () => {
    const { fetch } = fakeFetch({ "a.relay.test": { body: payloadAt("2026-10-12T10:00:00Z"), delayMs: 2000 } });
    const started = Date.now();
    const result = await resolveFromRelays(owner.key, [A], options(fetch, { timeoutMs: 60 }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.status === "failed" && result.outcomes[0]).toMatchObject({ status: "error", detail: "timeout" });
  });

  it("does not wait long for a slow relay once another has answered", async () => {
    const { fetch } = fakeFetch({ "a.relay.test": { body: payloadAt("2026-10-12T10:00:00Z") }, "b.relay.test": { status: 404, delayMs: 3000 } });
    const started = Date.now();
    const result = await resolveFromRelays(owner.key, [A, B], options(fetch, { timeoutMs: 5000, graceMs: 50 }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.status === "found" && result.resolution.outcomes[1]).toMatchObject({ relay: B, status: "pending" });
  });
});

describe("testing a relay", () => {
  it("measures any answer, and throws when there is none", async () => {
    const { fetch, asked } = fakeFetch({ "a.relay.test": { delayMs: 20 }, "b.relay.test": { fail: true }, "c.relay.test": { status: 502 } });
    expect(await testRelay(A, 500, fetch)).toBeGreaterThanOrEqual(15);
    expect(asked).toEqual([`${A}/`]);
    await expect(testRelay(B, 500, fetch)).rejects.toThrow();
    await expect(testRelay(C, 500, fetch)).rejects.toThrow("HTTP 502");
  });
});

describe("a DNS over HTTPS lookup", () => {
  /** A resolver that answers A for example.com and nothing for the other types. */
  const resolver = async (input: RequestInfo | URL): Promise<Response> => {
    const query = Uint8Array.from(atob(new URL(String(input)).searchParams.get("dns")!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const type = (query[query.length - 4] << 8) | query[query.length - 3];
    const question = [{ name: "example.com", type }];
    const answers = type === 1 ? [{ name: "example.com", type: 1, data: Uint8Array.from([192, 0, 2, 44]) }] : type === 16 ? [{ name: "example.com", type: 16, data: Uint8Array.from([3, 0x76, 0x3d, 0x31]) }] : [];
    if (type === 65) return new Response(null, { status: 500 });
    return new Response(dnsPacket(answers, question) as BodyInit);
  };

  it("asks each type and shows what came, naming the resolver", async () => {
    const result = await dohLookup("https://Example.com/", DOH.quad9, 500, resolver as typeof fetch);
    expect(result.name).toBe("example.com");
    expect(result.provider.name).toBe("Quad9 (9.9.9.9)");
    expect(result.records).toEqual([
      { name: "example.com", type: "A", ttl: 300, value: "192.0.2.44" },
      { name: "example.com", type: "TXT", ttl: 300, value: "v=1" },
    ]);
    expect(result.failed).toEqual(["HTTPS"]);
    expect(result.noSuchName).toBe(false);
  });

  it("refuses a name that is not one, and fails when the resolver is unreachable", async () => {
    await expect(dohLookup("not a name", DOH.cloudflare, 500, resolver as typeof fetch)).rejects.toThrow("bad-name");
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(dohLookup("example.com", DOH.google, 500, down)).rejects.toThrow("unreachable");
    expect(encodeName("example.com")).toHaveLength(13);
  });
});
