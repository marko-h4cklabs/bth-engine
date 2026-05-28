import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FONTS_DIR = resolve(__dirname, '../assets/fonts');

function fontUrl(filename: string): string {
  return pathToFileURL(resolve(FONTS_DIR, filename)).href;
}

export function getFontFaceCSS(): string {
  const cg = fontUrl('CormorantGaramond.woff2');
  const inter = fontUrl('Inter.woff2');

  // Both are variable fonts — declare each required weight from the same file
  return `
@font-face {
  font-family: 'CormorantGaramond';
  src: url('${cg}') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'CormorantGaramond';
  src: url('${cg}') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'CormorantGaramond';
  src: url('${cg}') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Inter';
  src: url('${inter}') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Inter';
  src: url('${inter}') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Inter';
  src: url('${inter}') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: block;
}`.trim();
}
