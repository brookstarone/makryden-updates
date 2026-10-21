#!/usr/bin/env node
"use strict";
/* StarBrook CI watcher — Rouge Plant service.
 * Polls GitHub Actions for the latest main-branch run of starbrook-android
 * and writes the verdict to a state file the Plant UI (and system_state)
 * can read. Matthew stops checking the Actions page; the Plant watches it.
 *
 * Env:
 *   STARBROOK_CI_FILE  where to write state (default
 *                      /opt/meos/system/rouge/state/starbrook-ci.json)
 *   GITHUB_TOKEN       optional; raises the API rate limit (public repo
 *                      works without one at 60 req/hr; we poll every 5 min)
 *   CI_POLL_MS         poll interval (default 300000)
 *
 * Run under systemd (see starbrook-ci-watch.service) or by hand:
 *   node system/rouge/services/starbrook-ci-watch.js
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const REPO = "brookstarone/starbrook-android";
const STATE_FILE =
  process.env.STARBROOK_CI_FILE || "/opt/meos/system/rouge/state/starbrook-ci.json";
const POLL_MS = parseInt(process.env.CI_POLL_MS || "300000", 10);

function get(url) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "Rouge-CI-Watch/1.0",
      Accept: "application/vnd.github+json",
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    https
      .get(url, { headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error("bad JSON from GitHub API")); }
          } else reject(new Error(`GitHub API ${res.statusCode}`));
        });
      })
      .on("error", reject);
  });
}

async function poll() {
  try {
    const runs = await get(
      `https://api.github.com/repos/${REPO}/actions/runs?branch=main&per_page=1`
    );
    const run = runs.workflow_runs && runs.workflow_runs[0];
    const state = {
      updated_at: new Date().toISOString(),
      repo: REPO,
      run_id: run ? run.id : null,
      run_number: run ? run.run_number : null,
      status: run ? run.status : "unknown",         // queued | in_progress | completed
      conclusion: run ? run.conclusion : null,       // success | failure | null while running
      commit_sha: run ? run.head_sha : null,
      html_url: run ? run.html_url : null,
      green: !!(run && run.status === "completed" && run.conclusion === "success"),
    };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[${state.updated_at}] run ${state.run_number}: ${state.status}/${state.conclusion || "-"}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] poll failed: ${e.message}`);
  }
}

poll();
setInterval(poll, POLL_MS);
