// The version this build publishes as: the same in the manifest, package.json and package-lock.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8")) as { version: string; packages?: Record<string, { version?: string }> };

describe("the version", () => {
  it("is the same in ghostly-app.json, package.json and package-lock.json", () => {
    const manifest = read("ghostly-app.json").version;
    expect(read("package.json").version).toBe(manifest);
    const lock = read("package-lock.json");
    expect(lock.version).toBe(manifest);
    expect(lock.packages?.[""]?.version).toBe(manifest);
  });
});
