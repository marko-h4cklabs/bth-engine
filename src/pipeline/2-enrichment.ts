import { chromium } from 'playwright';
import { logger } from '../utils/logger.js';
import { sleep, randomBetween } from '../utils/sleep.js';
import { getConfigSafe } from '../utils/config.js';
import type { BusinessBase, GoogleData, MetaAdData, GoogleAdsData } from '../types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Strip Croatian legal form suffixes to get a usable search/ad query name.
// "POLIKLINIKA BAGATIN d.o.o." → "POLIKLINIKA BAGATIN"
// "BAGATIN d.d." → "BAGATIN"
const LEGAL_FORM_RE = /\s+(d\.o\.o\.?|d\.d\.?|j\.d\.o\.o\.?|j\.t\.d\.?|k\.d\.?|drustvo\s+s|društvo\s+s).*$/i;

function toSearchName(legalName: string): string {
  return legalName.replace(LEGAL_FORM_RE, '').trim();
}

// ── Google Places API (New) ───────────────────────────────────────────────────

interface PlaceResult {
  id: string;
  displayName: { text: string };
  rating?: number;
  userRatingCount?: number;
  types?: string[];
}

interface PlacesTextSearchResponse {
  places?: PlaceResult[];
}

async function googleTextSearch(query: string, apiKey: string): Promise<PlaceResult[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.types',
    },
    body: JSON.stringify({ textQuery: query, languageCode: 'hr' }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Places API HTTP ${res.status}: ${text}`);
  }

  const data = await res.json() as PlacesTextSearchResponse;
  return data.places ?? [];
}

function competitorScore(r: PlaceResult): number {
  const rating = r.rating ?? 0;
  const count = r.userRatingCount ?? 0;
  return rating * Math.log(count + 1);
}

function nameSimilar(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(a).includes(normalize(b).slice(0, 6)) ||
    normalize(b).includes(normalize(a).slice(0, 6));
}

// Place types that definitively flag a result as a non-service business
const EXCLUDED_PLACE_TYPES = new Set([
  'university', 'school', 'primary_school', 'secondary_school', 'junior_college',
  'bank', 'atm', 'insurance_agency',
  'real_estate_agency', 'car_dealer', 'car_repair', 'car_wash',
  'government', 'city_hall', 'courthouse', 'embassy', 'local_government_office',
  'supermarket', 'grocery_or_supermarket', 'convenience_store',
  'parking', 'transit_station', 'bus_station', 'train_station',
]);

function getRelevantPlaceTypes(niche: string, nicheLabel: string): Set<string> {
  const combined = `${niche} ${nicheLabel}`.toLowerCase();
  const types = new Set<string>();

  if (/zubar|dental|zub/.test(combined)) {
    types.add('dentist'); types.add('doctor'); types.add('health');
  }
  if (/klinik|poliklinik|ordinacij|doktor|medicin|fiziotera|dermatolog|oftalmolog|ginekolog/.test(combined)) {
    types.add('doctor'); types.add('hospital'); types.add('health'); types.add('physiotherapist');
  }
  if (/kozmetik|beauty|spa/.test(combined)) {
    types.add('beauty_salon'); types.add('spa'); types.add('hair_care');
  }
  if (/salon|frizjer/.test(combined)) {
    types.add('hair_care'); types.add('beauty_salon');
  }
  if (/gym|fitness|teretana|sport/.test(combined)) {
    types.add('gym'); types.add('health');
  }

  return types;
}

function isRelevantCompetitor(types: string[], relevantTypes: Set<string>): boolean {
  if (!types || types.length === 0) return true;
  if (types.some((t) => EXCLUDED_PLACE_TYPES.has(t))) return false;
  if (relevantTypes.size === 0) return true;
  return types.some((t) => relevantTypes.has(t));
}

function getCompetitorQuery(nicheLabel: string, niche: string, city: string): string {
  const combined = `${niche} ${nicheLabel}`.toLowerCase();
  if (/zubar|dental|klinik|ordinacij|doktor|medicin|fiziotera/.test(combined)) {
    return `${nicheLabel} ordinacija ${city}`;
  }
  return `${nicheLabel} privatna ${city}`;
}

async function fetchGoogleData(
  business: BusinessBase,
  niche: string,
  nicheLabel: string,
  apiKey: string,
): Promise<GoogleData> {
  logger.info('  [Google] Searching for target business...');

  const targetResults = await googleTextSearch(
    `${business.legalName} ${business.city}`,
    apiKey,
  );

  const target = targetResults[0];
  if (!target) {
    logger.warn(`  [Google] No results found for "${business.legalName}"`);
    return { rating: 0, reviewCount: 0, placeId: '', competitors: [] };
  }

  const targetName = target.displayName.text;
  logger.info(`  [Google] Found: "${targetName}" (${target.rating ?? 0}★, ${target.userRatingCount ?? 0} reviews)`);

  const competitorQuery = getCompetitorQuery(nicheLabel, niche, business.city);
  logger.info(`  [Google] Competitor query: "${competitorQuery}"`);
  const competitorResults = await googleTextSearch(competitorQuery, apiKey);

  const relevantTypes = getRelevantPlaceTypes(niche, nicheLabel);
  const filtered = competitorResults
    .filter((r) => !nameSimilar(r.displayName.text, business.legalName))
    .filter((r) => isRelevantCompetitor(r.types ?? [], relevantTypes));

  if (filtered.length < 2) {
    logger.warn(`  [Google] Only ${filtered.length} relevant competitor(s) found after type filtering — using whatever is available`);
  }

  const competitors = filtered
    .sort((a, b) => competitorScore(b) - competitorScore(a))
    .slice(0, 2)
    .map((r) => ({
      name: r.displayName.text,
      rating: r.rating ?? 0,
      reviewCount: r.userRatingCount ?? 0,
      placeId: r.id,
    }));

  for (const c of competitors) {
    logger.info(`  [Google] Competitor: "${c.name}" (${c.rating}★, ${c.reviewCount} reviews)`);
  }

  return {
    rating: target.rating ?? 0,
    reviewCount: target.userRatingCount ?? 0,
    placeId: target.id,
    competitors,
  };
}

// ── Meta Ad Library ───────────────────────────────────────────────────────────

const META_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function scrapeMetaAds(
  page: import('playwright').Page,
  businessName: string,
): Promise<{ isRunning: boolean; count: number; samples: MetaAdData['adSamples'] }> {
  const encoded = encodeURIComponent(businessName);
  const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=HR&q=${encoded}&media_type=all`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(randomBetween(2000, 4000));

    // Wait for either results or "no ads" message
    await Promise.race([
      page.waitForSelector('[class*="x1yztbdb"]', { timeout: 8000 }).catch(() => null),
      page.waitForSelector('[class*="x1rg5ohu"]', { timeout: 8000 }).catch(() => null),
      sleep(8000),
    ]);

    const result = await page.evaluate(() => {
      // Look for ad cards — Meta uses long generated class names, so we look for structural patterns
      const adCards = Array.from(
        document.querySelectorAll('[data-testid*="ad"], [class*="card"], [role="article"]'),
      ).filter((el) => {
        const text = el.textContent ?? '';
        // Ad cards typically mention page names, "sponsored", dates, etc.
        return text.length > 50 && el.getBoundingClientRect().height > 50;
      });

      // Also count by looking for date/status patterns common in Meta Ad Library
      const pageText = document.body.innerText;
      const noResultsIndicators = [
        'No results', 'Nema rezultata', 'No ads', 'nije pronađen',
      ];
      const hasNoResults = noResultsIndicators.some((s) =>
        pageText.toLowerCase().includes(s.toLowerCase()),
      );

      if (hasNoResults || adCards.length === 0) {
        return { isRunning: false, count: 0, samples: [] };
      }

      const samples = adCards.slice(0, 2).map((card) => {
        const text = card.textContent?.trim() ?? '';
        const lines = text.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 5);
        const sample: { headline?: string; body?: string } = {};
        if (lines[0]) sample.headline = lines[0];
        if (lines[1]) sample.body = lines[1];
        return sample;
      });

      return { isRunning: true, count: adCards.length, samples };
    });

    return result;
  } catch (err) {
    logger.warn(`  [Meta] Failed to scrape ads for "${businessName}": ${err instanceof Error ? err.message : err}`);
    return { isRunning: false, count: 0, samples: [] };
  }
}

