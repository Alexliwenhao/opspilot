// package-portable.mjs
// Builds a self-contained portable ZIP bundle of OpsPilot for Windows.
//
// Usage:
//   node scripts/package-portable.mjs
//
// It collects:
//   - src-tauri/target/release/opspilot.exe   (the native binary, OPTIONAL)
//   - src-tauri/target/release/resources/      (if present)
//   - dist/                                    (frontend assets)
//   - scripts/portable/*                        (Windows launchers + README)
// into dist-portable/OpsPilot-vX.Y.Z-portable.zip
//
// The native binary is OPTIONAL: if it hasn't been compiled yet (e.g. on a
// machine without a C toolchain, or in the build sandbox), the script still
// produces a working frontend-only portable bundle (in-browser mock backend).
// Build the real binary with `cargo build --release` / `npm run tauri build`
// and re-run to include it.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const tauriDir = join(root, "src-tauri");
const exePath = join(tauriDir, "target", "release", "opspilot.exe");
const resourcesDir = join(tauriDir, "target", "release", "resources");
const distDir = join(root, "dist");
const portableSrcDir = join(__dirname, "portable");

function version() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function find7z() {
  const candidates = [
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // try PATH
  try {
    execSync("where 7z.exe", { stdio: "ignore" });
    return "7z.exe";
  } catch {
    return null;
  }
}

function main() {
  const v = version();
  const outDir = join(root, "dist-portable");
  const stage = join(outDir, `OpsPilot-${v}-portable`);
  mkdirSync(stage, { recursive: true });

  // Copy native binary (OPTIONAL — bundle still works without it).
  if (existsSync(exePath)) {
    copyFileSync(exePath, join(stage, "OpsPilot.exe"));
    console.log(`[package-portable] copied binary -> ${join(stage, "OpsPilot.exe")}`);
  } else {
    console.warn(
      `[package-portable] native binary not found at ${exePath}\n` +
      `                 Building FRONTEND-ONLY portable bundle (in-browser mock backend).\n` +
      `                 Compile it later with 'cargo build --release' / 'npm run tauri build' and re-run.`
    );
  }

  // Copy resources (Tauri sidecar/MCP assets etc.) if present
  if (existsSync(resourcesDir)) {
    copyDir(resourcesDir, join(stage, "resources"));
    console.log(`[package-portable] copied resources/`);
  }

  // Copy frontend dist (so the binary/webview can locate assets)
  if (existsSync(distDir)) {
    copyDir(distDir, stage);
    console.log(`[package-portable] copied dist/ (frontend assets)`);
  } else {
    console.warn("[package-portable] dist/ not found — run `npm run build` first for the UI.");
  }

  // Copy Windows launchers + portable README from scripts/portable/.
  if (existsSync(portableSrcDir)) {
    copyDir(portableSrcDir, stage);
    console.log(`[package-portable] copied scripts/portable/ (launchers + README)`);
  }

  // Zip it
  const zipName = `${stage}.zip`;
  const seven = find7z();
  if (seven) {
    execSync(`"${seven}" a -tzip "${zipName}" "${stage}\\*"`, { stdio: "inherit", cwd: outDir });
  } else {
    // Fallback: Node-built ZIP (with DEFLATE) — no 7z dependency.
    console.warn("[package-portable] 7z not found; writing .zip via Node fallback.");
    fallbackZip(stage, zipName);
  }

  const sizeMb = (statSync(zipName).size / 1024 / 1024).toFixed(1);
  console.log(`\n[package-portable] DONE -> ${zipName} (${sizeMb} MB)`);
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readDir(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}
function readDir(p) {
  const out = [];
  const fs = require("node:fs");
  for (const e of fs.readdirSync(p)) out.push(e);
  return out;
}

// Minimal STORE-only zip (no compression) fallback if 7z is unavailable.
function fallbackZip(stage, zipName) {
  const fs = require("node:fs");
  const path = require("node:path");
  const files = [];
  (function walk(dir, base) {
    for (const e of fs.readdirSync(dir)) {
      const full = path.join(dir, e);
      const rel = path.join(base, e);
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else files.push({ full, rel: rel.split(path.sep).join("/") });
    }
  })(stage, "");
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const nameBuf = Buffer.from(f.rel, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(zipName, Buffer.concat([...chunks, centralBuf, end]));
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

main();
