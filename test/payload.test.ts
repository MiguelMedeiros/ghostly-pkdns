// The payload check: a relay's answer is taken only when the key's owner signed it, and never an older one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PayloadError, type PayloadRefusal, signable, verifyPayload } from "../src/lib/payload";
import { dnsPacket, micros, signableBytes, signedPayload, testKey, txt } from "./packets";

const owner = testKey(7);
const NOW = Date.parse("2026-10-12T12:00:00Z");
const at = micros("2026-10-12T11:00:00Z");
const packet = (key = owner.key) =>
  dnsPacket([
    { name: key, type: 1, ttl: 3600, data: Uint8Array.from([203, 0, 113, 7]) },
    { name: `_pubky.${key}`, type: 16, ttl: 300, data: txt("hello") },
  ]);

/** The refusal code of a payload, or "accepted". */
function outcome(key: string, payload: Uint8Array, options = {}): PayloadRefusal | "accepted" {
  try {
    verifyPayload(key, payload, { nowMs: NOW, ...options });
    return "accepted";
  } catch (error) {
    if (error instanceof PayloadError) return error.code;
    throw error;
  }
}

describe("the bytes that are signed", () => {
  it("are the BEP 44 form: the timestamp as seq, then the packet as v", () => {
    const dns = Uint8Array.from([1, 2, 3]);
    expect(new TextDecoder().decode(signable(1234n, dns).subarray(0, 18))).toBe("3:seqi1234e1:v3:\u0001\u0002");
    expect(signable(at, packet())).toEqual(signableBytes(at, packet()));
  });
});

describe("a relay's answer", () => {
  it("is accepted when the owner signed it, and read", () => {
    const result = verifyPayload(owner.key, signedPayload(owner, at, packet()), { nowMs: NOW });
    expect(result.publicKey).toBe(owner.key);
    expect(result.timestampMicros).toBe(at);
    expect(result.timestampMs).toBe(Date.parse("2026-10-12T11:00:00Z"));
    expect(result.rawSize).toBe(72 + packet().length);
    expect(result.records).toEqual([
      { name: "@", type: "A", ttl: 3600, value: "203.0.113.7" },
      { name: "_pubky", type: "TXT", ttl: 300, value: "hello" },
    ]);
  });

  it("is accepted for a real packet a relay served (recorded 2026-10-12)", () => {
    const real = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures/pkarr-7fmjpcuu.bin")));
    const result = verifyPayload("7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy", real, { nowMs: NOW });
    expect(result.rawSize).toBe(319);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it("is refused when one bit of the signature is changed", () => {
    const payload = signedPayload(owner, at, packet());
    payload[5] ^= 1;
    expect(outcome(owner.key, payload)).toBe("bad-signature");
  });

  it("is refused when a record is changed after signing", () => {
    const payload = signedPayload(owner, at, packet());
    payload[payload.length - 1] ^= 1;
    expect(outcome(owner.key, payload)).toBe("bad-signature");
  });

  it("is refused when the timestamp is changed after signing", () => {
    const payload = signedPayload(owner, at, packet());
    payload[71] ^= 1;
    expect(outcome(owner.key, payload)).toBe("bad-signature");
  });

  it("is refused when another key signed it", () => {
    const other = testKey(9);
    expect(outcome(owner.key, signedPayload(other, at, packet()))).toBe("bad-signature");
  });

  it("is refused when it is older than the newest one already seen for the key", () => {
    const old = signedPayload(owner, at - 1n, packet());
    expect(outcome(owner.key, old, { newestSeenMicros: at })).toBe("stale");
    // The same record again is not older.
    expect(outcome(owner.key, signedPayload(owner, at, packet()), { newestSeenMicros: at })).toBe("accepted");
    expect(outcome(owner.key, signedPayload(owner, at + 1n, packet()), { newestSeenMicros: at })).toBe("accepted");
  });

  it("is refused when its timestamp is far in the future", () => {
    const tomorrow = micros("2026-10-13T12:00:00Z");
    expect(outcome(owner.key, signedPayload(owner, tomorrow, packet()))).toBe("future");
    // A clock a few minutes ahead is not far.
    expect(outcome(owner.key, signedPayload(owner, micros("2026-10-12T12:05:00Z"), packet()))).toBe("accepted");
  });

  it("is refused when it is cut short", () => {
    const payload = signedPayload(owner, at, packet());
    expect(outcome(owner.key, payload.subarray(0, 40))).toBe("too-short");
    expect(outcome(owner.key, payload.subarray(0, 72))).toBe("too-short");
    expect(outcome(owner.key, payload.subarray(0, 80))).toBe("too-short");
    expect(outcome(owner.key, new Uint8Array(0))).toBe("too-short");
    // Cut inside the packet: the signature no longer covers what is left.
    expect(outcome(owner.key, payload.subarray(0, payload.length - 3))).toBe("bad-signature");
  });

  it("is refused when the signed packet itself is cut short or not DNS", () => {
    const cut = packet().subarray(0, packet().length - 3);
    expect(outcome(owner.key, signedPayload(owner, at, cut))).toBe("bad-packet");
    const lying = packet();
    lying[7] = 9; // says nine answers, has two
    expect(outcome(owner.key, signedPayload(owner, at, lying))).toBe("bad-packet");
  });

  it("is refused when the packet is over Pkarr's 1000 bytes", () => {
    const big = dnsPacket(Array.from({ length: 5 }, (_, i) => ({ name: `t${i}.${owner.key}`, type: 16, data: txt("x".repeat(250)) })));
    expect(big.length).toBeGreaterThan(1000);
    expect(outcome(owner.key, signedPayload(owner, at, big))).toBe("too-large");
  });

  it("is refused for a key that is not a key", () => {
    expect(outcome("not-a-key", signedPayload(owner, at, packet()))).toBe("bad-key");
  });
});
