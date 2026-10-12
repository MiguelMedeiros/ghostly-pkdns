/**
 * Asking relays for a key. Every enabled relay is asked at once, and every answer goes through the payload check
 * (payload.ts) before it counts. Among the answers that pass, the one with the newest signed timestamp wins, so a
 * relay that serves an old record loses to one that serves the current one; a tie goes to the faster relay.
 */
import type { RelayOutcome, Resolution } from "./model";
import { PayloadError, type VerifiedPayload, verifyPayload } from "./payload";

/** A relay's answer is read up to this many bytes: a payload is at most 72 + 1000. */
export const MAX_RESPONSE_BYTES = 2048;
/** After the first good answer, how long the other relays still have to send a newer one. */
export const DEFAULT_GRACE_MS = 1200;

export interface ResolveOptions {
  timeoutMs: number;
  graceMs?: number;
  /** The newest timestamp already seen for the key (decimal microseconds). */
  newestSeenMicros?: string;
  fetch?: typeof fetch;
  nowMs?: number;
}

export type ResolveResult =
  | { status: "found"; resolution: Resolution }
  /** No relay had the key (at least one said so, none had a valid record). */
  | { status: "not-found"; outcomes: RelayOutcome[] }
  /** Every relay failed or was refused. */
  | { status: "failed"; outcomes: RelayOutcome[] };

/** A response's body, refused past `limit` bytes without reading the rest. */
export async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("too-large");
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("too-large");
    return bytes;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      void reader.cancel();
      throw new Error("too-large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const REQUEST: RequestInit = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };

interface RelayAnswer {
  outcome: RelayOutcome;
  payload?: VerifiedPayload;
}

async function askRelay(relay: string, key: string, signal: AbortSignal, options: ResolveOptions): Promise<RelayAnswer> {
  const doFetch = options.fetch ?? fetch;
  const start = performance.now();
  const took = () => Math.round(performance.now() - start);
  try {
    const response = await doFetch(`${relay}/${key}`, { ...REQUEST, signal });
    if (response.status === 404) return { outcome: { relay, status: "not-found", ms: took() } };
    if (!response.ok) return { outcome: { relay, status: "error", ms: took(), detail: `HTTP ${response.status}` } };
    const bytes = await readCapped(response, MAX_RESPONSE_BYTES);
    const ms = took();
    try {
      const newest = options.newestSeenMicros === undefined ? undefined : BigInt(options.newestSeenMicros);
      const payload = verifyPayload(key, bytes, { newestSeenMicros: newest, nowMs: options.nowMs });
      return { outcome: { relay, status: "ok", ms }, payload };
    } catch (error) {
      if (error instanceof PayloadError) return { outcome: { relay, status: "refused", ms, detail: error.code } };
      throw error;
    }
  } catch (error) {
    const aborted = signal.aborted;
    const detail = aborted ? String(signal.reason ?? "timeout") : error instanceof Error && error.message === "too-large" ? "too-large" : "unreachable";
    return { outcome: { relay, status: detail === "too-large" ? "refused" : aborted && detail === "not-waited" ? "pending" : "error", ms: took(), detail } };
  }
}

export async function resolveFromRelays(key: string, relays: readonly string[], options: ResolveOptions): Promise<ResolveResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), options.timeoutMs);
  let grace: ReturnType<typeof setTimeout> | null = null;
  const answers = await Promise.all(
    relays.map((relay) =>
      askRelay(relay, key, controller.signal, options).then((answer) => {
        if (answer.payload && !grace) grace = setTimeout(() => controller.abort("not-waited"), options.graceMs ?? DEFAULT_GRACE_MS);
        return answer;
      }),
    ),
  );
  clearTimeout(timeout);
  if (grace) clearTimeout(grace);

  const outcomes = answers.map((a) => a.outcome);
  let best: RelayAnswer | null = null;
  for (const answer of answers) {
    if (!answer.payload) continue;
    const newer = !best || answer.payload.timestampMicros > best.payload!.timestampMicros;
    const faster = best && answer.payload.timestampMicros === best.payload!.timestampMicros && (answer.outcome.ms ?? 0) < (best.outcome.ms ?? 0);
    if (newer || faster) best = answer;
  }
  if (best?.payload) {
    // An answer that passed but is older than the winner: the relay is behind, and the list says so.
    for (const answer of answers) {
      if (answer.payload && answer.payload.timestampMicros < best.payload.timestampMicros) answer.outcome.detail = "older";
    }
    const { payload, outcome } = best;
    return {
      status: "found",
      resolution: {
        publicKey: key,
        timestamp: payload.timestampMs,
        timestampMicros: payload.timestampMicros.toString(),
        records: payload.records,
        rawSize: payload.rawSize,
        relay: outcome.relay,
        responseTimeMs: outcome.ms ?? 0,
        fromCache: false,
        outcomes,
      },
    };
  }
  return { status: outcomes.some((o) => o.status === "not-found") ? "not-found" : "failed", outcomes };
}

/** How long a relay takes to answer anything at all (its front page). Throws when it does not answer. */
export async function testRelay(url: string, timeoutMs: number, doFetch: typeof fetch = fetch): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const start = performance.now();
  try {
    const response = await doFetch(`${url}/`, { ...REQUEST, signal: controller.signal });
    await response.body?.cancel().catch(() => {});
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    return Math.round(performance.now() - start);
  } finally {
    clearTimeout(timeout);
  }
}
