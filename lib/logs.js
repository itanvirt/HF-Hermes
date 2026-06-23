"use strict";

const fs = require("fs");
const path = require("path");

const HERMES_HOME = path.resolve(process.env.HERMES_HOME || "/opt/data");
const LOGS_DIR = path.join(HERMES_HOME, "logs");

// Matches the tee targets start.sh writes for each supervised process.
const LOG_FILES = {
  gateway: "gateway.log",
  dashboard: "dashboard.log",
  jupyter: "jupyter.log",
  health: "health.log",
  sync: "sync.log",
};

const MAX_READ_BYTES = 2 * 1024 * 1024; // only tail the last 2MB of a log file

function tail(key, lines) {
  const filename = LOG_FILES[key];
  if (!filename) throw new Error("Unknown log file.");
  const target = path.join(LOGS_DIR, filename);

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { content: "", total_lines: 0, truncated: false };
  }

  const start = Math.max(0, stat.size - MAX_READ_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(target, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  const allLines = buffer.toString("utf8").split("\n");
  const wanted = Math.max(1, Math.min(2000, Number(lines) || 200));
  const selected = allLines.slice(-wanted);
  return {
    content: selected.join("\n"),
    total_lines: allLines.length,
    truncated: start > 0,
  };
}

module.exports = { LOG_FILES, tail };
