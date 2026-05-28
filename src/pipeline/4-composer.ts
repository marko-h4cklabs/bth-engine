import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { logger } from '../utils/logger.js';
import { getFontFaceCSS } from '../utils/fonts.js';
import { getCaseStudyForNiche } from '../db/client.js';
import type { PipelineOutput, DossierData, AiAuditResult } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = resolve(__dirname, '../templates/dossier');

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyTokens(html: string, tokens: Record<string, string>): string {
  let result = html;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

function getScoreColor(score: number): string {
  if (score <= 39) return '#E05252';
  if (score <= 79) return '#C9A84C';
  return '#52A882';
}

// ── Pain statement logic ──────────────────────────────────────────────────────

function buildPainStatement(data: DossierData): string {
  // Priority 1: Meta ads gap (most relatable business pain)
  if (!data.targetRunningAds) {
    if (data.competitor1RunningAds && data.competitor1Name !== '—') {
      return `Vaša konkurencija (${escapeHtml(data.competitor1Name)}) aktivno ulaže u Meta oglašavanje. Vi ne.`;
    }
    if (data.competitor2RunningAds && data.competitor2Name !== '—') {
      return `Vaša konkurencija (${escapeHtml(data.competitor2Name)}) aktivno ulaže u Meta oglašavanje. Vi ne.`;
    }
  }

  // Priority 2: AI invisibility with a named competitor winning
  if (data.topCompetitorInAI && data.visibilityScore < 60) {
    return `AI tražilice preporučuju ${escapeHtml(data.topCompetitorInAI)} vašim potencijalnim pacijentima — ne vas.`;
  }

  // Priority 3: Review count gap
  const maxReviews = Math.max(data.competitor1ReviewCount, data.competitor2ReviewCount);
  if (maxReviews > 0 && data.targetReviewCount > 0 && maxReviews > data.targetReviewCount * 1.3) {
    const topName = data.competitor1ReviewCount >= data.competitor2ReviewCount
      ? data.competitor1Name : data.competitor2Name;
    return `Imate ${data.targetReviewCount} Google recenzija. ${escapeHtml(topName)} ima ${maxReviews.toLocaleString('hr-HR')}.`;
  }

  // Priority 4: Low AI score
  if (data.visibilityScore < 40) {
    return `Vaš AI Visibility Score je ${data.visibilityScore}/100 — svaki drugi pacijent koji pita ChatGPT ne pronalazi vas.`;
  }

  // Default — still useful for a dominant player
  return `U segmentu ${escapeHtml(data.nicheLabel)} u ${escapeHtml(data.city)}u, AI vidljivost je nova SEO. Budite ispred.`;
}

// ── Comparison table ──────────────────────────────────────────────────────────

function buildComparisonTable(data: DossierData): string {
  const fmtRating = (n: number) => n > 0 ? `${n.toFixed(1)}★` : '—';
  const fmtCount  = (n: number) => n > 0 ? n.toLocaleString('hr-HR') : '—';
  const yesNo     = (v: boolean, count?: number) =>
    v ? (count !== undefined ? `Da&nbsp;(${count} aktivnih)` : 'Da') : 'Ne';

  const tR = data.targetRating;
  const c1R = data.competitor1Rating;
  const c2R = data.competitor2Rating;
  const tC = data.targetReviewCount;
  const c1C = data.competitor1ReviewCount;
  const c2C = data.competitor2ReviewCount;

  // Rating: green if target ≥ both competitors, red if loses to at least one
  const ratingCol = (tR === 0) ? '#9A9590'
    : (c1R > tR || c2R > tR) ? '#E05252' : '#52A882';

  // Reviews: same logic
  const reviewCol = (tC === 0) ? '#9A9590'
    : (c1C > tC || c2C > tC) ? '#E05252' : '#52A882';

  // Meta ads: green if running, red if not running but at least one competitor is
  const adsCol = data.targetRunningAds ? '#52A882'
    : (data.competitor1RunningAds || data.competitor2RunningAds) ? '#E05252' : '#9A9590';

  const aiCol = getScoreColor(data.visibilityScore);

  const th = (text: string) =>
    `<th style="font-family:'Inter',sans-serif;font-size:7.5pt;font-weight:600;color:#9A9590;letter-spacing:0.05em;text-transform:uppercase;padding:8px 10px;text-align:left;border-bottom:1px solid rgba(201,168,76,0.2);background:#141414">${text}</th>`;

  const tdLabel = (text: string) =>
    `<td style="font-family:'Inter',sans-serif;font-size:8.5pt;color:#9A9590;padding:8px 10px;border-bottom:1px solid rgba(201,168,76,0.08)">${text}</td>`;

  const tdVal = (text: string, color: string, bold = false) =>
    `<td style="font-family:'Inter',sans-serif;font-size:9pt;color:${color};font-weight:${bold ? 600 : 400};padding:8px 10px;border-bottom:1px solid rgba(201,168,76,0.08)">${text}</td>`;

  const tdComp = (text: string) =>
    `<td style="font-family:'Inter',sans-serif;font-size:8.5pt;color:#9A9590;padding:8px 10px;border-bottom:1px solid rgba(201,168,76,0.08)">${text}</td>`;

  return `
<table style="width:100%;border-collapse:collapse;margin-bottom:0">
  <thead>
    <tr>
      ${th('')}
      ${th(escapeHtml(data.legalName).slice(0, 28))}
      ${th(escapeHtml(data.competitor1Name).slice(0, 22))}
      ${th(escapeHtml(data.competitor2Name).slice(0, 22))}
    </tr>
  </thead>
  <tbody>
    <tr style="background:#0D0D0D">
      ${tdLabel('Google ocjena')}
      ${tdVal(fmtRating(tR), ratingCol, true)}
      ${tdComp(fmtRating(c1R))}
      ${tdComp(fmtRating(c2R))}
    </tr>
    <tr>
      ${tdLabel('Broj recenzija')}
      ${tdVal(fmtCount(tC), reviewCol, true)}
      ${tdComp(fmtCount(c1C))}
      ${tdComp(fmtCount(c2C))}
    </tr>
    <tr style="background:#0D0D0D">
      ${tdLabel('Meta oglašavanje')}
      ${tdVal(yesNo(data.targetRunningAds, data.targetAdCount), adsCol, true)}
      ${tdComp(yesNo(data.competitor1RunningAds))}
      ${tdComp(yesNo(data.competitor2RunningAds))}
    </tr>
    <tr>
      ${tdLabel('AI vidljivost')}
      ${tdVal(`${data.visibilityScore}/100`, aiCol, true)}
      ${tdComp('—')}
      ${tdComp('—')}
    </tr>
  </tbody>
</table>`.trim();
}

// ── AI response with highlighted competitor ───────────────────────────────────

function buildAiResponseHtml(data: DossierData): string {
  let html = escapeHtml(data.bestAiResponseText);

  if (data.topCompetitorInAI) {
    // Highlight each significant word of the competitor name
    const words = data.topCompetitorInAI
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .slice(0, 2);

    for (const word of words) {
      const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(
        new RegExp(safe, 'gi'),
        `<span style="color:#C9A84C;font-weight:600">$&</span>`,
      );
    }
  }

  return html;
}

// ── Best AI query selection ───────────────────────────────────────────────────

function selectBestQuery(audit: AiAuditResult): { query: string; response: string } {
  // Pick the query where competitor is mentioned and target is NOT mentioned
  const worstCase = audit.queries
    .filter((q) => !q.targetMentioned && q.competitorsMentioned.length > 0)
    .sort((a, b) => b.competitorsMentioned.length - a.competitorsMentioned.length);

  if (worstCase.length > 0 && worstCase[0]) {
    return { query: worstCase[0].query, response: worstCase[0].response };
  }

  // DOMINANT case — pick longest response (most data to display)
  const sorted = [...audit.queries]
    .filter((q) => q.response.length > 0)
    .sort((a, b) => b.response.length - a.response.length);

  const best = sorted[0] ?? audit.queries[0];
  if (!best) throw new Error('No audit queries available');
  return { query: best.query, response: best.response };
}

// ── DossierData assembly ──────────────────────────────────────────────────────

export function assembleDossierData(
  output: PipelineOutput,
  niche: string,
  nicheLabel: string,
  landingPageUrl: string,
  qrCodeBase64: string,
): DossierData {
  const { business, google, meta, audit, slug } = output;

  const comp1 = google.competitors[0];
  const comp2 = google.competitors[1];
  const caseStudy = getCaseStudyForNiche(niche);
  const bestQuery = selectBestQuery(audit);

  return {
    slug,
    legalName: business.legalName,
    directorFullName: business.directorFullName !== 'MANUAL_FILL'
      ? business.directorFullName : '',
    directorFirstName: business.directorFirstName,
    directorLastName: business.directorLastName,
    niche,
    nicheLabel,
    city: business.city,

    targetRating: google.rating,
    targetReviewCount: google.reviewCount,
    competitor1Name: comp1?.name ?? '—',
    competitor1Rating: comp1?.rating ?? 0,
    competitor1ReviewCount: comp1?.reviewCount ?? 0,
    competitor2Name: comp2?.name ?? '—',
    competitor2Rating: comp2?.rating ?? 0,
    competitor2ReviewCount: comp2?.reviewCount ?? 0,

    targetRunningAds: meta.isRunningAds,
    targetAdCount: meta.activeAdCount,
    competitor1RunningAds: meta.competitorAds[0]?.isRunningAds ?? false,
    competitor2RunningAds: meta.competitorAds[1]?.isRunningAds ?? false,

    visibilityScore: audit.visibilityScore,
    verdict: audit.verdict,
    topCompetitorInAI: audit.topCompetitorInAI,
    bestAiQueryText: bestQuery.query,
    bestAiResponseText: bestQuery.response,

    landingPageUrl,
    caseStudyNiche: caseStudy?.niche
      ? caseStudy.niche.charAt(0).toUpperCase() + caseStudy.niche.slice(1).replace(/-/g, ' ')
      : nicheLabel,
    caseStudyResult: caseStudy?.resultMetric
      ?? '[Case study u pripremi — kontaktirajte nas za referencu]',

    qrCodeBase64,
  };
}

// ── Full document HTML builder ────────────────────────────────────────────────

function buildDocumentHtml(pages: string[], tokens: Record<string, string>): string {
  const css = `
${getFontFaceCSS()}

*{margin:0;padding:0;box-sizing:border-box}

@page{size:216mm 303mm;margin:0}

html{
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
  background:#0A0A0A
}

body{background:#0A0A0A;color:#F0EDE8}

.page{
  width:216mm;
  height:303mm;
  padding:12mm 14mm 12mm 14mm;
  background:#0A0A0A;
  page-break-after:always;
  position:relative;
  overflow:hidden;
  display:flex;
  flex-direction:column
}

.page:last-child{page-break-after:avoid}

.page-header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  padding-bottom:8px;
  border-bottom:1px solid rgba(201,168,76,0.3);
  margin-bottom:20px;
  flex-shrink:0
}

.page-header-agency{
  font-family:'Inter',-apple-system,sans-serif;
  font-size:8pt;
  font-weight:600;
  color:#C9A84C;
  letter-spacing:0.12em;
  text-transform:uppercase
}

.page-header-client{
  font-family:'Inter',-apple-system,sans-serif;
  font-size:8pt;
  font-weight:400;
  color:#9A9590;
  letter-spacing:0.06em;
  text-transform:uppercase
}

.page-title{
  font-family:'CormorantGaramond',Georgia,serif;
  font-size:32pt;
  font-weight:600;
  color:#C9A84C;
  line-height:1.1;
  margin-bottom:6px;
  flex-shrink:0
}

.page-subtitle{
  font-family:'Inter',-apple-system,sans-serif;
  font-size:10pt;
  font-weight:400;
  color:#9A9590;
  margin-bottom:22px;
  flex-shrink:0
}

.card{
  background:#141414;
  border:1px solid rgba(201,168,76,0.15);
  padding:16px 18px;
  flex-shrink:0
}

.card-gold-left{border-left:3px solid #C9A84C}

.label{
  font-family:'Inter',-apple-system,sans-serif;
  font-size:7.5pt;
  font-weight:600;
  color:#C9A84C;
  letter-spacing:0.14em;
  text-transform:uppercase;
  margin-bottom:8px
}

.gauge-track{
  height:8px;
  background:#1C1C1C;
  position:relative;
  border:1px solid rgba(201,168,76,0.1)
}

.gauge-fill{height:100%;position:absolute;left:0;top:0}

.pain-statement{
  font-family:'Inter',-apple-system,sans-serif;
  font-size:10.5pt;
  font-weight:600;
  color:#F0EDE8;
  margin-top:18px;
  padding:14px 18px;
  background:#141414;
  border-left:3px solid #E05252;
  flex-shrink:0
}

.phone-frame{
  width:178px;
  height:338px;
  background:#1A1A1A;
  border:2px solid rgba(201,168,76,0.22);
  border-radius:24px;
  padding:14px 10px;
  flex-shrink:0
}

.phone-notch{
  width:50px;
  height:5px;
  background:#2A2A2A;
  border-radius:3px;
  margin:0 auto 10px
}

.phone-screen{
  background:#111111;
  padding:12px;
  height:calc(100% - 24px);
  overflow:hidden
}

.funnel{
  display:flex;
  align-items:stretch;
  flex:1;
  min-height:0;
  margin-top:8px
}

.funnel-step{
  flex:1;
  background:#141414;
  border:1px solid rgba(201,168,76,0.12);
  border-top:2px solid #C9A84C;
  padding:14px 10px 12px;
  display:flex;
  flex-direction:column;
  min-width:0
}

.funnel-arrow{
  display:flex;
  align-items:center;
  padding:0 5px;
  color:#8A6F2E;
  font-size:18pt;
  flex-shrink:0;
  line-height:1
}

.funnel-step-number{
  font-family:'Inter',sans-serif;
  font-size:7pt;
  color:#C9A84C;
  font-weight:600;
  letter-spacing:0.1em;
  margin-bottom:6px
}

.funnel-step-title{
  font-family:'CormorantGaramond',Georgia,serif;
  font-size:12pt;
  font-weight:600;
  color:#F0EDE8;
  line-height:1.2;
  margin-bottom:8px
}

.funnel-step-body{
  font-family:'Inter',sans-serif;
  font-size:7.5pt;
  color:#9A9590;
  line-height:1.45;
  flex:1;
  overflow:hidden
}
`;

  const pageHtml = pages.map((p) => applyTokens(p, tokens)).join('\n');

  return `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<style>${css}</style>
</head>
<body>
${pageHtml}
</body>
</html>`;
}

// ── PDF composition ───────────────────────────────────────────────────────────

export async function composePdf(
  data: DossierData,
  agencyName: string,
  agencyDomain: string,
): Promise<string> {
  logger.info('  Reading page templates...');

  const pages = [1, 2, 3, 4, 5].map((n) => {
    const path = resolve(TEMPLATES_DIR, `page${n}.html`);
    return readFileSync(path, 'utf-8');
  });

  const tokens: Record<string, string> = {
    // Identity
    slug:             data.slug,
    legalName:        escapeHtml(data.legalName),
    directorFullName: escapeHtml(data.directorFullName || 'Direktorice / Direktore'),
    directorFirstName: escapeHtml(data.directorFirstName),
    directorLastName:  escapeHtml(data.directorLastName || 'direktoru'),
    niche:            data.niche,
    nicheLabel:       escapeHtml(data.nicheLabel),
    city:             escapeHtml(data.city),
    agencyName:       escapeHtml(agencyName),
    agencyDomain:     escapeHtml(agencyDomain),

    // Computed HTML blocks
    comparisonTableHtml: buildComparisonTable(data),
    page1PainStatement:  buildPainStatement(data),
    bestAiResponseHtml:  buildAiResponseHtml(data),
    bestAiQueryText:     escapeHtml(data.bestAiQueryText),

    // Scores
    visibilityScore:      String(data.visibilityScore),
    visibilityScoreColor: getScoreColor(data.visibilityScore),
    verdict:              data.verdict,
    topCompetitorInAI:    escapeHtml(data.topCompetitorInAI),

    // Case study
    caseStudyNiche:  escapeHtml(data.caseStudyNiche),
    caseStudyResult: escapeHtml(data.caseStudyResult),

    // QR
    qrCodeBase64: data.qrCodeBase64,
  };

  const html = buildDocumentHtml(pages, tokens);

  // Write to temp file — Puppeteer needs a file:// URL to load local resources
  const tmpPath = resolve(tmpdir(), `bth-dossier-${data.slug}-${Date.now()}.html`);
  writeFileSync(tmpPath, html, 'utf-8');
  logger.info(`  Temp HTML written → ${tmpPath}`);

  const outDir = resolve(process.cwd(), 'output/pdfs');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const pdfPath = resolve(outDir, `${data.slug}.pdf`);

  logger.info('  Launching Puppeteer...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });

  try {
    const page = await browser.newPage();

    const fileUrl = pathToFileURL(tmpPath).href;
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // Give fonts time to render
    await new Promise<void>((r) => setTimeout(r, 1500));

    const pdf = await page.pdf({
      width: '216mm',
      height: '303mm',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    writeFileSync(pdfPath, pdf);
    logger.success(`  PDF saved: ${pdfPath}`);
  } finally {
    await browser.close();
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
  }

  return pdfPath;
}
