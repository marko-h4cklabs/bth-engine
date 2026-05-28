import { existsSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FONTS_DIR = resolve(__dirname, '../src/assets/fonts');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// All variable fonts — one file covers the full weight range.
// Fraunces: italic-only file (opsz variable, wght 500, style italic).
// Cinzel, Outfit, Cormorant, Inter: weight-variable, normal style.
const FONTS: Array<{ url: string; filename: string }> = [
  {
    // Fraunces — italic, variable opsz+wght, Latin subset
    url: 'https://fonts.gstatic.com/s/fraunces/v38/6NUs8FyLNQOQZAnv9ZwNjucMHVn85Ni7emAe9lKqZTnbB-gzTK0K1ChJdt9hFwpX9W37lm1_mv0iQublWII.woff2',
    filename: 'Fraunces-Italic.woff2',
  },
  {
    // Cinzel — variable weight 400–900, Latin subset
    url: 'https://fonts.gstatic.com/s/cinzel/v26/8vIJ7ww63mVu7gt79mT7PkRXMw.woff2',
    filename: 'Cinzel.woff2',
  },
  {
    // Outfit — variable weight 100–900, Latin subset
    url: 'https://fonts.gstatic.com/s/outfit/v15/QGYvz_MVcBeNP4NJtEtqUYLknw.woff2',
    filename: 'Outfit.woff2',
  },
  {
    // Cormorant Garamond — variable, Latin subset
    url: 'https://fonts.gstatic.com/s/cormorantgaramond/v21/co3bmX5slCNuHLi8bLeY9MK7whWMhyjYqXtKky2F7g.woff2',
    filename: 'CormorantGaramond.woff2',
  },
  {
    // Inter — variable, Latin subset
    url: 'https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2',
    filename: 'Inter.woff2',
  },
];

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main(): Promise<void> {
  if (!existsSync(FONTS_DIR)) mkdirSync(FONTS_DIR, { recursive: true });

  for (const font of FONTS) {
    const dest = resolve(FONTS_DIR, font.filename);
    if (existsSync(dest)) {
      const kb = (statSync(dest).size / 1024).toFixed(0);
      console.log(`  ✓ ${font.filename} (already exists, ${kb} KB)`);
      continue;
    }
    process.stdout.write(`  ↓ ${font.filename} ... `);
    await download(font.url, dest);
    const kb = (statSync(dest).size / 1024).toFixed(0);
    console.log(`done (${kb} KB)`);
  }

  console.log('\nFonts ready in src/assets/fonts/');
}

main().catch((err) => {
  console.error('Font download failed:', err.message);
  process.exit(1);
});
