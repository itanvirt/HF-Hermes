"use strict";

const fs = require("fs");
const path = require("path");

const FILES_ROOT = path.resolve(process.env.HERMES_HOME || "/opt/data");
const MAX_UPLOAD_BYTES = Number(process.env.FILES_MAX_UPLOAD_BYTES || 200 * 1024 * 1024);

function safeJoin(relPath) {
  const rel = String(relPath || "").replace(/^\/+/, "");
  const resolved = path.resolve(FILES_ROOT, rel);
  if (resolved !== FILES_ROOT && !resolved.startsWith(FILES_ROOT + path.sep)) {
    throw new Error("Path escapes the workspace root.");
  }
  return resolved;
}

function relFromRoot(absPath) {
  const rel = path.relative(FILES_ROOT, absPath);
  return rel === "" ? "/" : `/${rel.split(path.sep).join("/")}`;
}

function isSafeName(name) {
  return !!name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

function listDir(relPath) {
  const dir = safeJoin(relPath);
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error("Not a directory.");
  const items = fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const abs = path.join(dir, entry.name);
      let info;
      try {
        info = fs.statSync(abs);
      } catch {
        return null;
      }
      return {
        name: entry.name,
        path: relFromRoot(abs),
        is_dir: info.isDirectory(),
        size: info.size,
        mtime: Math.floor(info.mtimeMs / 1000),
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1,
    );
  return { path: relFromRoot(dir), items };
}

function mkdir(relPath, name) {
  if (!isSafeName(name)) throw new Error("Invalid directory name.");
  const dir = safeJoin(relPath);
  fs.mkdirSync(path.join(dir, name), { recursive: false });
}

function statForDownload(relPath) {
  const target = safeJoin(relPath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("Not a file.");
  return { absPath: target, size: stat.size, name: path.basename(target) };
}

function uploadFile(relPath, name, req) {
  if (!isSafeName(name)) return Promise.reject(new Error("Invalid file name."));
  let dir;
  try {
    dir = safeJoin(relPath);
  } catch (err) {
    return Promise.reject(err);
  }
  const target = path.join(dir, name);
  return new Promise((resolve, reject) => {
    let received = 0;
    let failed = false;
    const out = fs.createWriteStream(target);
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES && !failed) {
        failed = true;
        out.destroy();
        req.destroy();
        fs.unlink(target, () => {});
        reject(new Error("File exceeds upload size limit."));
      }
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
    out.on("error", (err) => {
      if (!failed) reject(err);
    });
    out.on("finish", () => {
      if (!failed) resolve({ name, size: received });
    });
    req.pipe(out);
  });
}

module.exports = { FILES_ROOT, listDir, mkdir, statForDownload, uploadFile };
