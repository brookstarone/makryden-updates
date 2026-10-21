"use strict";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-"));
process.env.ROUGE_FLEET_FILE = path.join(tmp, "starbrook.json");
const { handlePing, fleetFile } = await import("../system/rouge/fleet-ping.js");

assert.strictEqual(fleetFile(), process.env.ROUGE_FLEET_FILE, "uses env file");

// bad input rejected
let r = handlePing({});
assert.strictEqual(r.status, 400, "missing install_id -> 400");
r = handlePing({ install_id: "not a uuid!!" });
assert.strictEqual(r.status, 400, "garbage install_id -> 400");

// good ping stored
const id = "123e4567-e89b-12d3-a456-426614174000";
r = handlePing({ install_id: id, app_version: "0.4.4-beta", version_code: 18, last_seen: "2026-10-20T20:00:00Z" });
assert.strictEqual(r.status, 200, "good ping -> 200");
let data = JSON.parse(fs.readFileSync(process.env.ROUGE_FLEET_FILE, "utf8"));
assert.strictEqual(data.devices.length, 1, "one device");
assert.strictEqual(data.devices[0].version_code, 18, "version recorded");

// second ping from same install updates in place
r = handlePing({ install_id: id, app_version: "0.4.5-beta", version_code: 19, last_seen: "2026-10-21T20:00:00Z" });
data = JSON.parse(fs.readFileSync(process.env.ROUGE_FLEET_FILE, "utf8"));
assert.strictEqual(data.devices.length, 1, "still one device");
assert.strictEqual(data.devices[0].app_version, "0.4.5-beta", "version updated");

console.log("fleet-ping: all tests pass");
