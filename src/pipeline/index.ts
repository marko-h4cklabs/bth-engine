import { logger } from '../utils/logger.js';
import { clientSlug } from '../utils/slug.js';
import { getNiche, upsertClient } from '../db/client.js';
import { getConfigSafe } from '../utils/config.js';
import { generateQrBase64 } from '../utils/qr.js';
import { scrapeCompanyWall } from './1-scraper.js';
import { scrapeFinancials } from './1b-financials.js';
import { enrichBusinessData } from './2-enrichment.js';
import { runAiAudit } from './3-auditor.js';
import { scrapeManualCompetitor } from './competitors.js';
import { assembleDossierData, composePdf } from './4-composer.js';
import { generateLandingPage } from '../landing/generator.js';
import { deployLandingPage } from '../landing/deployer.js';
import type { PipelineInput, PipelineOutput } from '../types/index.js';

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const config = getConfigSafe();

  // ── Step 1 — Scrape CompanyWall ───────────────────────────────────────────
  logger.section('Step 1 — Scraping CompanyWall');
  let business;
  try {
    business = await scrapeCompanyWall(input.companyWallUrl);
  } catch (err) {
    logger.error(`Step 1 failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
  logger.data('Legal name', business.legalName);
  logger.data('OIB',        business.oib || '(not found)');
  logger.data('Address',    business.address || '(not found)');
  logger.data('Director',   business.directorFullName);
  logger.data('Activity',   business.registeredActivity || '(not found)');

  if (!config.GOOGLE_PLACES_API_KEY) {
    logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.warn('GOOGLE_PLACES_API_KEY not set.');
    logger.warn('Page 1 competitor table will have empty data.');
    logger.warn('Get a key: console.cloud.google.com → Places API');
    logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  // ── Step 1b — Financial scrape ────────────────────────────────────────────
  logger.section('Step 1b — Financial data');
  let financials;
  try {
    financials = await scrapeFinancials(input.companyWallUrl);
    if (financials.years.length > 0) {
      const latest = financials.years[0]!;
      logger.data('Latest year',   String(latest.year));
      logger.data('Revenue',       `€${latest.revenue.toLocaleString('hr-HR')}`);
      logger.data('Profit trend',  financials.profitTrend);
      logger.data('Employees',     String(financials.employeeCount));
      logger.data('Est. budget',   `€${financials.estimatedMarketingBudget.toLocaleString('hr-HR')}`);
    } else {
      logger.warn('  No financial data available for this company');
    }
  } catch (err) {
    logger.warn(`Step 1b failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    financials = {
      years: [], revenueGrowth: 0, profitTrend: 'stable' as const,
      employeeCount: 0, estimatedMarketingBudget: 0, currentDigitalSpend: 0,
      dataSource: 'companywall' as const,
    };
  }

  // ── Step 2 — Enrich data ──────────────────────────────────────────────────
  logger.section('Step 2 — Enriching data');

  const nicheRecord = getNiche(input.niche);
  const nicheLabel = nicheRecord?.labelHR ?? input.niche;

  let google, meta, googleAds;
  try {
    ({ google, meta, googleAds } = await enrichBusinessData(business, input.niche, nicheLabel));
  } catch (err) {
    logger.error(`Step 2 failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
  logger.data('Google rating',       String(google.rating));
  logger.data('Review count',        String(google.reviewCount));
  logger.data('Running Meta ads',    String(meta.isRunningAds));
  logger.data('Running Google Ads',  String(googleAds.isRunningAds));
  logger.data('Competitor 1',        google.competitors[0]?.name ?? 'none found');
  logger.data('Competitor 2',        google.competitors[1]?.name ?? 'none found');

  // ── Step 3 — AI Visibility Audit ─────────────────────────────────────────
  logger.section('Step 3 — AI Visibility Audit');
  let audit;
  try {
    audit = await runAiAudit(business, input.niche, nicheLabel, google.competitors);
  } catch (err) {
    logger.error(`Step 3 failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
  logger.data('Visibility score',     `${audit.visibilityScore}/100`);
  logger.data('Verdict',              audit.verdict);
  logger.data('Top competitor in AI', audit.topCompetitorInAI || 'none detected');

  // ── Step 3b — Manual competitors ─────────────────────────────────────────
  let manualCompetitor1 = null;
  let manualCompetitor2 = null;
  if (input.competitor1Url || input.competitor2Url) {
    logger.section('Step 3b — Manual competitor scraping');
    const auditResponses = audit.queries.map(q => q.response);
    const [c1, c2] = await Promise.all([
      input.competitor1Url ? scrapeManualCompetitor(input.competitor1Url, input.niche, nicheLabel, auditResponses).catch(err => {
        logger.warn(`Competitor 1 failed: ${err instanceof Error ? err.message : err}`);
        return null;
      }) : Promise.resolve(null),
      input.competitor2Url ? scrapeManualCompetitor(input.competitor2Url, input.niche, nicheLabel, auditResponses).catch(err => {
        logger.warn(`Competitor 2 failed: ${err instanceof Error ? err.message : err}`);
        return null;
      }) : Promise.resolve(null),
    ]);
    manualCompetitor1 = c1;
    manualCompetitor2 = c2;
    if (c1) logger.data('Competitor 1', c1.legalName);
    if (c2) logger.data('Competitor 2', c2.legalName);
  }

  const slug = clientSlug(business.legalName, business.city);
  const domain = config.AGENCY_DOMAIN ?? 'https://agencija.hr';
  const output: PipelineOutput = { business, google, meta, googleAds, financials, audit, slug, manualCompetitor1, manualCompetitor2 };

  // ── Step 4 — Landing page HTML ───────────────────────────────────────────
  // QR is not in the landing page HTML — assemble dossier with empty QR so
  // the page can be built before the URL is confirmed live.
  logger.section('Step 4 — Building landing page HTML');
  let landingPagePath = '';
  let deployedUrl = `https://${slug}.netlify.app`;
  try {
    if (input.dryRun) {
      logger.warn('  DRY RUN — skipping landing page generation');
    } else {
      const dossierForLanding = assembleDossierData(
        output, input.niche, nicheLabel, deployedUrl, '',
      );
      landingPagePath = await generateLandingPage(dossierForLanding);
    }
  } catch (err) {
    logger.error(`Step 4 failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // ── Step 5 — Deploy landing page ─────────────────────────────────────────
  logger.section('Step 5 — Deploying landing page');
  try {
    if (!input.dryRun) {
      deployedUrl = await deployLandingPage(landingPagePath, slug);
      logger.success(`  Live at: ${deployedUrl}`);
    }
  } catch (err) {
    logger.error(`Step 5 failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // ── Step 6 — QR code (URL is now confirmed live) ─────────────────────────
  logger.section('Step 6 — Generating QR code');
  let qrBase64 = '';
  try {
    if (!input.dryRun) {
      qrBase64 = await generateQrBase64(deployedUrl);
      logger.success(`  QR generated → ${deployedUrl}`);
    }
  } catch (err) {
    logger.error(`Step 6 failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // ── Assemble final DossierData (confirmed URL + real QR) ─────────────────
  const dossierData = assembleDossierData(
    output, input.niche, nicheLabel, deployedUrl, qrBase64,
  );

  // ── Step 7 — Compose PDF (last — URL is live, QR is real) ────────────────
  logger.section('Step 7 — Composing PDF');
  let pdfPath: string;
  try {
    if (input.dryRun) {
      logger.warn('  DRY RUN — skipping PDF generation');
      pdfPath = '';
    } else {
      pdfPath = await composePdf(
        dossierData,
        config.AGENCY_NAME ?? 'BTH Agency',
        domain,
      );
    }
  } catch (err) {
    logger.error(`Step 7 failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // ── Persist to DB ─────────────────────────────────────────────────────────
  upsertClient({
    slug,
    businessName: business.legalName,
    oib: business.oib || null,
    directorFullName: business.directorFullName !== 'MANUAL_FILL'
      ? business.directorFullName : null,
    niche: input.niche,
    city: business.city,
    status: 'generated',
    pdfPath: pdfPath || null,
    landingPageUrl: deployedUrl || null,
    visibilityScore: audit.visibilityScore,
    verdict: audit.verdict,
    pageVisitedAt: null,
    pageVisitCount: 0,
    notes: null,
    videoUrl: null,
    competitor1Url: input.competitor1Url ?? null,
    competitor2Url: input.competitor2Url ?? null,
    competitor1Name: manualCompetitor1?.legalName ?? google.competitors[0]?.name ?? null,
    competitor2Name: manualCompetitor2?.legalName ?? google.competitors[1]?.name ?? null,
  });

  // ── Done ──────────────────────────────────────────────────────────────────
  logger.section('Pipeline complete');
  logger.success(`Slug:  ${slug}`);
  if (pdfPath) {
    logger.success(`PDF:   ${pdfPath}`);
    logger.data('Open PDF', `open "${pdfPath}"`);
  }
  if (deployedUrl) logger.success(`Page:  ${deployedUrl}`);
  if (landingPagePath) logger.data('Open page', `open "${landingPagePath}"`);

  return { ...output, pdfPath, landingPageUrl: deployedUrl };
}
