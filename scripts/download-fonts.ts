import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FONTS_DIR = resolve(__dirname, '../src/assets/fonts');

// Variable fonts — one file covers all weights (400/500/600)
const FONTS: Array<{ url: string; filename: string }> = [
  {
    url: 'https://fonts.gstatic.com/s/cormorantgaramond/v21/co3bmX5slCNuHLi8bLeY9MK7whWMhyjYqXtKky2F7g.woff2',
    filename: 'CormorantGaramond.woff2',
  },
  {
    url: 'https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2',
    filename: 'Inter.woff2',
  },
];

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

async function main(): Promise<void> {
  if (!existsSync(FONTS_DIR)) {
    mkdirSync(FONTS_DIR, { recursive: true });
  }

  for (const font of FONTS) {
    const dest = resolve(FONTS_DIR, font.filename);
    if (existsSync(dest)) {
      const size = (await import('fs')).statSync(dest).size;
      console.log(`  ✓ ${font.filename} (already exists, ${(size / 1024).toFixed(0)} KB)`);
      continue;
    }
    process.stdout.write(`  ↓ ${font.filename} ... `);
    await download(font.url, dest);
    const size = (await import('fs')).statSync(dest).size;
    console.log(`done (${(size / 1024).toFixed(0)} KB)`);
  }

  console.log('\nFonts ready in src/assets/fonts/');
}

main().catch((err) => {
  console.error('Font download failed:', err.message);
  process.exit(1);
});
