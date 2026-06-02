import { build } from "esbuild";
import {
  copyFileSync, mkdirSync, readFileSync, writeFileSync,
  cpSync, existsSync, readdirSync, statSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes("--dev");
const rootDir = resolve(__dirname, "..");
const buildDir = join(rootDir, "build");
const addonDir = join(buildDir, "addon");

// Read package.json config
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));
const { addonName, addonID, addonRef, prefsPrefix } = pkg.config;

// Clean and create build directory
if (existsSync(addonDir)) {
  const { rmSync } = await import("fs");
  rmSync(addonDir, { recursive: true });
}
mkdirSync(join(addonDir, "content", "scripts"), { recursive: true });

// Copy addon resources
cpSync(join(rootDir, "addon"), addonDir, { recursive: true });

// Bundle TypeScript
await build({
  entryPoints: [join(rootDir, "src/index.ts")],
  bundle: true,
  outfile: join(addonDir, "content", "scripts", "index.js"),
  target: "firefox115",
  format: "iife",
  globalName: "DoubanToZotero",
  define: {
    "process.env.NODE_ENV": isDev ? '"development"' : '"production"',
    "__DEV__": isDev ? "true" : "false",
  },
  minify: !isDev,
  sourcemap: isDev,
});

// Replace placeholders in all addon files
function replaceInFile(filePath) {
  try {
    let content = readFileSync(filePath, "utf-8");
    const replaced = content
      .replace(/__addonName__/g, addonName)
      .replace(/__addonID__/g, addonID)
      .replace(/__addonRef__/g, addonRef)
      .replace(/__prefsPrefix__/g, prefsPrefix)
      .replace(/__version__/g, pkg.version)
      .replace(/__buildTime__/g, new Date().toISOString());
    if (replaced !== content) {
      writeFileSync(filePath, replaced, "utf-8");
    }
  } catch {
    // Skip binary files
  }
}

function replaceInDir(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      replaceInDir(fullPath);
    } else {
      replaceInFile(fullPath);
    }
  }
}

replaceInDir(addonDir);

// Create XPI for production builds using Node.js zlib (no PowerShell dependency)
// XPI is a ZIP file - we build it manually to ensure forward-slash paths (required by jar: protocol)
if (!isDev) {
  const { createWriteStream, unlinkSync: unlinkSyncFs } = await import("fs");
  const { relative } = await import("path");
  const { crc32 } = await import("zlib");

  const xpiName = `${addonRef}-${pkg.version}.xpi`;
  const xpiPath = join(buildDir, xpiName);
  try { unlinkSyncFs(xpiPath); } catch {}

  // Collect all files with forward-slash relative paths
  function collectFiles(dir, base) {
    let files = [];
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const relPath = relative(base, fullPath).replace(/\\/g, "/");
      if (statSync(fullPath).isDirectory()) {
        files.push(...collectFiles(fullPath, base));
      } else {
        files.push({ relPath, fullPath });
      }
    }
    return files;
  }

  const files = collectFiles(addonDir, addonDir);

  // Build ZIP manually (store method - no compression needed for small files)
  const entries = [];
  for (const file of files) {
    const data = readFileSync(file.fullPath);
    const crcVal = crc32(data);
    entries.push({
      name: file.relPath,
      data,
      crc: crcVal,
    });
  }

  // Write ZIP file
  const zipParts = [];
  const centralDir = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf-8");
    // Local file header
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4);          // version needed
    localHeader.writeUInt16LE(0, 6);           // flags
    localHeader.writeUInt16LE(0, 8);           // compression: stored
    localHeader.writeUInt16LE(0, 10);          // mod time
    localHeader.writeUInt16LE(0, 12);          // mod date
    localHeader.writeUInt32LE(entry.crc, 14);  // crc-32
    localHeader.writeUInt32LE(entry.data.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28);          // extra field length

    zipParts.push(localHeader, nameBuffer, entry.data);

    // Central directory entry
    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);     // central dir signature
    cdEntry.writeUInt16LE(20, 4);              // version made by
    cdEntry.writeUInt16LE(20, 6);              // version needed
    cdEntry.writeUInt16LE(0, 8);               // flags
    cdEntry.writeUInt16LE(0, 10);              // compression: stored
    cdEntry.writeUInt16LE(0, 12);              // mod time
    cdEntry.writeUInt16LE(0, 14);              // mod date
    cdEntry.writeUInt32LE(entry.crc, 16);      // crc-32
    cdEntry.writeUInt32LE(entry.data.length, 20); // compressed size
    cdEntry.writeUInt32LE(entry.data.length, 24); // uncompressed size
    cdEntry.writeUInt16LE(nameBuffer.length, 28); // filename length
    cdEntry.writeUInt16LE(0, 30);              // extra field length
    cdEntry.writeUInt16LE(0, 32);              // comment length
    cdEntry.writeUInt16LE(0, 34);              // disk number start
    cdEntry.writeUInt16LE(0, 36);              // internal attrs
    cdEntry.writeUInt32LE(0, 38);              // external attrs
    cdEntry.writeUInt32LE(offset, 42);         // local header offset

    centralDir.push(cdEntry, nameBuffer);

    offset += 30 + nameBuffer.length + entry.data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const part of centralDir) cdSize += part.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // end of central dir signature
  eocd.writeUInt16LE(0, 4);                    // disk number
  eocd.writeUInt16LE(0, 6);                    // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);       // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);      // total entries
  eocd.writeUInt32LE(cdSize, 12);              // central dir size
  eocd.writeUInt32LE(cdOffset, 16);            // central dir offset
  eocd.writeUInt16LE(0, 20);                   // comment length

  const zipBuffer = Buffer.concat([...zipParts, ...centralDir, eocd]);
  writeFileSync(xpiPath, zipBuffer);
  console.log(`XPI created: ${xpiPath} (${zipBuffer.length} bytes)`);
}

console.log(`Build complete (${isDev ? "dev" : "production"})`);
