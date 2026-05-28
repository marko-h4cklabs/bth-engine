import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FONTS_DIR = resolve(__dirname, '../assets/fonts');

function fontUrl(filename: string): string {
  return pathToFileURL(resolve(FONTS_DIR, filename)).href;
}

export function getFontFaceCSS(): string {
  const fraunces = fontUrl('Fraunces-Italic.woff2');
  const cinzel   = fontUrl('Cinzel.woff2');
  const outfit   = fontUrl('Outfit.woff2');
  const cg       = fontUrl('CormorantGaramond.woff2');

  return `
@font-face{font-family:'Fraunces';src:url('${fraunces}') format('woff2');font-weight:100 900;font-style:italic;font-display:block}
@font-face{font-family:'Cinzel';src:url('${cinzel}') format('woff2');font-weight:400 900;font-style:normal;font-display:block}
@font-face{font-family:'Outfit';src:url('${outfit}') format('woff2');font-weight:100 900;font-style:normal;font-display:block}
@font-face{font-family:'CormorantGaramond';src:url('${cg}') format('woff2');font-weight:400 700;font-style:normal;font-display:block}
@font-face{font-family:'CormorantGaramond';src:url('${cg}') format('woff2');font-weight:400 700;font-style:italic;font-display:block}`.trim();
}
