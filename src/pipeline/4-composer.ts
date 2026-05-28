import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { logger } from '../utils/logger.js';
import { getFontFaceCSS } from '../utils/fonts.js';
import { getCaseStudyForNiche } from '../db/client.js';
import type { PipelineOutput, DossierData, AiAuditResult, FinancialData } from '../types/index.js';

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
  if (score <= 79) return '#C9A227';
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

  // Priority 2: Google Ads gap
  if (!data.targetRunningGoogleAds) {
    if (data.competitor1RunningGoogleAds && data.competitor1Name !== '—') {
      return `Vaša konkurencija (${escapeHtml(data.competitor1Name)}) oglašava se na Google Ads. Vi ne.`;
    }
    if (data.competitor2RunningGoogleAds && data.competitor2Name !== '—') {
      return `Vaša konkurencija (${escapeHtml(data.competitor2Name)}) oglašava se na Google Ads. Vi ne.`;
    }
  }

  // Priority 3: AI invisibility with a named competitor winning
  if (data.topCompetitorInAI && data.visibilityScore < 60) {
    return `AI tražilice preporučuju ${escapeHtml(data.topCompetitorInAI)} vašim potencijalnim pacijentima — ne vas.`;
  }

  // Priority 4: Review count gap
  const maxReviews = Math.max(data.competitor1ReviewCount, data.competitor2ReviewCount);
  if (maxReviews > 0 && data.targetReviewCount > 0 && maxReviews > data.targetReviewCount * 1.3) {
    const topName = data.competitor1ReviewCount >= data.competitor2ReviewCount
      ? data.competitor1Name : data.competitor2Name;
    return `Imate ${data.targetReviewCount} Google recenzija. ${escapeHtml(topName)} ima ${maxReviews.toLocaleString('hr-HR')}.`;
  }

  // Priority 5: Low AI score
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

  // Google Ads: same logic
  const gadsCol = data.targetRunningGoogleAds ? '#52A882'
    : (data.competitor1RunningGoogleAds || data.competitor2RunningGoogleAds) ? '#E05252' : '#9A9590';

  const aiCol = getScoreColor(data.visibilityScore);

  const th = (text: string) =>
    `<th style="font-family:'Cinzel',serif;font-size:7px;font-weight:400;color:rgba(240,237,230,0.55);letter-spacing:0.2em;text-transform:uppercase;padding:7px 10px;text-align:left;border-bottom:1px solid rgba(201,162,39,0.4);background:#141210">${text}</th>`;

  const tdLabel = (text: string) =>
    `<td style="font-family:'Outfit',sans-serif;font-size:8px;color:rgba(240,237,230,0.55);padding:7px 10px;border-bottom:1px solid rgba(201,162,39,0.12)">${text}</td>`;

  const tdVal = (text: string, color: string, bold = false) =>
    `<td style="font-family:'Outfit',sans-serif;font-size:9px;color:${color};font-weight:${bold ? 600 : 400};padding:7px 10px;border-bottom:1px solid rgba(201,162,39,0.12)">${text}</td>`;

  const tdComp = (text: string) =>
    `<td style="font-family:'Outfit',sans-serif;font-size:8px;color:rgba(240,237,230,0.30);padding:7px 10px;border-bottom:1px solid rgba(201,162,39,0.12)">${text}</td>`;

  return `
<table style="width:100%;border-collapse:collapse">
  <thead>
    <tr>
      ${th('')}
      ${th(escapeHtml(data.legalName).slice(0, 26))}
      ${th(escapeHtml(data.competitor1Name).slice(0, 20))}
      ${th(escapeHtml(data.competitor2Name).slice(0, 20))}
    </tr>
  </thead>
  <tbody>
    <tr style="background:#0E0C0A">
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
    <tr style="background:#0E0C0A">
      ${tdLabel('Meta oglašavanje')}
      ${tdVal(yesNo(data.targetRunningAds, data.targetAdCount), adsCol, true)}
      ${tdComp(yesNo(data.competitor1RunningAds))}
      ${tdComp(yesNo(data.competitor2RunningAds))}
    </tr>
    <tr>
      ${tdLabel('Google Ads')}
      ${tdVal(yesNo(data.targetRunningGoogleAds, data.targetGoogleAdCount || undefined), gadsCol, true)}
      ${tdComp(yesNo(data.competitor1RunningGoogleAds))}
      ${tdComp(yesNo(data.competitor2RunningGoogleAds))}
    </tr>
    <tr style="background:#0E0C0A">
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
        `<span style="color:#C9A227;font-weight:600">$&</span>`,
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

// ── Financial helpers ──────────────────────────────────────────────────────────

function formatEur(n: number): string {
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `€${Math.round(n / 1_000).toLocaleString('hr-HR')}K`;
  if (n === 0) return '€0';
  return `€${Math.round(n).toLocaleString('hr-HR')}`;
}

function buildFinancialChart(fin: FinancialData): string {
  if (fin.years.length === 0) {
    return `<div style="text-align:center;padding:20px;color:rgba(240,237,230,0.30);font-family:'Outfit',sans-serif;font-size:9px">Financijski podaci nisu dostupni</div>`;
  }

  // Chart shows years left→right (oldest first)
  const years = [...fin.years].reverse();
  const maxRevenue = Math.max(...years.map((y) => y.revenue), 1);
  const chartH = 110; // px — inner bar area

  const cols = years.map((y) => {
    const barPct = maxRevenue > 0 ? Math.max(4, (y.revenue / maxRevenue) * 100) : 4;
    // Profit dot: position within bar height (0 = bottom of bar, barPct = top)
    const profitPct = maxRevenue > 0
      ? Math.min(barPct, Math.max(0, (Math.abs(y.profit) / maxRevenue) * 100))
      : 0;
    const profitColor = y.profit >= 0 ? '#52A882' : '#E05252';
    const sign = y.profit >= 0 ? '+' : '-';

    return `
