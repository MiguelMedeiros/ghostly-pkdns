// @vitest-environment happy-dom
// The app as a person uses it, in a DOM, with a broker and relays made here: nothing leaves the test.
import { beforeEach, describe, expect, it } from "vitest";
import { getLocale } from "../src/lib/i18n";
import { DEFAULT_RELAYS, MAX_FAVORITES } from "../src/lib/model";
import { memoryBackend } from "../src/lib/store";
import { App } from "../src/ui/app";
import type { MiniAppApi, MiniAppContext } from "../src/vendor/miniApp";
import { type TestRecord, dnsPacket, micros, signedPayload, testKey, txt } from "./packets";

const owner = testKey(7);
const stamp = (iso: string) => micros(iso);
// Dated before the tests run: the app goes by the real clock here, and refuses a record dated ahead of it.
const NEW = "2026-10-01T10:00:00Z";

/** A broker like the client's, for an app opened alone. */
function broker(context: Partial<MiniAppContext> = {}) {
  const backend = memoryBackend();
  const api: MiniAppApi = {
    context: async () => ({ version: "1.0.0", inChat: false, peer: null, theme: "dark", locale: "en", ...context }),
    file: async () => new ArrayBuffer(0),
    storage: backend,
    chat: { send: async () => {}, on: () => () => {} },
    close: async () => {},
  };
  return { api, map: backend.map, context };
}

type Relays = Record<string, Uint8Array | number>;

/** Relays that answer a payload, or a status, by host. Every request is recorded. */
function relays(table: Relays) {
  const asked: string[] = [];
  const doFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url.href);
    const reply = table[url.host];
    if (reply === undefined) throw new TypeError("Failed to fetch");
    if (typeof reply === "number") return new Response(null, { status: reply });
    return new Response(reply as BodyInit, { status: url.pathname === "/" ? 200 : 200 });
  }) as typeof fetch;
  return { doFetch, asked };
}

