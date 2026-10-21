"use strict";
/* StarBrook Fleet ping receiver — Rouge Plant side.
 * Mounts as POST /api/fleet/ping (see README for the 3-line server.js hook).
 * Phones report opt-in, once a day: { install_id, app_version, version_code,
 * last_seen, label? }. Stored in the same fleet file GET /api/fleet reads.
 * Per-install UUIDs only — never hardware IDs. No auth: this endpoint is
 * meant to be reachable from the user's own phones (Tailscale/VPN);
 * do not expose it to the public internet.
 */
import fs from "node:fs";
import path from "node:path";

function fleetFile() {
  return (
    process.env.ROUGE_FLEET_FILE ||
    (process.env.ROUGE_MEOS_ROOT
      ? path.join(process.env.ROUGE_MEOS_ROOT, "fleet", "starbrook.json")
      : "/opt/meos/fleet/starbrook.json")
  );
}

function readFleet(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && Array.isArray(data.devices)) return data;
  } catch { /* missing or corrupt: start fresh */ }
  return { devices: [] };
}

function isUuid(s) {
  return typeof s === "string" && /^[0-9a-fA-F-]{8,64}$/.test(s);
}

/** Handles POST /api/fleet/ping. `body` is the parsed JSON. Returns {status, json}. */
function handlePing(body) {
  if (!body || !isUuid(body.install_id)) {
    return { status: 400, json: { ok: false, error: "install_id required" } };
  }
  const file = fleetFile();
  const fleet = readFleet(file);
  const now = new Date().toISOString();
  const entry = {
    install_id: body.install_id,
    label: typeof body.label === "string" ? body.label.slice(0, 80) : null,
    app_version: typeof body.app_version === "string" ? body.app_version.slice(0, 32) : null,
    version_code: typeof body.version_code === "number" ? body.version_code : null,
    last_seen: typeof body.last_seen === "string" ? body.last_seen.slice(0, 32) : now,
  };
  const i = fleet.devices.findIndex((d) => d.install_id === entry.install_id);
  if (i >= 0) fleet.devices[i] = entry; else fleet.devices.push(entry);
  fleet.updated_at = now;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fleet, null, 2));
  } catch (e) {
    return { status: 500, json: { ok: false, error: "could not save fleet state" } };
  }
  return { status: 200, json: { ok: true } };
}

export { handlePing, fleetFile };