<div style="flex:1;display:flex;flex-direction:column;align-items:center">
  <div style="font-family:'Outfit',sans-serif;font-size:6.5px;color:#C9A227;margin-bottom:3px;text-align:center">${formatEur(y.revenue)}</div>
  <div style="width:100%;height:${chartH}px;display:flex;align-items:flex-end;padding:0 6px;position:relative">
    <div style="width:100%;height:${barPct}%;background:rgba(201,162,39,0.35);border-top:2px solid #C9A227;min-height:4px;position:relative">
      <div style="position:absolute;top:0;left:50%;transform:translate(-50%,-50%);width:7px;height:7px;border-radius:50%;background:${profitColor};border:1px solid ${profitColor === '#52A882' ? '#3a8a66' : '#b03a3a'}"></div>
    </div>
  </div>
  <div style="font-family:'Outfit',sans-serif;font-size:7px;color:rgba(240,237,230,0.55);margin-top:4px;text-align:center">
    ${y.year}<br><span style="color:${profitColor}">${sign}${formatEur(Math.abs(y.profit))}</span>
  </div>
</div>`;
  });

  return `
<div style="display:flex;gap:8px;align-items:stretch">
  ${cols.join('')}
</div>
<div style="display:flex;justify-content:center;gap:14px;margin-top:6px">
  <div style="display:flex;align-items:center;gap:4px">
    <div style="width:12px;height:8px;background:rgba(201,162,39,0.35);border-top:2px solid #C9A227"></div>
    <span style="font-family:'Outfit',sans-serif;font-size:6.5px;color:rgba(240,237,230,0.40)">Prihod</span>
  </div>
  <div style="display:flex;align-items:center;gap:4px">
    <div style="width:7px;height:7px;border-radius:50%;background:#52A882"></div>
    <span style="font-family:'Outfit',sans-serif;font-size:6.5px;color:rgba(240,237,230,0.40)">Dobit</span>
  </div>
  <div style="display:flex;align-items:center;gap:4px">
    <div style="width:7px;height:7px;border-radius:50%;background:#E05252"></div>
    <span style="font-family:'Outfit',sans-serif;font-size:6.5px;color:rgba(240,237,230,0.40)">Gubitak</span>
  </div>
