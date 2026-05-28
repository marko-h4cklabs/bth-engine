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