const packet = (records: TestRecord[] = [{ name: owner.key, type: 1, data: Uint8Array.from([203, 0, 113, 7]) }]) => dnsPacket(records);
const good = (iso = NEW, records?: TestRecord[]) => signedPayload(owner, stamp(iso), packet(records));
const allGood = (payload = good()): Relays => Object.fromEntries(DEFAULT_RELAYS.map((url) => [new URL(url).host, payload]));

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out; the page says: ${document.body.textContent?.slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function start(table: Relays, api = broker()) {
  document.body.innerHTML = '<div id="app"></div>';
  const net = relays(table);
  const app = new App(document.getElementById("app")!, api.api, net.doFetch);
  await app.start();
  return { app, ...net, ...api };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const click = (selector: string) => {
  const el = $(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  el.click();
};
function type(selector: string, value: string): void {
  const input = $<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function choose(selector: string, value: string): void {
  const select = $<HTMLSelectElement>(selector)!;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
const go = (view: string) => click(`.tab[data-arg="${view}"]`);
const text = () => $("main")!.textContent ?? "";

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("resolving", () => {
  it("resolves a key by itself once it is whole, and shows what the owner signed", async () => {
    const { asked } = await start(allGood());
    type("#query", `pk:${owner.key}`);
    await until(() => !!$(".result"));
    expect(asked.sort()).toEqual(DEFAULT_RELAYS.map((url) => `${url}/${owner.key}`).sort());
    expect($(".badge.good")!.textContent).toContain("Signature verified");
    expect(text()).toContain(owner.key);
    expect(text()).toContain("203.0.113.7");
    expect(text()).toContain(`${72 + packet().length} B`);
    expect([...document.querySelectorAll(".outcomes li")].map((li) => li.textContent)).toHaveLength(3);
    expect($('[data-action="open-link"]')!.dataset.arg).toBe("http://203.0.113.7");
  });

  it("does nothing while the key is not whole", async () => {
    const { asked } = await start(allGood());
    type("#query", owner.key.slice(0, 51));
    await settle();
    expect(asked).toEqual([]);
    expect($(".result")).toBeNull();
  });

  it("shows no record of an answer whose signature is bad, and says why", async () => {
    const forged = good();
    forged[forged.length - 1] = 66;
    const { map } = await start(allGood(forged));
    type("#query", owner.key);
    await until(() => text().includes("No relay gave a valid answer"));
    expect($(".result")).toBeNull();
    expect(text()).not.toContain("203.0.113");
    expect(document.querySelectorAll(".outcomes .tone-bad")).toHaveLength(3);
    expect(text()).toContain("refused: bad signature");
    await settle();
    expect(map.has("recent")).toBe(false);
    expect(map.has("cache.0")).toBe(false);
  });

  it("refuses a record older than one it has shown, even after the app is opened again", async () => {
    const api = broker();
    await start(allGood(good(NEW)), api);
    type("#query", owner.key);
    await until(() => !!$(".result"));
    await settle();
    expect(JSON.parse(api.map.get("seen")!)).toEqual({ [owner.key]: String(stamp(NEW)) });

    // Opened again: every relay now replays an older, validly signed record. Refresh skips the cache.
    const old = good("2026-09-01T10:00:00Z", [{ name: owner.key, type: 1, data: Uint8Array.from([198, 51, 100, 9]) }]);
    await start(allGood(old), api);
    type("#query", owner.key);
    await until(() => !!$(".result"));
    expect(text()).toContain("Cached");
    click('[data-action="refresh"]');
    await until(() => text().includes("No relay gave a valid answer"));
    expect(text()).toContain("refused: older than a record already seen");
    expect(text()).not.toContain("198.51.100.9");
  });

  it("serves the cache within its time, and asks the relays again on Refresh", async () => {
    const { asked } = await start(allGood());
    type("#query", owner.key);
    await until(() => !!$(".result"));
    expect(text()).not.toContain("Cached");
    click('[data-action="clear-query"]');
    type("#query", owner.key);
    await until(() => !!$(".result"));
    expect(text()).toContain("Cached");
    expect(asked).toHaveLength(3);
    click('[data-action="refresh"]');
    await until(() => asked.length === 6 && !!$(".result"));
    expect(text()).not.toContain("Cached");
  });

  it("writes a record's text as text, whatever it holds", async () => {
    const hostile = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
    const records = [
      { name: owner.key, type: 16, data: txt(hostile) },
      { name: `<b>x</b>.${owner.key}`, type: 5, data: Uint8Array.from([1, 0x3c, 0]) },
    ];
    await start(allGood(good(NEW, records)));
    type("#query", owner.key);
    await until(() => !!$(".result"));
    expect($("main img")).toBeNull();
    expect($("main script")).toBeNull();
    expect($("main b")).toBeNull();
    expect(text()).toContain(hostile);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("says not found when the relays have no such key", async () => {
    await start(Object.fromEntries(DEFAULT_RELAYS.map((url) => [new URL(url).host, 404])));
    type("#query", owner.key);
    await until(() => text().includes("No records found for this key"));
    expect(document.querySelectorAll(".outcomes li")).toHaveLength(3);
  });

  it("refuses what is neither a key nor a domain name", async () => {
    const { asked } = await start(allGood());
    type("#query", "not a key");
    click('[data-action="resolve"]');
    await settle();
    expect($(".toast")!.textContent).toContain("Invalid Pkarr public key");
    expect(asked).toEqual([]);
  });
});

describe("favorites, recent and history", () => {
  async function resolved(api = broker()) {
    const page = await start(allGood(), api);
    type("#query", owner.key);
    await until(() => !!$(".result"));
    return page;
  }

  it("saves a favorite with a label, edits it, finds it and removes it", async () => {
    const { map } = await resolved();
    click('[data-action="favorite"]');
    $<HTMLInputElement>("#dialog-input")!.value = "Alice <3";
    click('[data-dialog="save"]');
    await settle();
    expect($('[data-action="unfavorite"]')).not.toBeNull();
    expect(JSON.parse(map.get("favorites")!)[0]).toMatchObject({ key: owner.key, label: "Alice <3" });

    go("favorites");
    expect(text()).toContain("Alice <3");
    expect(text()).toContain("1 favorite");
    type("#favorites-query", "bob");
    expect(text()).toContain("No favorites match your search");
    expect(document.activeElement?.id ?? "").not.toBe("nothing"); // the field itself was not replaced
    expect($<HTMLInputElement>("#favorites-query")!.value).toBe("bob");
    type("#favorites-query", "alice");
    expect(text()).toContain("1 of 1");

    click('[data-action="edit-favorite"]');
    expect($<HTMLInputElement>("#dialog-input")!.value).toBe("Alice <3");
    $<HTMLInputElement>("#dialog-input")!.value = "Alice";
    click('[data-dialog="save"]');
    await settle();
    expect(JSON.parse(map.get("favorites")!)[0].label).toBe("Alice");

    click('[data-action="ask-unfavorite"]');
    expect($(".dialog")!.textContent).toContain("Are you sure you want to remove this favorite?");
    click('[data-dialog="ok"]');
    await settle();
    expect(text()).toContain("No favorites yet");
    expect(JSON.parse(map.get("favorites")!)).toEqual([]);
    expect(MAX_FAVORITES).toBe(50);
  });

  it("lists the key under Recent, and clears the list after asking", async () => {
    const { map } = await resolved();
    go("recent");
    expect(text()).toContain("1 search");
    type("#recent-query", "zzzz");
    expect(text()).toContain("No recent entries match your search");
    click('[data-action="ask-clear-recent"]');
    click('[data-dialog="cancel"]');
    expect(JSON.parse(map.get("recent")!)).toHaveLength(1);
    click('[data-action="ask-clear-recent"]');
    click('.dialog [data-dialog="ok"]');
    await settle();
    expect(text()).toContain("No recent searches");
    expect(JSON.parse(map.get("recent")!)).toEqual([]);
  });

  it("records every resolve, draws the charts, exports CSV and clears", async () => {
    await resolved();
    click('[data-action="refresh"]');
    await until(() => !!$(".result") && document.querySelectorAll(".outcomes li").length === 3);
    go("history");
    expect([...document.querySelectorAll(".tile-value")].map((el) => el.textContent)[0]).toBe("2");
    expect(document.querySelectorAll("svg.chart")).toHaveLength(3);
    expect(document.querySelectorAll(".bar-row")).toHaveLength(1);
    expect(document.querySelectorAll("table.history tbody tr")).toHaveLength(2);
    expect($("main")!.innerHTML).not.toMatch(/NaN|undefined|Infinity/);

    click('[data-action="export-csv"]');
    const csv = $<HTMLTextAreaElement>("#dialog-text")!.value.split("\r\n");
    expect(csv[0]).toBe('"Date","Key","Relay","Response Time (ms)","Payload Size (bytes)","From Cache","Record Count"');
    expect(csv).toHaveLength(4);
    expect(csv[1]).toContain(`"${owner.key}"`);
    click('[data-dialog="cancel"]');

    click('[data-action="ask-clear-history"]');
    click('.dialog [data-dialog="ok"]');
    await settle();
    expect(text()).toContain("No resolve history yet");
  });
});

describe("relays", () => {
  it("adds, switches off, tests and removes a relay, and resets", async () => {
    const { map, asked } = await start({ ...allGood(), "my.relay.test": good() });
    go("relays");
    expect(text()).toContain("3 of 3 relays active");

    type("#relay-input", "http://my.relay.test");
    click('[data-action="add-relay"]');
    expect($('[role="alert"]')!.textContent).toContain("Only https:// relays");
    type("#relay-input", "https://my.relay.test/");
    click('[data-action="add-relay"]');
    await settle();
    expect(text()).toContain("4 of 4 relays active");
    expect(JSON.parse(map.get("relays")!)[3]).toEqual({ url: "https://my.relay.test", enabled: true, isDefault: false });

    const toggle = $<HTMLInputElement>(`[data-change="toggle-relay"][data-arg="${DEFAULT_RELAYS[0]}"]`)!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(text()).toContain("3 of 4 relays active");

    click('[data-action="test-all"]');
    await until(() => document.querySelectorAll(".ping.online").length === 3);
    expect(asked.filter((url) => url.endsWith("/")).sort()).toEqual(["https://my.relay.test/", `${DEFAULT_RELAYS[1]}/`, `${DEFAULT_RELAYS[2]}/`].sort());
    expect(text()).toMatch(/Min: \d+ms/);
    expect(document.querySelectorAll(".bar-row")).toHaveLength(3);

    // A key is now asked of the enabled relays only.
    go("resolver");
    type("#query", owner.key);
    await until(() => !!$(".result"));
    expect(asked.filter((url) => url.endsWith(owner.key)).map((url) => new URL(url).host).sort()).toEqual(["my.relay.test", "pkarr.miguelmedeiros.dev", "pkarr.pubky.app"]);

    go("relays");
    click('[data-action="ask-remove-relay"]');
    click('.dialog [data-dialog="ok"]');
    await settle();
    expect(text()).toContain("2 of 3 relays active");
    click('[data-action="ask-reset-relays"]');
    click('.dialog [data-dialog="ok"]');
    await settle();
    expect(text()).toContain("3 of 3 relays active");
  });

  it("marks a relay that does not answer as offline", async () => {
    await start({ "pkarr.pubky.org": good() });
    go("relays");
    click('[data-action="test-all"]');
    await until(() => document.querySelectorAll(".ping.offline").length === 2 && document.querySelectorAll(".ping.online").length === 1);
    expect(text()).toContain("offline");
  });
});

describe("settings", () => {
  it("keeps the timeout, the cache time and the resolver, and turning the cache off stops caching", async () => {
    const { map, asked } = await start(allGood());
    go("settings");
    choose("#set-requestTimeoutMs", "30000");
    choose("#set-cacheTtlMs", "0");
    choose("#set-dohProvider", "quad9");
    await settle();
    expect(JSON.parse(map.get("settings")!)).toMatchObject({ requestTimeoutMs: 30_000, cacheTtlMs: 0, dohProvider: "quad9" });
    go("resolver");
    type("#query", owner.key);
    await until(() => !!$(".result"));
    click('[data-action="clear-query"]');
    type("#query", owner.key);
    await until(() => asked.length === 6 && !!$(".result"));
    expect(text()).not.toContain("Cached");
  });

  it("follows the client's language and theme, until the person picks a language", async () => {
    const api = broker({ locale: "pt-PT", theme: "light" });
    await start(allGood(), api);
    expect(getLocale()).toBe("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect($(".tabs")!.textContent).toContain("Favoritos");

    go("settings");
    choose("#set-locale", "ar");
    await until(() => document.documentElement.dir === "rtl");
    expect(document.documentElement.lang).toBe("ar");
    await settle();
    expect(JSON.parse(api.map.get("settings")!).locale).toBe("ar");

    // Opened again, the choice holds whatever the client says.
    await start(allGood(), api);
    expect(getLocale()).toBe("ar");
    go("settings");
    choose("#set-locale", "");
    await until(() => document.documentElement.dir === "ltr");
    expect(getLocale()).toBe("pt-BR");
  });

  it("exports everything as text, and imports it into an empty app", async () => {
    const first = await start(allGood());
    type("#query", owner.key);
    await until(() => !!$(".result"));
    click('[data-action="favorite"]');
    $<HTMLInputElement>("#dialog-input")!.value = "Alice";
    click('[data-dialog="save"]');
    await settle();
    go("settings");
    click('[data-action="export-data"]');
    const backup = $<HTMLTextAreaElement>("#dialog-text")!.value;
    expect(JSON.parse(backup)).toMatchObject({ version: 1, app: "ghostly-pkdns", favorites: [{ key: owner.key, label: "Alice" }] });
    click('[data-dialog="cancel"]');
    expect(first.map.size).toBeGreaterThan(0);

    const second = await start(allGood());
    go("settings");
    click('[data-action="import-data"]');
    click('[data-dialog="import"]');
    expect($("#dialog-error")!.textContent).toBe("No data to import");
    $<HTMLTextAreaElement>("#dialog-text")!.value = "{ not json";
    click('[data-dialog="import"]');
    expect($("#dialog-error")!.textContent).toContain("Import failed");
    $<HTMLTextAreaElement>("#dialog-text")!.value = backup;
    click('[data-dialog="import"]');
    await settle();
    expect($(".dialog")).toBeNull();
    expect(JSON.parse(second.map.get("favorites")!)[0]).toMatchObject({ key: owner.key, label: "Alice" });
    expect(JSON.parse(second.map.get("history.0")!)).toHaveLength(1);
    go("favorites");
    expect(text()).toContain("Alice");
  });

  it("clears the cache, and clears all data after asking", async () => {
    const { map } = await start(allGood());
    type("#query", owner.key);
    await until(() => !!$(".result"));
    await settle();
    expect(map.has("cache.0")).toBe(true);
    go("settings");
    click('[data-action="clear-cache"]');
    await settle();
    expect(map.has("cache.0")).toBe(false);
    click('[data-action="ask-clear-all"]');
    click('.dialog [data-dialog="ok"]');
    await until(() => map.size === 0);
    go("recent");
    expect(text()).toContain("No recent searches");
  });
});

describe("the page", () => {
  it("has no link that navigates, no form, and no frame or script of its own, on any page", async () => {
    await start(allGood());
    type("#query", owner.key);
    await until(() => !!$(".result"));
    for (const view of ["resolver", "favorites", "recent", "history", "relays", "settings", "how"]) {
      go(view);
      expect(document.querySelectorAll("a[href], form, iframe, link, script, object, embed"), view).toHaveLength(0);
      expect($("main h1"), view).not.toBeNull();
      expect($("main")!.innerHTML, view).not.toMatch(/\bon[a-z]+\s*=/i);
      expect($(".tab[aria-current='page']")!.dataset.arg).toBe(view);
    }
  });

  it("has a bar of five places for the phone, and a sheet under More for the other three pages", async () => {
    await start(allGood());
    const places = () => Array.from(document.querySelectorAll<HTMLElement>(".dock-item"));
    const current = () => places().filter((el) => el.getAttribute("aria-current") === "page").map((el) => el.textContent);
    expect(places().map((el) => el.textContent)).toEqual(["Resolver", "Favorites", "Recent", "Relays", "More"]);
    expect(places().every((el) => !!el.querySelector("svg[aria-hidden='true']"))).toBe(true);
    expect(current()).toEqual(["Resolver"]);
    click('.dock-item[data-arg="relays"]');
    expect($("main h1")!.textContent).toBe("HTTP Relays");
    expect(current()).toEqual(["Relays"]);
    expect($(".sheet")).toBeNull();

    click('.dock-item[data-action="more"]');
    expect($('.dock-item[data-action="more"]')!.getAttribute("aria-expanded")).toBe("true");
    expect(Array.from(document.querySelectorAll(".sheet-item")).map((el) => el.textContent)).toEqual(["History", "Settings", "How it works"]);
    expect(document.activeElement).toBe($(".sheet-item"));
    expect($("main")!.inert).toBe(true);

    // Escape and a tap outside close it, with the focus back on More and the page as it was.
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($(".sheet")).toBeNull();
    expect(document.activeElement).toBe($('.dock-item[data-action="more"]'));
    expect($("main")!.inert).toBe(false);
    click('.dock-item[data-action="more"]');
    click(".sheet-overlay");
    expect($(".sheet")).toBeNull();
    expect(document.activeElement).toBe($('.dock-item[data-action="more"]'));
    expect(current()).toEqual(["Relays"]);

    // Picking a page shows it, closes the sheet and marks More.
    click('.dock-item[data-action="more"]');
    click('.sheet-item[data-arg="settings"]');
    expect($(".sheet")).toBeNull();
    expect($("main h1")!.textContent).toBe("Settings");
    expect(current()).toEqual(["More"]);
    expect(document.activeElement).toBe($('.dock-item[data-action="more"]'));
    expect($("main")!.inert).toBe(false);
    click('.dock-item[data-action="more"]');
    expect($(".sheet-item[aria-current='page']")!.textContent).toBe("Settings");
    click('.dock-item[data-arg="favorites"]');
    expect($(".sheet")).toBeNull();
    expect(current()).toEqual(["Favorites"]);
  });

  it("names the bar's places in every language, each with a short label of its own", async () => {
    const { textIn } = await import("../src/lib/i18n");
    for (const locale of ["en", "pt-BR", "es", "de", "fr", "it", "zh", "ja", "ar"]) {
      for (const place of ["resolver", "favorites", "recent", "relays", "more"]) {
        const label = textIn(locale, `bar.${place}`);
        expect(label, `${locale} ${place}`).not.toBe(`bar.${place}`);
        expect(label.length, `${locale} ${place}`).toBeLessThanOrEqual(10);
      }
    }
  });

  it("explains how it works in every language, with only the markup it allows", async () => {
    const api = broker();
    await start(allGood(), api);
    for (const locale of ["en", "pt-BR", "es", "de", "fr", "it", "zh", "ja", "ar"]) {
      go("settings");
      choose("#set-locale", locale);
      await until(() => document.documentElement.lang === locale);
      go("how");
      const html = $("main")!.innerHTML;
      expect(html, locale).not.toMatch(/howItWorks\.|app\.[a-z]/);
      expect(html, locale).not.toContain("class=\"text-");
      expect(html, locale).not.toContain("&lt;strong");
      expect($("main strong"), locale).not.toBeNull();
      expect(document.querySelectorAll("main details"), locale).toHaveLength(5);
    }
  });

  it("closes a dialog with Escape and gives the focus back", async () => {
    await start(allGood());
    go("settings");
    const opener = $('[data-action="export-data"]')!;
    opener.focus();
    opener.click();
    expect($(".dialog")).not.toBeNull();
    expect($<HTMLElement>("#main")!.inert).toBe(true);
    $(".dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($(".dialog")).toBeNull();
    expect($<HTMLElement>("#main")!.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("runs without a broker, keeping nothing, and says so", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const app = new App(document.getElementById("app")!, null, relays(allGood()).doFetch);
    await app.start();
    go("settings");
    expect(text()).toContain("Not running in Ghostly: nothing is saved.");
  });
});