</div>`;
}

function buildPage2PainStatement(fin: FinancialData): string {
  const latest = fin.years[0];
  if (!latest || latest.revenue === 0) {
    return 'Financijski podaci za ovu tvrtku nisu javno dostupni.';
  }
  const emp = latest.employees > 0 ? ` s ${latest.employees} zaposlenika` : '';
  return `Vaša firma ostvaruje ${formatEur(latest.revenue)} prihoda godišnje${emp}. Prema industrijskim standardima, to podrazumijeva marketinški budžet od ${formatEur(fin.estimatedMarketingBudget)} godišnje. Trenutno: €0 u digitalnoj akviziciji.`;
}

function trendText(t: FinancialData['profitTrend']): string {
  return { growing: 'Rast', declining: 'Pad', stable: 'Stabilno', loss: 'Gubitak' }[t];
}
function trendArrow(t: FinancialData['profitTrend']): string {
  return { growing: '↑', declining: '↓', stable: '→', loss: '⚠' }[t];
}
function trendColor(t: FinancialData['profitTrend']): string {
  return { growing: '#52A882', declining: '#E05252', stable: '#C9A227', loss: '#E05252' }[t];
}

// ── DossierData assembly ──────────────────────────────────────────────────────

export function assembleDossierData(
  output: PipelineOutput,
  niche: string,
  nicheLabel: string,
  landingPageUrl: string,
  qrCodeBase64: string,
): DossierData {
  const { business, google, meta, audit, slug, financials } = output;

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

    targetRunningGoogleAds: output.googleAds.isRunningAds,
    targetGoogleAdCount: output.googleAds.adCount,
    competitor1RunningGoogleAds: output.googleAds.competitorAds[0]?.isRunningAds ?? false,
    competitor2RunningGoogleAds: output.googleAds.competitorAds[1]?.isRunningAds ?? false,

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

    financials,
    page2PainStatement: buildPage2PainStatement(financials),
    estimatedMonthlyLoss: Math.round((financials.estimatedMarketingBudget / 12) * 3),

    qrCodeBase64,
  };
}

// ── Full document HTML builder ────────────────────────────────────────────────

function buildDocumentHtml(pages: string[], tokens: Record<string, string>): string {
  const css = `
${getFontFaceCSS()}

