import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import sharp from 'sharp';

await mkdir('dist', { recursive: true });
await mkdir('extension/icons', { recursive: true });
await mkdir('dist/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const source = 'extension/icons/cube.svg';
  const destination = `extension/icons/icon${size}.png`;
  await sharp(source, { density: 288 }).resize(size, size).png().toFile(destination);
  await cp(destination, `dist/icons/icon${size}.png`);
}
await build({
  entryPoints: {
    content: 'src/content.js',
    background: 'src/background.js',
    popup: 'src/popup.js',
    downloader: 'src/downloader.js',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
});
for (const name of ['manifest.json', 'popup.html', 'popup.css', 'downloader.html', 'downloader.css']) {
  await cp(`extension/${name}`, `dist/${name}`);
}
