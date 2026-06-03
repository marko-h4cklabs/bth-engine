import { scrapeCompanyWall } from './companywall-scraper.js';
import { scrapeFinancials } from './1b-financials.js';
import { resolveAndFetchPlace } from './1-scraper.js';
import { scrapeAdsForName } from './2-enrichment.js';
import { extractBrandName } from './3-auditor.js';
import { getConfigSafe } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { ManualCompetitorData, FinancialData } from '../types/index.js';

function isGoogleMapsUrl(url: string): boolean {
  return (
    url.includes('maps.google.com') ||
    url.includes('maps.app.goo.gl') ||
    url.includes('google.com/maps')
  );
}

function extractCityFromAddress(address: string): string {
  const parts = address.split(',').map((p) => p.trim());
  for (let i = 0; i < parts.length; i++) {
    if (/^\d{5}$/.test(parts[i] ?? '')) return parts[i + 1] ?? 'Zagreb';
  }
  const last = parts[parts.length - 1]?.toLowerCase() ?? '';
  if (last === 'croatia' || last === 'hrvatska') return parts[parts.length - 2] ?? 'Zagreb';
  return parts[parts.length - 1] ?? 'Zagreb';
}

async function lookupGoogleRating(legalName: string, city: string, apiKey: string): Promise<{ rating: number; reviewCount: number }> {
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.rating,places.userRatingCount',
      },
      body: JSON.stringify({ textQuery: `${legalName} ${city}`, languageCode: 'hr' }),
    });
    if (!res.ok) return { rating: 0, reviewCount: 0 };
    const data = await res.json() as { places?: Array<{ rating?: number; userRatingCount?: number }> };
    const place = data.places?.[0];
    return { rating: place?.rating ?? 0, reviewCount: place?.userRatingCount ?? 0 };
  } catch {
    return { rating: 0, reviewCount: 0 };
  }
}

function computeAiScore(legalName: string, auditResponses: string[]): { score: number; mentions: number; verdict: string } {
  const brand = extractBrandName(legalName);
  if (!brand) return { score: 0, mentions: 0, verdict: 'INVISIBLE' };
  const mentions = auditResponses.filter(r => r.toLowerCase().includes(brand.toLowerCase())).length;
  const score = Math.round((mentions / Math.max(auditResponses.length, 1)) * 100);
  const verdict = score === 0 ? 'INVISIBLE' : score <= 40 ? 'WEAK' : score <= 80 ? 'PRESENT' : 'DOMINANT';
  return { score, mentions, verdict };
}

export async function scrapeManualCompetitor(
  sourceUrl: string,
  niche: string,
  nicheLabel: string,
  auditResponses: string[],
  targetCity?: string,
): Promise<ManualCompetitorData> {
  logger.info(`  [Competitor] Scraping: ${sourceUrl}`);
  const config = getConfigSafe();

  let legalName = '';
  let directorFullName = '';
  let city = '';
  let googleRating = 0;
  let googleReviewCount = 0;

  if (isGoogleMapsUrl(sourceUrl)) {
    // ── Google Maps path ──────────────────────────────────────────────────
    logger.info('  [Competitor] Source: Google Maps');
    if (!config.GOOGLE_PLACES_API_KEY) {
      logger.warn('  [Competitor] GOOGLE_PLACES_API_KEY not set — cannot fetch place details');
    } else {
      try {
        const place = await resolveAndFetchPlace(sourceUrl, config.GOOGLE_PLACES_API_KEY);
        if (place) {
          legalName = place.displayName?.text ?? '';
          city = extractCityFromAddress(place.formattedAddress ?? '');
          googleRating = place.rating ?? 0;
          googleReviewCount = place.userRatingCount ?? 0;
          logger.info(`  [Competitor] Name: ${legalName} | ${googleRating}★ (${googleReviewCount})`);
          if (targetCity && city && city.toLowerCase() !== targetCity.toLowerCase()) {
            logger.warn(`  [Competitor] City mismatch: ${city} vs target ${targetCity}`);
          }
        }
      } catch (err) {
        logger.warn(`  [Competitor] Google Maps fetch failed: ${err instanceof Error ? err.message : err}`);
        legalName = sourceUrl.split('/').filter(Boolean).pop() ?? 'Unknown';
      }
    }
    directorFullName = 'MANUAL_FILL';
  } else {
    // ── CompanyWall path ──────────────────────────────────────────────────
    logger.info('  [Competitor] Source: CompanyWall');
    try {
      const biz = await scrapeCompanyWall(sourceUrl);
      legalName = biz.legalName;
      directorFullName = biz.directorFullName;
      city = biz.city;
      logger.info(`  [Competitor] Name: ${legalName}`);
      if (targetCity && city && city.toLowerCase() !== targetCity.toLowerCase()) {
        logger.warn(`  [Competitor] City mismatch: ${city} vs target ${targetCity}`);
      }
    } catch (err) {
      logger.warn(`  [Competitor] CompanyWall scrape failed: ${err instanceof Error ? err.message : err}`);
      legalName = sourceUrl.split('/').filter(Boolean).pop() ?? 'Unknown';
    }

    if (config.GOOGLE_PLACES_API_KEY && legalName) {
      const g = await lookupGoogleRating(legalName, city, config.GOOGLE_PLACES_API_KEY);
      googleRating = g.rating;
      googleReviewCount = g.reviewCount;
      logger.info(`  [Competitor] Google: ${googleRating}★ (${googleReviewCount} reviews)`);
    }
  }

  // ── Ads scraping ──────────────────────────────────────────────────────────
  const searchName = legalName.replace(/\s+(d\.o\.o\.?|d\.d\.?|j\.d\.o\.o\.?).*$/i, '').trim();
  const ads = await scrapeAdsForName(searchName).catch(err => {
    logger.warn(`  [Competitor] Ads scrape failed: ${err instanceof Error ? err.message : err}`);
    return { metaRunning: false, metaCount: 0, googleRunning: false, googleCount: 0 };
  });
  logger.info(`  [Competitor] Meta: ${ads.metaRunning} (${ads.metaCount}) | Gads: ${ads.googleRunning} (${ads.googleCount})`);

  // ── AI score ──────────────────────────────────────────────────────────────
  const ai = computeAiScore(legalName, auditResponses);
  logger.info(`  [Competitor] AI: ${ai.score}/100 ${ai.verdict}`);

  // ── Financial scrape (CompanyWall only) ───────────────────────────────────
  let financials: FinancialData | null = null;
  if (!isGoogleMapsUrl(sourceUrl)) {
    try {
      const fin = await scrapeFinancials(sourceUrl);
      if (fin.years.length > 0 && fin.years[0]!.revenue > 0) {
        financials = fin;
        logger.info(`  [Competitor] Financials: €${fin.years[0]!.revenue.toLocaleString('hr-HR')} revenue`);
      }
    } catch {
      // non-fatal
    }
  }

  void niche; void nicheLabel;

  return {
    companyWallUrl: sourceUrl,
    legalName,
    directorFullName,
    googleRating,
    googleReviewCount,
    metaAdsRunning: ads.metaRunning,
    metaAdCount: ads.metaCount,
    googleAdsRunning: ads.googleRunning,
    googleAdCount: ads.googleCount,
    aiMentionCount: ai.mentions,
    aiVisibilityScore: ai.score,
    aiVerdict: ai.verdict,
    financials,
  };
}
