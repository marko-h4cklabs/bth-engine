const CHAR_MAP: Record<string, string> = {
  'č': 'c', 'ć': 'c', 'š': 's', 'ž': 'z', 'đ': 'd',
  'Č': 'c', 'Ć': 'c', 'Š': 's', 'Ž': 'z', 'Đ': 'd',
  'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u',
  'ä': 'a', 'ë': 'e', 'ï': 'i', 'ö': 'o', 'ü': 'u',
};

export function toSlug(input: string): string {
  return input
    .replace(/\./g, '')           // strip dots so d.o.o. → doo, d.d. → dd
    .split('')
    .map((char) => CHAR_MAP[char] ?? char)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function clientSlug(businessName: string, city: string): string {
  return `${toSlug(businessName)}-${toSlug(city)}`;
}

// Short slug safe for Netlify subdomain names (≤63 chars).
// Takes only what's before the first comma (handles obrts like "FIZIOTIME, obrt za...")
// so "FIZIOTIME, obrt za usluge, vl. Petar Kopanja, Zagreb" → "fiziotime-zagreb".
export function toNetlifySlug(legalName: string, city: string): string {
  const brand = legalName.split(',')[0]!.trim();
  const brandSlug = toSlug(brand).slice(0, 35).replace(/-+$/, '');
  const citySlug  = toSlug(city).slice(0, 10).replace(/-+$/, '');
  return `${brandSlug}-${citySlug}`.replace(/-+/g, '-').replace(/-+$/, '').slice(0, 63);
}
