/**
 * The charts, drawn as plain SVG and HTML strings: a line chart (one or more series over the same steps), a column
 * chart and a horizontal bar list. No library. Colours come from the page's CSS variables (--series-1…, style.css),
 * so a chart follows the theme. Every mark that carries a value has a `data-tip`, which the page shows on hover and
 * on focus (ui/tooltip in app.ts).
 */
import { escapeHtml } from "../lib/i18n";

/** A round number at or above `value`, for the top of an axis: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

export interface Series {
  name: string;
  /** 1 to 8: the slot in the categorical palette. It belongs to the series, whatever else is shown. */
  slot: number;
  values: (number | null)[];
}

export interface LineChartOptions {
  width: number;
  height?: number;
  /** One label per step, for the tooltip; the first and last also stand under the axis. */
  labels: string[];
  series: Series[];
  format: (value: number) => string;
  /** What the chart shows, read by a screen reader. */
  title: string;
}

const MAX_FOCUS_STEPS = 24;
const PAD = { top: 10, right: 12, bottom: 22, left: 46 };

function frame(width: number, height: number, max: number, format: (v: number) => string): { plotW: number; plotH: number; grid: string } {
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  let grid = "";
  for (const fraction of [0, 0.5, 1]) {
    const y = PAD.top + plotH * (1 - fraction);
    grid += `<line class="${fraction === 0 ? "axis" : "grid"}" x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${y}" y2="${y}"/>`;
    grid += `<text class="tick" x="${PAD.left - 6}" y="${y + 3.5}" text-anchor="end">${escapeHtml(format(max * fraction))}</text>`;
  }
  return { plotW, plotH, grid };
}

export function lineChart({ width, height = 180, labels, series, format, title }: LineChartOptions): string {
  const steps = labels.length;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = niceMax(Math.max(0, ...all));
  const { plotW, plotH, grid } = frame(width, height, max, format);
  const x = (i: number) => PAD.left + (steps <= 1 ? plotW / 2 : (plotW * i) / (steps - 1));
  const y = (v: number) => PAD.top + plotH * (1 - v / max);
  const round = (n: number) => Math.round(n * 10) / 10;

  let lines = "";
  for (const s of series) {
    let path = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) return void (pen = false);
      path += `${pen ? "L" : "M"}${round(x(i))} ${round(y(v))}`;
      pen = true;
    });
    if (path) lines += `<path class="line" style="stroke:var(--series-${s.slot})" d="${path}"/>`;
    // A lone point has no line to show it.
    if (s.values.filter((v) => v !== null).length === 1) {
      const i = s.values.findIndex((v) => v !== null);
      lines += `<circle r="3" cx="${round(x(i))}" cy="${round(y(s.values[i]!))}" style="fill:var(--series-${s.slot})"/>`;
    }
  }

  // One hover column per step: a crosshair, a dot on each series, and the values as the tip.
  // Reachable by Tab while the steps are few; a long history is read from the table under the charts instead of
  // through hundreds of stops.
  let hits = "";
  const focusable = steps <= MAX_FOCUS_STEPS ? ' tabindex="0"' : "";
  const columnW = steps <= 1 ? plotW : plotW / (steps - 1);
  for (let i = 0; i < steps; i++) {
    const present = series.filter((s) => s.values[i] !== null && s.values[i] !== undefined);
    if (!present.length) continue;
    const tip = [labels[i], ...present.map((s) => (series.length > 1 ? `${s.name}: ${format(s.values[i]!)}` : format(s.values[i]!)))].join("\n");
    const dots = present.map((s) => `<circle class="dot" r="4" cx="${round(x(i))}" cy="${round(y(s.values[i]!))}" style="fill:var(--series-${s.slot})"/>`).join("");
    hits += `<g class="hit"${focusable} data-tip="${escapeHtml(tip)}"><rect x="${round(x(i) - columnW / 2)}" y="${PAD.top}" width="${round(columnW)}" height="${plotH}"/><line class="cross" x1="${round(x(i))}" x2="${round(x(i))}" y1="${PAD.top}" y2="${PAD.top + plotH}"/>${dots}</g>`;
  }

  const axisY = height - 6;
  const ends = steps
    ? `<text class="tick" x="${PAD.left}" y="${axisY}">${escapeHtml(labels[0])}</text>` +
      (steps > 1 ? `<text class="tick" x="${PAD.left + plotW}" y="${axisY}" text-anchor="end">${escapeHtml(labels[steps - 1])}</text>` : "")
    : "";
  const legend = series.length > 1 ? `<ul class="legend">${series.map((s) => `<li><span class="swatch" style="background:var(--series-${s.slot})"></span>${escapeHtml(s.name)}</li>`).join("")}</ul>` : "";
  return `<svg class="chart" role="img" aria-label="${escapeHtml(title)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${grid}${lines}${ends}${hits}</svg>${legend}`;
}

