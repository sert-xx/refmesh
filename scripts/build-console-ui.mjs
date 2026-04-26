// Bundle the console frontend (console-ui/) into dist/console-ui/.
// Invoked from package.json scripts. Pure ESM, no TypeScript transpile step
// needed here because tsx/tsc handle src/ separately.

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcDir = join(repoRoot, 'console-ui');
const outDir = join(repoRoot, 'dist', 'console-ui');

// Only the runtime-required assets are copied into the published bundle.
// Anything else (tsconfig.json, .ts sources, etc.) is dev-only.
const STATIC_ALLOWLIST = new Set(['index.html', 'styles.css']);

async function copyAllowedAssets(from, to) {
  const entries = await readdir(from, { withFileTypes: true });
  await mkdir(to, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!STATIC_ALLOWLIST.has(entry.name)) continue;
    await copyFile(join(from, entry.name), join(to, entry.name));
  }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(srcDir))) {
    console.error(`[build-console-ui] source dir missing: ${srcDir}`);
    process.exit(1);
  }
  await ensureDir(outDir);

  await copyAllowedAssets(srcDir, outDir);

  const entry = join(srcDir, 'app.ts');
  if (!(await exists(entry))) {
    console.error(`[build-console-ui] entry missing: ${entry}`);
    process.exit(1);
  }

  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    // Sourcemaps would balloon the published tarball (≈1.9MB) and they leak
    // dev paths. Keep them off in the build that actually ships.
    sourcemap: false,
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    outfile: join(outDir, 'app.js'),
    logLevel: 'info',
  });

  console.log(`[build-console-ui] bundled to ${relative(repoRoot, outDir)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