*{margin:0;padding:0;box-sizing:border-box}
@page{size:216mm 303mm;margin:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#0C0B09}
body{background:#0C0B09;color:rgba(240,237,230,0.95)}

.page{
  width:216mm;height:303mm;
  padding:10mm 13mm 11mm 13mm;
  background:#0C0B09;
  page-break-after:always;
  position:relative;overflow:hidden;
  display:flex;flex-direction:column
}
.page:last-child{page-break-after:avoid}

.page-header{
  display:flex;justify-content:space-between;align-items:center;
  padding-bottom:6px;
  border-bottom:1px solid rgba(201,162,39,0.4);
  margin-bottom:16px;flex-shrink:0
}
.page-header-agency{
  font-family:'Cinzel',serif;font-size:9px;font-weight:400;
  color:#C9A227;letter-spacing:0.3em;text-transform:uppercase
}
.page-header-client{
  font-family:'Cinzel',serif;font-size:9px;font-weight:400;
  color:rgba(240,237,230,0.55);letter-spacing:0.12em;text-transform:uppercase
}

.section-label{
  display:flex;align-items:center;gap:10px;
  margin-bottom:12px;flex-shrink:0
}
.section-label-line{
  flex:1;height:1px;
  background:linear-gradient(to right,transparent,rgba(201,162,39,0.55),transparent)
}
.section-label-text{
  font-family:'Cinzel',serif;font-size:10px;font-weight:400;
  color:#C9A227;letter-spacing:0.3em;text-transform:uppercase;white-space:nowrap
}

.gold-line{
  height:1px;
  background:linear-gradient(to right,transparent,#C9A227,transparent);
  margin:11px 0;flex-shrink:0
}

.page-hero{
  font-family:'Fraunces',Georgia,serif;
  font-size:36pt;font-weight:500;font-style:italic;
  color:rgba(240,237,230,0.95);
  line-height:1.05;margin-bottom:4px;flex-shrink:0
}
.page-hero-sm{
  font-family:'Fraunces',Georgia,serif;
  font-size:26pt;font-weight:500;font-style:italic;
  color:rgba(240,237,230,0.95);
  line-height:1.1;margin-bottom:4px;flex-shrink:0
}

.page-prepared{
  font-family:'Outfit',sans-serif;font-size:11px;
  color:rgba(240,237,230,0.55);margin-bottom:14px;flex-shrink:0
}

.card{
  background:#141210;
  border:1px solid rgba(201,162,39,0.4);
  padding:13px 15px;flex-shrink:0
}
.card-accent{border-left:2px solid #C9A227}

.label{
  font-family:'Cinzel',serif;font-size:8px;font-weight:400;
  color:#C9A227;letter-spacing:0.25em;text-transform:uppercase;margin-bottom:7px
}

.gauge-track{
  height:6px;background:#1A1815;
  position:relative;border:1px solid rgba(201,162,39,0.2)
}
.gauge-fill{height:100%;position:absolute;left:0;top:0}

.pain-statement{
  font-family:'CormorantGaramond',Georgia,serif;
  font-size:11pt;font-weight:500;font-style:italic;
  color:rgba(240,237,230,0.95);
  margin-top:14px;padding:12px 16px;
  background:#141210;
  border-left:2px solid #E05252;
  flex-shrink:0
}

.phone-frame{
  width:170px;height:315px;
  background:#161410;
  border:1px solid rgba(201,162,39,0.4);
  padding:11px 9px;flex-shrink:0
}
.phone-notch{
  width:44px;height:4px;background:#242118;
  margin:0 auto 8px
}
.phone-screen{
  background:#0E0D0B;padding:10px;
  height:calc(100% - 20px);overflow:hidden
}

.funnel{display:flex;align-items:stretch;flex:1;min-height:0;margin-top:8px}
.funnel-step{
  flex:1;background:#141210;
  border:1px solid rgba(201,162,39,0.4);
  border-top:1px solid #C9A227;
  padding:12px 9px 10px;
  display:flex;flex-direction:column;min-width:0
}
.funnel-arrow{
  display:flex;align-items:center;padding:0 4px;
  color:rgba(201,162,39,0.45);font-size:16pt;flex-shrink:0;line-height:1
}
.funnel-step-number{
  font-family:'Cinzel',serif;font-size:7px;font-weight:400;
  color:#C9A227;letter-spacing:0.2em;margin-bottom:5px
}
.funnel-step-title{
  font-family:'CormorantGaramond',Georgia,serif;
  font-size:11.5pt;font-weight:500;
  color:rgba(240,237,230,0.95);line-height:1.2;margin-bottom:7px
}
.funnel-step-body{
  font-family:'Outfit',sans-serif;font-size:7px;
  color:rgba(240,237,230,0.55);line-height:1.5;flex:1;overflow:hidden
}

.page-num{
  position:absolute;bottom:7mm;left:0;right:0;
  text-align:center;
  font-family:'Outfit',sans-serif;font-size:9px;
  color:rgba(240,237,230,0.30)
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

  const pages = [
    'page1.html',
    'page2-financial.html',
    'page2.html',
    'page3.html',
    'page4.html',
    'page5.html',
  ].map((name) => readFileSync(resolve(TEMPLATES_DIR, name), 'utf-8'));

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

    // Page 2 — financial intelligence
    financialChartHtml:    buildFinancialChart(data.financials),
    page2PainStatement:    escapeHtml(data.page2PainStatement),
    fin_latestYear:        String(data.financials.years[0]?.year ?? '—'),
    fin_oldestYear:        String(data.financials.years[data.financials.years.length - 1]?.year ?? '—'),
    fin_latestRevenue:     data.financials.years[0]?.revenue ? formatEur(data.financials.years[0].revenue) : '—',
    fin_revenueGrowth:     `${data.financials.revenueGrowth >= 0 ? '+' : ''}${data.financials.revenueGrowth.toFixed(1)}%`,
    fin_revenueGrowthColor: data.financials.revenueGrowth >= 0 ? '#52A882' : '#E05252',
    fin_revenueGrowthArrow: data.financials.revenueGrowth >= 0 ? '↑' : '↓',
    fin_latestProfit:      data.financials.years[0]?.profit !== undefined ? formatEur(Math.abs(data.financials.years[0].profit)) : '—',
    fin_profitSign:        (data.financials.years[0]?.profit ?? 0) < 0 ? '- ' : '',
    fin_profitColor:       (data.financials.years[0]?.profit ?? 0) >= 0 ? '#52A882' : '#E05252',
    fin_trendText:         trendText(data.financials.profitTrend),
    fin_trendArrow:        trendArrow(data.financials.profitTrend),
    fin_trendColor:        trendColor(data.financials.profitTrend),
    fin_employees:         data.financials.employeeCount > 0 ? String(data.financials.employeeCount) : 'N/A',
    fin_avgSalary:         data.financials.years[0]?.avgBruttoSalary ? formatEur(data.financials.years[0].avgBruttoSalary) : 'N/A',
    fin_marketingBudget:   data.financials.estimatedMarketingBudget > 0 ? formatEur(data.financials.estimatedMarketingBudget) : '—',
    fin_monthlyLoss:       data.estimatedMonthlyLoss > 0 ? formatEur(data.estimatedMonthlyLoss) : '—',
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