// ── Google Ads Transparency Center ───────────────────────────────────────────

async function scrapeGoogleAds(
  page: import('playwright').Page,
  businessName: string,
): Promise<{ isRunning: boolean; count: number }> {
  const encoded = encodeURIComponent(businessName);
  const url = `https://adstransparency.google.com/advertiser?query=${encoded}&region=HR`;

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    // Extra wait for Angular to finish rendering
    await sleep(randomBetween(2500, 3500));

    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const lower = bodyText.toLowerCase();

      const noResultPhrases = ['no results', '0 results', 'no advertisers', 'nema rezultata', 'no ads found'];
      if (noResultPhrases.some((p) => lower.includes(p))) {
        return { isRunning: false, count: 0 };
      }

      // GAT Angular components and generic Material card selectors
      const cards = document.querySelectorAll(
        'gat-advertiser-preview, gat-advertiser-surface, ' +
        '[class*="advertiser-card"], [class*="advertiser-item"], ' +
        'mat-card:not([class*="header"]):not([class*="filter"])',
      );

      if (cards.length > 0) {
        return { isRunning: true, count: cards.length };
      }

      // Text-based fallback: "X advertiser(s)" or "X ads"
      const countMatch = bodyText.match(/(\d+)\s*(?:advertiser|ogla[sš])/i);
      if (countMatch) {
        const n = parseInt(countMatch[1]!, 10);
        return { isRunning: n > 0, count: n };
      }

      // If the page loaded content but no explicit "no results", assume something is there
      const hasContent = bodyText.trim().length > 200;
      return { isRunning: hasContent, count: hasContent ? 1 : 0 };
    });

    return result;
  } catch (err) {
    logger.warn(`  [GoogleAds] Scrape failed for "${businessName}": ${err instanceof Error ? err.message : err}`);
    return { isRunning: false, count: 0 };
  }
}

