// The built app: one self-contained HTML file that loads nothing by URL, carries the notices of what it bundles,
// and a manifest that says what the app is.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LANGUAGES, textIn } from "../src/lib/i18n";
import enExtra from "../src/locales/extra/en.json";
import en from "../src/locales/en.json";

const root = join(import.meta.dirname, "..");
let out: string;
let page: string;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "mini-pkdns-"));
  await build({ configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  page = readFileSync(join(out, "index.html"), "utf8");
}, 60_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the PKDNS Resolver bundle", () => {
  it("is one HTML file with its script and styles inline", () => {
    expect(readdirSync(out)).toEqual(["index.html"]);
    expect(page).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/type="module"/);
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page.match(/<style\b/g)).toHaveLength(1);
    expect(page.match(/<\/head>/g)).toHaveLength(1);
    expect(page.match(/<\/body>/g)).toHaveLength(1);
    // Under the bundle bound of WISP 1200 (16 MiB) by a wide margin.
    expect(page.length).toBeLessThan(1024 * 1024);
  });

  it("keeps the license notices of what it carries", () => {
    const notice = page.slice(page.indexOf("/*!"), page.indexOf("*/", page.indexOf("/*!")) + 2);
    expect(notice).toContain("@noble/curves 2.4.0 (MIT)");
    expect(notice).toContain("@noble/hashes");
    expect(notice).toContain("Paul Miller");
    expect(notice).toContain("PKDNS Resolver extension, pubky/pkdns-resolver-extension (MIT)");
    expect(notice).toContain("Copyright (c) 2025 Pubky");
    expect(notice).toContain("Heroicons");
  });

  it("names no server but the relays and resolvers it is for", () => {
    const start = page.indexOf("/*!");
    const code = page.slice(0, start) + page.slice(page.indexOf("*/", start) + 2);
    const hosts = new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()));
    // Addresses the app fetches, the profile site it shows a link to, and the placeholders in its texts.
    const fetched = ["pkarr.pubky.org", "pkarr.pubky.app", "pkarr.miguelmedeiros.dev", "cloudflare-dns.com", "dns.google", "dns.quad9.net"];
    const shown = ["pubky.app", "www.w3.org"];
    // "https://your-relay.example.com", as each language writes it in the field for a relay's address.
    const placeholder = /(^|\.)(example|ejemplo|exemple|esempio|exemplo|beispiel)\.com$/;
    expect([...hosts].filter((host) => !fetched.includes(host) && !shown.includes(host) && !placeholder.test(host))).toEqual([]);
    for (const host of fetched) expect(hosts.has(host), host).toBe(true);
    expect(code).not.toMatch(/http:\/\/(?!www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(code).not.toMatch(/\bWebSocket\(|\bEventSource\(|\bimportScripts\(|\bnew Worker\(|\beval\(|new Function\(/);
  });
});

describe("the manifest", () => {
  const manifest = JSON.parse(readFileSync(join(root, "ghostly-app.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  it("is a full-screen mini-app that asks for the internet and nothing else", () => {
    expect(manifest).toMatchObject({ name: "pkdns", kind: "mini-app", entry: "index.html", view: "full", permissions: ["internet"], license: "MIT" });
    expect(manifest.runtime).toEqual({ host: ">=1.2", clients: ["web", "desktop"] });
    expect(manifest.version).toBe(pkg.version);
  });

  it("keeps to the bounds of WISP 1200 and leaves out what the publisher CLI writes", () => {
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect([...manifest.title].length).toBeLessThanOrEqual(40);
    expect([...manifest.tagline].length).toBeLessThanOrEqual(80);
    expect([...manifest.description].length).toBeLessThanOrEqual(2000);
    expect([...manifest.releaseNotes].length).toBeLessThanOrEqual(500);
    for (const url of [...manifest.sources, manifest.homepage, manifest.support]) expect(url).toMatch(/^https:\/\/[^@]{1,500}$/);
    for (const written of ["ghostlyApp", "publisher", "sequence", "files"]) expect(manifest).not.toHaveProperty(written);
    const known = ["name", "version", "kind", "title", "tagline", "description", "releaseNotes", "entry", "permissions", "view", "runtime", "license", "sources", "homepage", "support"];
    expect(Object.keys(manifest).filter((key) => !known.includes(key))).toEqual([]);
  });
});

describe("the nine languages", () => {
  const paths = (value: unknown, prefix = ""): string[] =>
    typeof value === "string" ? [prefix] : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
  const keys = [...new Set([...paths(en), ...paths(enExtra)])];
  const marks = (text: string) => [...text.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]).sort().join(" ");

  it("each have every text, with the same placeholders as the English", () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(["ar", "de", "en", "es", "fr", "it", "ja", "pt-BR", "zh"]);
    expect(keys.length).toBeGreaterThan(300);
    for (const { code } of LANGUAGES) {
      for (const key of keys) {
        const text = textIn(code, key);
        expect(text, `${code} ${key}`).not.toBe(key);
        expect(marks(text), `${code} ${key}`).toBe(marks(textIn("en", key)));
      }
    }
  });

  it("no longer speak of an extension where the app's own texts replace the extension's", () => {
    for (const key of paths(enExtra)) expect(textIn("en", key), key).not.toMatch(/extension|omnibox|address bar|auto-redirect/i);
  });
});
