import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const rootDir = resolve(import.meta.dirname, "..");
const outDir = join(rootDir, ".cache", "scripts");
const outFile = join(outDir, "capture-structure-study.mjs");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(rootDir, "scripts", "pipeline", "capture-structure-study.ts")],
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
  env: process.env,
});

process.exit(result.status ?? 1);
