/**
 * Extension build.
 *
 * Five Rollup passes per target, because an extension is not one bundle:
 *   - popup.html / options.html / offscreen.html   ES modules, code-split
 *   - background.js                                one IIFE file (MV3 service
 *                                                  worker, and Firefox event page)
 *   - content.js                                   one IIFE file, no imports:
 *                                                  content scripts cannot be modules
 *   - page-hook.js                                 one IIFE file, injected into
 *                                                  the page's own world
 *
 * Rollup emits at most one IIFE bundle per build, hence the separate passes.
 *
 * Usage: node scripts/build.mjs [chrome|firefox|all]
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build } from 'vite';
import { writeIcons } from './icons.mjs';
import { buildManifest } from './manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = parseTargets(process.argv[2]);

function parseTargets(arg) {
  if (!arg || arg === 'all') return ['chrome', 'firefox'];
  if (arg === 'chrome' || arg === 'firefox' || arg === 'chrome-test') return [arg];
  throw new Error(`Unknown target "${arg}". Use chrome, firefox, chrome-test or all.`);
}

async function buildPages(outDir, target) {
  const input = {
    popup: join(root, 'src/ui/popup.html'),
    options: join(root, 'src/ui/options.html'),
  };
  // The offscreen document is a Chrome-only workaround; Firefox has a DOM in
  // its background page and does not need it.
  if (target === 'chrome') input.offscreen = join(root, 'src/ui/offscreen.html');

  await build({
    root: join(root, 'src/ui'),
    configFile: false,
    plugins: [svelte({ configFile: join(root, 'svelte.config.js') })],
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input,
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  });
}

async function buildScript(outDir, entry, fileName) {
  await build({
    root,
    configFile: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      minify: true,
      sourcemap: false,
      lib: {
        entry: join(root, entry),
        formats: ['iife'],
        name: fileName.replace(/\W/g, '_'),
        fileName: () => fileName,
      },
      rollupOptions: {
        output: { inlineDynamicImports: true, extend: true },
      },
    },
  });
}

async function buildTarget(name) {
  // `chrome-test` is the shipping Chrome build with test-only manifest changes;
  // everything it bundles is the real code.
  const isTest = name === 'chrome-test';
  const target = isTest ? 'chrome' : name;
  const outDir = join(root, 'dist', name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await buildPages(outDir, target);
  await buildScript(outDir, 'src/background/index.ts', 'background.js');
  await buildScript(outDir, 'src/content/index.ts', 'content.js');
  await buildScript(outDir, 'src/inject/page-hook.ts', 'page-hook.js');

  writeIcons(join(outDir, 'assets'));

  const localesSource = join(root, 'src/_locales');
  if (existsSync(localesSource)) {
    cpSync(localesSource, join(outDir, '_locales'), { recursive: true });
  }

  writeFileSync(
    join(outDir, 'manifest.json'),
    `${JSON.stringify(buildManifest(target, { test: isTest }), null, 2)}\n`,
  );

  console.log(`built ${name} -> dist/${name}`);
}

for (const target of targets) {
  await buildTarget(target);
}