// ── Combined ads scraper (one browser, two scrapers) ─────────────────────────

async function fetchAdsData(
  business: BusinessBase,
  competitors: GoogleData['competitors'],
): Promise<{ meta: MetaAdData; googleAds: GoogleAdsData }> {
  logger.info('  [Ads] Launching browser for ad scraping...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: META_UA,
      locale: 'hr-HR',
      timezoneId: 'Europe/Zagreb',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'hr-HR,hr;q=0.9,en-US;q=0.8,en;q=0.7' },
    });

    const page = await context.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,mp4,woff,woff2}', (r) => r.abort());

    const searchName = toSearchName(business.legalName);

    // ── Meta ────────────────────────────────────────────────────────────────
    logger.info(`  [Meta] Checking ads for "${searchName}"...`);
    const targetMeta = await scrapeMetaAds(page, searchName);
    logger.info(`  [Meta] Running: ${targetMeta.isRunning} (${targetMeta.count})`);

    await sleep(randomBetween(1500, 2500));

    const metaCompetitorAds: MetaAdData['competitorAds'] = [];
    for (const comp of competitors) {
      logger.info(`  [Meta] Checking "${comp.name}"...`);
      const r = await scrapeMetaAds(page, comp.name);
      metaCompetitorAds.push({ businessName: comp.name, isRunningAds: r.isRunning, activeAdCount: r.count });
      logger.info(`  [Meta] ${comp.name}: running=${r.isRunning} (${r.count})`);
      await sleep(randomBetween(1500, 2500));
    }

    // ── Google Ads Transparency Center ───────────────────────────────────────
    logger.info(`  [GoogleAds] Checking "${searchName}"...`);
    const targetGads = await scrapeGoogleAds(page, searchName);
    logger.info(`  [GoogleAds] Running: ${targetGads.isRunning} (${targetGads.count})`);

    await sleep(randomBetween(1500, 2500));

    const gadsCompetitorAds: GoogleAdsData['competitorAds'] = [];
    for (const comp of competitors) {
      logger.info(`  [GoogleAds] Checking "${comp.name}"...`);
      const r = await scrapeGoogleAds(page, comp.name);
      gadsCompetitorAds.push({ businessName: comp.name, isRunningAds: r.isRunning, adCount: r.count });
      logger.info(`  [GoogleAds] ${comp.name}: running=${r.isRunning} (${r.count})`);
      await sleep(randomBetween(1500, 2500));
    }

    return {
      meta: {
        isRunningAds: targetMeta.isRunning,
        activeAdCount: targetMeta.count,
        adSamples: targetMeta.samples,
        competitorAds: metaCompetitorAds,
      },
      googleAds: {
        isRunningAds: targetGads.isRunning,
        adCount: targetGads.count,
        competitorAds: gadsCompetitorAds,
      },
    };
  } finally {
    await browser.close();
  }
}

