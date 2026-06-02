import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const rootDir = resolve(import.meta.dirname, "..");
const outDir = join(rootDir, ".cache", "tests");
const outFile = join(outDir, "parser-golden.test.mjs");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(rootDir, "tests", "parser-golden.test.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: outFile,
  packages: "external",
  sourcemap: false,
});

const result = spawnSync(process.execPath, ["--test", outFile], {
  cwd: rootDir,
  stdio: "inherit",
  env: {
    ...process.env,
    DOUBAN_TO_ZOTERO_EXECUTION_MODE: "dry-run",
  },
});

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

const dbResult = spawnSync(
  process.execPath,
  [
    join(rootDir, "scripts", "populate-dry-run-db.mjs"),
    "--out",
    join(rootDir, ".cache", "dry-run", "pipeline.sqlite"),
    "--summary",
    join(rootDir, ".cache", "dry-run", "pipeline-summary.json"),
    "--reset",
  ],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      DOUBAN_TO_ZOTERO_EXECUTION_MODE: "dry-run",
    },
  },
);

if ((dbResult.status ?? 1) !== 0) {
  process.exit(dbResult.status ?? 1);
}

const validateResult = spawnSync(
  process.execPath,
  [join(rootDir, "scripts", "validate-dry-run-db.mjs")],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      DOUBAN_TO_ZOTERO_EXECUTION_MODE: "dry-run",
    },
  },
);

if ((validateResult.status ?? 1) !== 0) {
  process.exit(validateResult.status ?? 1);
}

const uiResult = spawnSync(
  process.execPath,
  [join(rootDir, "scripts", "smoke-ui-contract.mjs")],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      DOUBAN_TO_ZOTERO_EXECUTION_MODE: "dry-run",
    },
  },
);

process.exit(uiResult.status ?? 1);
