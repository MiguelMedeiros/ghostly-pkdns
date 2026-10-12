/** Numbers for the History and Relays pages: totals, averages, per-relay and per-day figures, and the CSV. */
import type { HistoryEntry, LatencySample } from "./model";

export interface LatencyStats {
  count: number;
  min: number;
  avg: number;
  max: number;
  /** The most recent sample. */
  last: number;
}

/** Min, average (rounded) and max of a relay's test results, or null when it has none. */
export function latencyStats(samples: readonly LatencySample[]): LatencyStats | null {
  if (!samples.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const { ms } of samples) {
    if (ms < min) min = ms;
    if (ms > max) max = ms;
    sum += ms;
  }
  return { count: samples.length, min, avg: Math.round(sum / samples.length), max, last: samples[samples.length - 1].ms };
}

export interface RelayPerformance {
  relay: string;
  count: number;
  avgResponseTimeMs: number;
  minResponseTimeMs: number;
  maxResponseTimeMs: number;
}

export interface HistoryStats {
  totalResolves: number;
  /** Over answers that came from a relay: a cached one took no time. */
  avgResponseTimeMs: number;
  avgPayloadSize: number;
  relays: RelayPerformance[];
}

export function historyStats(entries: readonly HistoryEntry[]): HistoryStats {
  const fresh = entries.filter((e) => !e.fromCache);
  const mean = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0);
  const byRelay = new Map<string, number[]>();
  for (const e of fresh) byRelay.set(e.relay, [...(byRelay.get(e.relay) ?? []), e.responseTimeMs]);
  const relays = [...byRelay].map(([relay, times]) => ({
    relay,
    count: times.length,
    avgResponseTimeMs: mean(times),
    minResponseTimeMs: Math.min(...times),
    maxResponseTimeMs: Math.max(...times),
  }));
  relays.sort((a, b) => b.count - a.count || a.avgResponseTimeMs - b.avgResponseTimeMs);
  return { totalResolves: entries.length, avgResponseTimeMs: mean(fresh.map((e) => e.responseTimeMs)), avgPayloadSize: mean(entries.map((e) => e.rawSize)), relays };
}

/** The local calendar day of a time, as YYYY-MM-DD. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Resolves per local day, oldest first, with the days between that had none (at most the last `maxDays`). */
export function resolvesPerDay(entries: readonly HistoryEntry[], maxDays = 30): { day: string; count: number }[] {
  if (!entries.length) return [];
  const counts = new Map<string, number>();
  let first = Infinity;
  let last = -Infinity;
  for (const e of entries) {
    counts.set(dayOf(e.resolvedAt), (counts.get(dayOf(e.resolvedAt)) ?? 0) + 1);
    if (e.resolvedAt < first) first = e.resolvedAt;
    if (e.resolvedAt > last) last = e.resolvedAt;
  }
  const days: { day: string; count: number }[] = [];
  const cursor = new Date(first);
  cursor.setHours(12, 0, 0, 0);
  const end = dayOf(last);
  for (let i = 0; i < 3660; i++) {
    const day = dayOf(cursor.getTime());
    days.push({ day, count: counts.get(day) ?? 0 });
    if (day === end) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days.slice(-maxDays);
}

export const CSV_HEADERS = ["Date", "Key", "Relay", "Response Time (ms)", "Payload Size (bytes)", "From Cache", "Record Count"] as const;

/**
 * One CSV cell (RFC 4180): quoted, a quote doubled. A text that a spreadsheet would run as a formula (it starts with
 * =, +, - or @) gets an apostrophe first: a relay's address is the person's own text, but a backup can bring any.
 */
export function csvCell(value: string | number | boolean): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** The history as CSV, the same columns as the extension's export, lines ended by CRLF. */
export function historyCsv(entries: readonly HistoryEntry[]): string {
  const rows = entries.map((e) => [new Date(e.resolvedAt).toISOString(), e.key, e.relay, e.responseTimeMs, e.rawSize, e.fromCache, e.recordCount]);
  return [CSV_HEADERS.map(csvCell), ...rows.map((row) => row.map(csvCell))].map((row) => row.join(",")).join("\r\n") + "\r\n";
}
