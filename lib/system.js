"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HERMES_HOME = path.resolve(process.env.HERMES_HOME || "/opt/data");
const GATEWAY_PAUSE_FILE = path.join(HERMES_HOME, ".gateway.paused");

function round1(n) {
  return Math.round(n * 10) / 10;
}

function diskUsage(dir) {
  try {
    const out = execFileSync("df", ["-Pk", dir], { timeout: 3000 }).toString();
    const lines = out.trim().split("\n");
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    const totalKb = Number(cols[1]);
    const usedKb = Number(cols[2]);
    return {
      total: totalKb * 1024,
      used: usedKb * 1024,
      pct: totalKb ? round1((usedKb / totalKb) * 100) : 0,
    };
  } catch {
    return { total: 0, used: 0, pct: 0 };
  }
}

function memoryUsage() {
  let memTotal = os.totalmem();
  let memAvailable = os.freemem();
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const total = /MemTotal:\s+(\d+)/.exec(meminfo);
    // MemAvailable accounts for reclaimable cache — a truer "free" figure
    // than MemFree inside a cgroup-limited container.
    const avail = /MemAvailable:\s+(\d+)/.exec(meminfo);
    if (total) memTotal = Number(total[1]) * 1024;
    if (avail) memAvailable = Number(avail[1]) * 1024;
  } catch {
    // /proc/meminfo not available — fall back to the os module's view.
  }
  const used = Math.max(0, memTotal - memAvailable);
  return { total: memTotal, used, pct: memTotal ? round1((used / memTotal) * 100) : 0 };
}

function hermesVersion() {
  try {
    const out = execFileSync("hermes", ["--version"], { timeout: 3000 }).toString().trim();
    const parts = out.split(/\s+/);
    return parts[parts.length - 1] || out;
  } catch {
    return "unknown";
  }
}

function findGatewayPid() {
  try {
    const out = execFileSync("pgrep", ["-f", "hermes gateway run"]).toString().trim();
    const pid = out
      .split("\n")
      .map((s) => Number(s.trim()))
      .find((n) => Number.isInteger(n) && n > 0);
    return pid || null;
  } catch {
    return null;
  }
}

function isPaused() {
  return fs.existsSync(GATEWAY_PAUSE_FILE);
}

function hostInfo(startTime) {
  const [l1, l5, l15] = os.loadavg();
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    hostname: os.hostname(),
    node_version: process.version,
    hermes_version: hermesVersion(),
    cpu_count: os.cpus().length,
    load: { "1m": round1(l1), "5m": round1(l5), "15m": round1(l15) },
    memory: memoryUsage(),
    disk: diskUsage(HERMES_HOME),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    gateway_pid: findGatewayPid(),
    gateway_paused: isPaused(),
  };
}

function gatewayAction(action) {
  const pid = findGatewayPid();
  if (action === "stop") {
    fs.writeFileSync(GATEWAY_PAUSE_FILE, "");
    if (pid) process.kill(pid, "SIGTERM");
    return { ok: true, status: "stopping" };
  }
  if (action === "start") {
    if (fs.existsSync(GATEWAY_PAUSE_FILE)) fs.unlinkSync(GATEWAY_PAUSE_FILE);
    return { ok: true, status: pid ? "already-running" : "starting" };
  }
  if (action === "restart") {
    if (fs.existsSync(GATEWAY_PAUSE_FILE)) fs.unlinkSync(GATEWAY_PAUSE_FILE);
    if (pid) {
      process.kill(pid, "SIGTERM");
      return { ok: true, status: "restarting" };
    }
    return { ok: true, status: "starting" };
  }
  throw new Error("Unknown action.");
}

// ── Active model (reads/writes Hermes's own config.yaml) ──
// start.sh builds config.yaml from env vars once at boot via the same
// python3 + pyyaml combination already bundled in the Hermes venv; reuse
// that instead of vendoring a YAML parser into Node.
function readModel() {
  const script = `
import json, os
from pathlib import Path
import yaml
home = Path(os.environ["HERMES_HOME"])
cfg_path = home / "config.yaml"
try:
    config = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
except FileNotFoundError:
    config = {}
model = config.get("model", {}) or {}
print(json.dumps({
    "model": model.get("default", ""),
    "provider": model.get("provider", ""),
    "has_api_key": bool(model.get("api_key")),
}))
`;
  try {
    const out = execFileSync("python3", ["-c", script], {
      env: { ...process.env, HERMES_HOME },
      timeout: 5000,
    }).toString();
    return JSON.parse(out);
  } catch {
    return { model: "", provider: "", has_api_key: false };
  }
}

function writeModel({ model, provider, apiKey }) {
  const script = `
import os
from pathlib import Path
import yaml
home = Path(os.environ["HERMES_HOME"])
cfg_path = home / "config.yaml"
try:
    config = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
except FileNotFoundError:
    config = {}
model_name = os.environ.get("HM_SWITCH_MODEL", "").strip()
provider_name = os.environ.get("HM_SWITCH_PROVIDER", "").strip()
api_key = os.environ.get("HM_SWITCH_API_KEY", "")
m = config.setdefault("model", {})
if model_name:
    m["default"] = model_name
if provider_name:
    m["provider"] = provider_name
else:
    m.pop("provider", None)
if api_key:
    m["api_key"] = api_key
cfg_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
cfg_path.chmod(0o600)
`;
  execFileSync("python3", ["-c", script], {
    env: {
      ...process.env,
      HERMES_HOME,
      HM_SWITCH_MODEL: model || "",
      HM_SWITCH_PROVIDER: provider || "",
      HM_SWITCH_API_KEY: apiKey || "",
    },
    timeout: 5000,
  });
}

module.exports = { hostInfo, findGatewayPid, isPaused, gatewayAction, readModel, writeModel };