export interface ColumnChartOptions {
  width: number;
  height?: number;
  columns: { label: string; value: number }[];
  format: (value: number) => string;
  title: string;
}

/** Columns from a zero baseline, 2 px apart, rounded at the top only. */
export function columnChart({ width, height = 180, columns, format, title }: ColumnChartOptions): string {
  const max = niceMax(Math.max(0, ...columns.map((c) => c.value)));
  const { plotW, plotH, grid } = frame(width, height, max, format);
  const slot = plotW / Math.max(1, columns.length);
  const barW = Math.max(1, Math.min(28, slot - 2));
  const round = (n: number) => Math.round(n * 10) / 10;
  let bars = "";
  columns.forEach((c, i) => {
    const h = plotH * (c.value / max);
    const x = PAD.left + slot * i + (slot - barW) / 2;
    const y = PAD.top + plotH - h;
    const r = Math.min(4, barW / 2, h);
    const shape = h > 0 ? `<path class="bar" d="M${round(x)} ${round(y + h)}V${round(y + r)}a${r} ${r} 0 0 1 ${r} ${-r}h${round(barW - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}V${round(y + h)}z"/>` : "";
    bars += `<g class="hit" tabindex="0" data-tip="${escapeHtml(`${c.label}\n${format(c.value)}`)}"><rect x="${round(PAD.left + slot * i)}" y="${PAD.top}" width="${round(slot)}" height="${plotH}"/>${shape}</g>`;
  });
  const axisY = height - 6;
  const ends = columns.length
    ? `<text class="tick" x="${PAD.left}" y="${axisY}">${escapeHtml(columns[0].label)}</text>` +
      (columns.length > 1 ? `<text class="tick" x="${PAD.left + plotW}" y="${axisY}" text-anchor="end">${escapeHtml(columns[columns.length - 1].label)}</text>` : "")
    : "";
  return `<svg class="chart" role="img" aria-label="${escapeHtml(title)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${grid}${bars}${ends}</svg>`;
}

export interface BarRow {
  label: string;
  value: number;
  /** The value as text, shown at the end of the row. */
  text: string;
  /** More about the row (min, average, max), shown on hover and focus. */
  tip: string;
  /** With a slot the bar has that series' colour; without, the single-series one. */
  slot?: number;
}

/** A horizontal bar per row, longest value full width: label, bar, value. HTML, so long labels wrap or clip by CSS. */
export function barList(rows: BarRow[], title: string): string {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  const items = rows
    .map((r) => {
      const fill = r.slot ? ` style="width:${Math.max(1, (100 * r.value) / max).toFixed(1)}%;background:var(--series-${r.slot})"` : ` style="width:${Math.max(1, (100 * r.value) / max).toFixed(1)}%"`;
      return `<li class="bar-row" tabindex="0" data-tip="${escapeHtml(r.tip)}"><span class="bar-label">${escapeHtml(r.label)}</span><span class="bar-track"><span class="bar-fill"${fill}></span></span><span class="bar-value">${escapeHtml(r.text)}</span></li>`;
    })
    .join("");
  return `<ul class="bar-list" aria-label="${escapeHtml(title)}">${items}</ul>`;
}
