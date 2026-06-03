import { scrapeCompanyWall } from './1-scraper.js';
import { scrapeFinancials } from './1b-financials.js';
import { scrapeAdsForName } from './2-enrichment.js';
import { extractBrandName } from './3-auditor.js';
import { getConfigSafe } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { ManualCompetitorData, FinancialData } from '../types/index.js';

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
  companyWallUrl: string,
  niche: string,
  nicheLabel: string,
  auditResponses: string[],
  targetCity?: string,
): Promise<ManualCompetitorData> {
  logger.info(`  [Competitor] Scraping: ${companyWallUrl}`);
  const config = getConfigSafe();

  // Step 1: CompanyWall scrape
  let legalName = '';
  let directorFullName = '';
  let city = '';
  try {
    const biz = await scrapeCompanyWall(companyWallUrl);
    legalName = biz.legalName;
    directorFullName = biz.directorFullName;
    city = biz.city;
    logger.info(`  [Competitor] Name: ${legalName}`);
    if (targetCity && city && city.toLowerCase() !== targetCity.toLowerCase()) {
      logger.warn(`  [Competitor] WARNING: competitor city (${city}) differs from target city (${targetCity}) — verify the URL is correct`);
    }
  } catch (err) {
    logger.warn(`  [Competitor] CompanyWall scrape failed: ${err instanceof Error ? err.message : err}`);
    legalName = companyWallUrl.split('/').filter(Boolean).pop() ?? 'Unknown';
  }

  // Step 2: Google Places rating
  let googleRating = 0;
  let googleReviewCount = 0;
  if (config.GOOGLE_PLACES_API_KEY) {
    const g = await lookupGoogleRating(legalName, city, config.GOOGLE_PLACES_API_KEY);
    googleRating = g.rating;
    googleReviewCount = g.reviewCount;
    logger.info(`  [Competitor] Google: ${googleRating}★ (${googleReviewCount} reviews)`);
  }

  // Step 3: Ads scraping (Meta + Google Ads)
  const searchName = legalName.replace(/\s+(d\.o\.o\.?|d\.d\.?|j\.d\.o\.o\.?).*$/i, '').trim();
  const ads = await scrapeAdsForName(searchName).catch(err => {
    logger.warn(`  [Competitor] Ads scrape failed: ${err instanceof Error ? err.message : err}`);
    return { metaRunning: false, metaCount: 0, googleRunning: false, googleCount: 0 };
  });
  logger.info(`  [Competitor] Meta: ${ads.metaRunning} (${ads.metaCount}) | Gads: ${ads.googleRunning} (${ads.googleCount})`);

  // Step 4: AI score from existing responses
  const ai = computeAiScore(legalName, auditResponses);
  logger.info(`  [Competitor] AI: ${ai.score}/100 ${ai.verdict}`);

  // Step 5: Financial scrape (non-fatal)
  let financials: FinancialData | null = null;
  try {
    const fin = await scrapeFinancials(companyWallUrl);
    if (fin.years.length > 0 && fin.years[0]!.revenue > 0) {
      financials = fin;
      logger.info(`  [Competitor] Financials: €${fin.years[0]!.revenue.toLocaleString('hr-HR')} revenue`);
    }
  } catch {
    // non-fatal
  }

  void niche; void nicheLabel;

  return {
    companyWallUrl,
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
