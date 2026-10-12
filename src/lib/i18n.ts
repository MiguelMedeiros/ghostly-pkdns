/**
 * The app's texts in nine languages. Each language is the extension's locale file (src/locales/<code>.json) with this
 * app's own texts over it (src/locales/extra/<code>.json: new strings, and the few that spoke of "the extension").
 * Everything is in the bundle: an app loads nothing by URL.
 */
import ar from "../locales/ar.json";
import de from "../locales/de.json";
import en from "../locales/en.json";
import es from "../locales/es.json";
import arExtra from "../locales/extra/ar.json";
import deExtra from "../locales/extra/de.json";
import enExtra from "../locales/extra/en.json";
import esExtra from "../locales/extra/es.json";
import frExtra from "../locales/extra/fr.json";
import itExtra from "../locales/extra/it.json";
import jaExtra from "../locales/extra/ja.json";
import ptBRExtra from "../locales/extra/pt-BR.json";
import zhExtra from "../locales/extra/zh.json";
import fr from "../locales/fr.json";
import it from "../locales/it.json";
import ja from "../locales/ja.json";
import ptBR from "../locales/pt-BR.json";
import zh from "../locales/zh.json";

type Texts = { [key: string]: string | Texts };

export interface Language {
  code: string;
  name: string;
}

export const DEFAULT_LOCALE = "en";

export const LANGUAGES: readonly Language[] = [
  { code: "en", name: "English" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "es", name: "Español" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "it", name: "Italiano" },
  { code: "zh", name: "中文" },
  { code: "ja", name: "日本語" },
  { code: "ar", name: "العربية" },
];

const RTL = new Set(["ar"]);

const TEXTS: Record<string, [Texts, Texts]> = {
  en: [en, enExtra], "pt-BR": [ptBR, ptBRExtra], es: [es, esExtra], de: [de, deExtra], fr: [fr, frExtra], it: [it, itExtra], zh: [zh, zhExtra],
  ja: [ja, jaExtra], ar: [ar, arExtra],
};

let current = DEFAULT_LOCALE;

function lookup(texts: Texts, key: string): string | undefined {
  let at: string | Texts | undefined = texts;
  for (const part of key.split(".")) {
    if (typeof at !== "object" || !Object.prototype.hasOwnProperty.call(at, part)) return undefined;
    at = at[part];
  }
  return typeof at === "string" ? at : undefined;
}

/** The text of a key in a language: the app's own first, then the extension's, then English, then the key. */
export function textIn(locale: string, key: string): string {
  const [base, extra] = TEXTS[locale] ?? TEXTS[DEFAULT_LOCALE];
  return lookup(extra, key) ?? lookup(base, key) ?? lookup(enExtra, key) ?? lookup(en, key) ?? key;
}

/** The text of a key in the current language, with `{{name}}` filled from `params`. */
export function t(key: string, params?: Record<string, string | number>): string {
  let value = textIn(current, key);
  if (params) for (const [name, replacement] of Object.entries(params)) value = value.split(`{{${name}}}`).join(String(replacement));
  return value;
}

/** `one` for a count of 1, `many` otherwise, as the extension's locale files pair them. */
export function plural(count: number, one: string, many: string): string {
  return t(count === 1 ? one : many, { count });
}

/** The supported language for a BCP 47 tag ("pt-PT" is "pt-BR", "zh-Hant-TW" is "zh"), or null. */
export function matchLocale(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === lower);
  if (exact) return exact.code;
  const primary = lower.split("-")[0];
  return LANGUAGES.find((l) => l.code.toLowerCase().split("-")[0] === primary)?.code ?? null;
}

/** The language to show: the person's choice, else the client's, else the browser's, else English. */
export function pickLocale(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const match = matchLocale(candidate);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function setLocale(locale: string): void {
  current = matchLocale(locale) ?? DEFAULT_LOCALE;
}

export function getLocale(): string {
  return current;
}

export function isRtl(locale = current): boolean {
  return RTL.has(locale);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * A locale text that carries markup, as safe HTML: `<strong>`, `<em>` and `<code>` stay, without their attributes
 * (the extension's carry its Tailwind classes); everything else is escaped.
 */
export function richText(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(/<(\/?)(strong|em|code)\b[^>]*>/gi)) {
    out += escapeHtml(text.slice(last, match.index)) + `<${match[1]}${match[2].toLowerCase()}>`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}
