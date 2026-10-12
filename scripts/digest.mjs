// Prints the SHA-256 of the built dist/index.html in base64url: the form a signed bundle's manifest lists it in
// (`files[].sha256`), so a build can be checked against a published version with `ghostly app verify`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../dist/index.html", import.meta.url));
console.log(`dist/index.html ${page.length} bytes, sha256 ${createHash("sha256").update(page).digest("base64url")}`);
