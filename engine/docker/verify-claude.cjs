// Runs in the image build stage only. Fails the build unless the Claude Code
// binary is exactly the one the pinned Agent SDK's manifest names (Security and Testability Review
// review 3, spec section 5).
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");

const [, , binary, platform] = process.argv;
const pins = JSON.parse(fs.readFileSync(`${__dirname}/claude-sha256.json`, "utf8"));
const want = pins[platform];
if (!want || !/^[0-9a-f]{64}$/.test(want)) {
  console.error(`no pinned SHA-256 for ${platform}`);
  process.exit(1);
}
const st = fs.lstatSync(binary);
if (!st.isFile()) {
  console.error(`${binary} is not a regular file`);
  process.exit(1);
}
const got = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
if (got !== want) {
  console.error(`Claude Code binary SHA-256 ${got} does not match the pinned ${want}`);
  process.exit(1);
}
console.log(`Claude Code ${pins.version} ${platform}: SHA-256 matches`);
