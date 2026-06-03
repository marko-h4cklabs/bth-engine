import { logger } from '../utils/logger.js';
import type { BusinessBase } from '../types/index.js';

function extractCityFromAddress(address: string): string {
  const parts = address.split(',').map((p) => p.trim());
  // Croatian postal code (5 digits)
  for (let i = 0; i < parts.length; i++) {
    if (/^\d{5}$/.test(parts[i] ?? '')) {
      return parts[i + 1] ?? 'Zagreb';
    }
  }
  // Before "Croatia" / "Hrvatska"
  const last = parts[parts.length - 1]?.toLowerCase() ?? '';
  if (last === 'croatia' || last === 'hrvatska') {
    return parts[parts.length - 2] ?? 'Zagreb';
  }
  return parts[parts.length - 1] ?? 'Zagreb';
}

async function resolveUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BTHBot/1.0)' },
    });
    return res.url;
  } catch {
    return url;
  }
}

export function extractPlaceId(url: string): string | null {
  const chijMatch = url.match(/!1s(ChIJ[A-Za-z0-9_-]+)/);
  return chijMatch?.[1] ?? null;
}

export function extractPlaceName(url: string): string | null {
  const nameMatch = url.match(/\/maps\/place\/([^/@?]+)/);
  if (nameMatch?.[1]) {
    return decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
  }
  return null;
}

export interface PlacesApiPlace {
  displayName?: { text: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  types?: string[];
}

export async function fetchPlaceById(placeId: string, apiKey: string): Promise<PlacesApiPlace | null> {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'displayName,formattedAddress,rating,userRatingCount,businessStatus,types',
    },
  });
  if (!res.ok) {
    logger.warn(`  Places detail API failed: ${res.status}`);
    return null;
  }
  return res.json() as Promise<PlacesApiPlace>;
}

export async function searchPlaceByText(query: string, apiKey: string): Promise<PlacesApiPlace | null> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.businessStatus,places.types',
    },
    body: JSON.stringify({ textQuery: query, languageCode: 'hr' }),
  });
  if (!res.ok) {
    logger.warn(`  Places text search failed: ${res.status}`);
    return null;
  }
  const data = await res.json() as { places?: PlacesApiPlace[] };
  return data.places?.[0] ?? null;
}

export async function resolveAndFetchPlace(googleMapsUrl: string, apiKey: string): Promise<PlacesApiPlace | null> {
  logger.info(`  Resolving URL: ${googleMapsUrl}`);
  const resolvedUrl = await resolveUrl(googleMapsUrl);
  if (resolvedUrl !== googleMapsUrl) {
    logger.info(`  Resolved to: ${resolvedUrl}`);
  }

  const placeId = extractPlaceId(resolvedUrl);
  if (placeId) {
    logger.info(`  Place ID found: ${placeId}`);
    const place = await fetchPlaceById(placeId, apiKey);
    if (place) return place;
  }

  const name = extractPlaceName(resolvedUrl);
  if (!name) {
    logger.warn(`  Could not extract place name from: ${resolvedUrl}`);
    return null;
  }
  logger.info(`  Searching by name: "${name}"`);
  return searchPlaceByText(name, apiKey);
}

export async function scrapeFromGoogleMaps(input: {
  googleMapsUrl: string;
  directorName: string;
}): Promise<BusinessBase> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set');

  logger.info(`Google Maps → Places API`);
  const place = await resolveAndFetchPlace(input.googleMapsUrl, apiKey);
  if (!place) throw new Error('Google Places API returned no results for the provided URL');

  const legalName = place.displayName?.text ?? '';
  logger.info(`  legalName: "${legalName}"`);

  const address = place.formattedAddress ?? '';
  logger.info(`  address: "${address}"`);

  const city = extractCityFromAddress(address);

  const nameParts = input.directorName.trim().split(/\s+/);
  const directorFirstName = nameParts[0] ?? '';
  const directorLastName = nameParts.slice(1).join(' ');
  const directorFullName = input.directorName.trim() || 'MANUAL_FILL';

  const registeredActivity = place.types?.[0] ?? '';
  logger.info(`  registeredActivity: "${registeredActivity}"`);
  logger.info(`  director: "${directorFullName}"`);

  return {
    legalName,
    oib: '',
    address,
    city,
    directorFirstName,
    directorLastName,
    directorFullName,
    registeredActivity,
  };
}
