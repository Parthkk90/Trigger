import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const isWatch = process.argv.includes('--watch');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyAssets() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(SRC, 'extension', 'manifest.json'), 'utf8')
  );
  manifest.content_scripts[0].js = ['content/content.js'];
  fs.mkdirSync(path.join(DIST, 'extension'), { recursive: true });
  fs.writeFileSync(
    path.join(DIST, 'extension', 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  fs.mkdirSync(path.join(DIST, 'extension', 'popup'), { recursive: true });
  fs.copyFileSync(
    path.join(SRC, 'extension', 'popup', 'popup.html'),
    path.join(DIST, 'extension', 'popup', 'popup.html')
  );

  const iconsDir = path.join(SRC, 'extension', 'icons');
  if (fs.existsSync(iconsDir)) {
    copyDir(iconsDir, path.join(DIST, 'extension', 'icons'));
  }

  const stylesDir = path.join(SRC, 'extension', 'styles');
  if (fs.existsSync(stylesDir)) {
    copyDir(stylesDir, path.join(DIST, 'extension', 'styles'));
  }

  fs.mkdirSync(path.join(DIST, 'viewer'), { recursive: true });
  const viewerHtml = path.join(SRC, 'viewer', 'index.html');
  if (fs.existsSync(viewerHtml)) {
    fs.copyFileSync(viewerHtml, path.join(DIST, 'viewer', 'index.html'));
  }

  const backendDirs = ['data', 'migrations'];
  for (const dir of backendDirs) {
    const src = path.join(SRC, 'backend', dir);
    if (fs.existsSync(src)) {
      copyDir(src, path.join(DIST, 'backend', dir));
    }
  }
}

const targets = [
  {
    name: 'content',
    entryPoints: [path.join(SRC, 'extension', 'content', 'bundle-entry.js')],
    outfile: path.join(DIST, 'extension', 'content', 'content.js'),
    format: 'iife',
    platform: 'browser',
  },
  {
    name: 'service-worker',
    entryPoints: [path.join(SRC, 'extension', 'background', 'service-worker.js')],
    outfile: path.join(DIST, 'extension', 'background', 'service-worker.js'),
    format: 'esm',
    platform: 'browser',
  },
  {
    name: 'popup',
    entryPoints: [path.join(SRC, 'extension', 'popup', 'popup.js')],
    outfile: path.join(DIST, 'extension', 'popup', 'popup.js'),
    format: 'iife',
    platform: 'browser',
  },
  {
    name: 'viewer',
    entryPoints: [path.join(SRC, 'viewer', 'viewer.js')],
    outfile: path.join(DIST, 'viewer', 'viewer.js'),
    format: 'iife',
    platform: 'browser',
  },
  {
    name: 'backend',
    entryPoints: [path.join(SRC, 'backend', 'server.js')],
    outfile: path.join(DIST, 'backend', 'server.js'),
    format: 'esm',
    platform: 'node',
    external: ['pg', 'fastify', '@fastify/cors', 'nanoid', 'bullmq'],
  },
  {
    name: 'worker',
    entryPoints: [path.join(SRC, 'workers', 'replay-worker.js')],
    outfile: path.join(DIST, 'workers', 'replay-worker.js'),
    format: 'esm',
    platform: 'node',
    external: ['playwright', 'bullmq'],
  },
];

async function build() {
  fs.rmSync(DIST, { recursive: true, force: true });

  copyAssets();

  const start = Date.now();
  const contexts = [];

  for (const target of targets) {
    const options = {
      entryPoints: target.entryPoints,
      outfile: target.outfile,
      format: target.format,
      platform: target.platform,
      bundle: true,
      sourcemap: false,
      external: target.external || [],
      logLevel: 'warning',
    };

    if (isWatch) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
      contexts.push(ctx);
      console.log(`  [watch] ${target.name}`);
    } else {
      await esbuild.build(options);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`Build complete in ${elapsed}ms`);

  if (isWatch) {
    console.log('Watching for changes...');
    process.on('SIGINT', () => {
      contexts.forEach((ctx) => ctx.dispose());
      process.exit(0);
    });
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
