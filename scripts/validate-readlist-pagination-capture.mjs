import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const rootDir = resolve(import.meta.dirname, "..");
const outDir = join(rootDir, ".cache", "scripts");
const outFile = join(outDir, "validate-readlist-pagination-capture.mjs");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(rootDir, "scripts", "pipeline", "validate-readlist-pagination-capture.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: outFile,
  packages: "external",
  sourcemap: false,
});

const result = spawnSync(process.execPath, ["--no-warnings", outFile, ...process.argv.slice(2)], {
  cwd: rootDir,
  stdio: "inherit",
  env: {
    ...process.env,
    DOUBAN_TO_ZOTERO_EXECUTION_MODE: process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE || "dry-run",
  },
});

process.exit(result.status ?? 1);