// ── Single-name ads scraper ───────────────────────────────────────────────────

export async function scrapeAdsForName(name: string): Promise<{
  metaRunning: boolean; metaCount: number;
  googleRunning: boolean; googleCount: number;
}> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext({
      userAgent: META_UA, locale: 'hr-HR', timezoneId: 'Europe/Zagreb',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'hr-HR,hr;q=0.9,en-US;q=0.8' },
    });
    const page = await context.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,mp4,woff,woff2}', (r) => r.abort());
    const meta = await scrapeMetaAds(page, name);
    await sleep(randomBetween(1500, 2500));
    const gads = await scrapeGoogleAds(page, name);
    return { metaRunning: meta.isRunning, metaCount: meta.count, googleRunning: gads.isRunning, googleCount: gads.count };
  } finally {
    await browser.close();
  }
}

// ── Public export ─────────────────────────────────────────────────────────────

export async function enrichBusinessData(
  business: BusinessBase,
  niche: string,
  nicheLabel: string,
): Promise<{ google: GoogleData; meta: MetaAdData; googleAds: GoogleAdsData }> {
  const config = getConfigSafe();
  const apiKey = config.GOOGLE_PLACES_API_KEY;

  const googlePromise = apiKey
    ? fetchGoogleData(business, niche, nicheLabel, apiKey).catch((err) => {
        logger.warn(`[Google] Enrichment failed: ${err instanceof Error ? err.message : err}`);
        return { rating: 0, reviewCount: 0, placeId: '', competitors: [] };
      })
    : (logger.warn('[Google] GOOGLE_PLACES_API_KEY not set — skipping'),
       Promise.resolve({ rating: 0, reviewCount: 0, placeId: '', competitors: [] }));

  const google = await googlePromise;

  const emptyAds = {
    meta: { isRunningAds: false, activeAdCount: 0, adSamples: [], competitorAds: [] },
    googleAds: { isRunningAds: false, adCount: 0, competitorAds: [] },
  };

  const { meta, googleAds } = await fetchAdsData(business, google.competitors).catch((err) => {
    logger.warn(`[Ads] Scraping failed: ${err instanceof Error ? err.message : err}`);
    return emptyAds;
  });

  // Pain signals
  if (!meta.isRunningAds && meta.competitorAds.some((c) => c.isRunningAds)) {
    logger.warn('⚠  HIGH PAIN: Target not running Meta Ads, competitor is.');
  }
  if (!googleAds.isRunningAds && googleAds.competitorAds.some((c) => c.isRunningAds)) {
    logger.warn('⚠  HIGH PAIN: Target not running Google Ads, competitor is.');
  }

  void niche;

  return { google, meta, googleAds };
}
