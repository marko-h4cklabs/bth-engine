import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import { getConfigSafe } from '../utils/config.js';
import { getNiche } from '../db/client.js';
import type { DossierData, ManualCompetitorData } from '../types/index.js';

// ── Brand colors ──────────────────────────────────────────────────────────────

const GOLD     = '#C9A227';
const OBSIDIAN = '#0C0B09';

// ── HTML escape ───────────────────────────────────────────────────────────────

function esc(s: string | number | null | undefined): string {
  const str = String(s ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score <= 39) return '#E05252';
  if (score <= 79) return GOLD;
  return '#52A882';
}

function verdictColor(v: string): string {
  if (v === 'INVISIBLE') return '#E05252';
  if (v === 'WEAK')      return GOLD;
  if (v === 'PRESENT')   return '#52A882';
  if (v === 'DOMINANT')  return '#52A882';
  return GOLD;
}

function fmtEur(n: number): string {
  if (n <= 0) return '—';
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `€${Math.round(n / 1_000).toLocaleString('hr-HR')}K`;
  return `€${Math.round(n).toLocaleString('hr-HR')}`;
}

function fmtRating(n: number): string {
  return n > 0 ? `${n.toFixed(1)}★` : '—';
}

function fmtCount(n: number): string {
  return n > 0 ? n.toLocaleString('hr-HR') : '—';
}

// Croatian locative for city names used in the page text
const LOCATIVE_OVERRIDES: Record<string, string> = {
  zagreb: 'Zagrebu', split: 'Splitu', rijeka: 'Rijeci',
  osijek: 'Osijeku', zadar: 'Zadru', pula: 'Puli',
  šibenik: 'Šibeniku', varaždin: 'Varaždinu', karlovac: 'Karlovcu',
  sisak: 'Sisku', koprivnica: 'Koprivnici', bjelovar: 'Bjelovaru',
  dubrovnik: 'Dubrovniku', čakovec: 'Čakovcu',
  đakovo: 'Đakovu', vukovar: 'Vukovaru', vinkovci: 'Vinkovcima',
  'slavonski brod': 'Slavonskom Brodu',
};

function toCroatianLocative(city: string): string {
  const key = city.toLowerCase();
  if (LOCATIVE_OVERRIDES[key]) return LOCATIVE_OVERRIDES[key]!;
  const lower = city.toLowerCase();
  if (lower.endsWith('ec')) return city.slice(0, -2) + 'cu';
  if (lower.endsWith('a'))  return city.slice(0, -1) + 'i';
  return city + 'u';
}

// ── Competitor view helper ────────────────────────────────────────────────────

interface CompetitorView {
  name: string;
  rating: number;
  reviewCount: number;
  metaRunning: boolean;
  metaCount: number;
  googleRunning: boolean;
  googleCount: number;
  aiScore: number;
  aiVerdict: string;
}

function toCompView(data: DossierData, slot: 1 | 2): CompetitorView {
  if (slot === 1) {
    return {
      name:          data.competitor1Name,
      rating:        data.competitor1Rating,
      reviewCount:   data.competitor1ReviewCount,
      metaRunning:   data.competitor1RunningAds,
      metaCount:     data.competitor1MetaAdCount,
      googleRunning: data.competitor1RunningGoogleAds,
      googleCount:   data.competitor1GoogleAdCount,
      aiScore:       data.competitor1AiScore,
      aiVerdict:     data.competitor1AiVerdict,
    };
  }
  return {
    name:          data.competitor2Name,
    rating:        data.competitor2Rating,
    reviewCount:   data.competitor2ReviewCount,
    metaRunning:   data.competitor2RunningAds,
    metaCount:     data.competitor2MetaAdCount,
    googleRunning: data.competitor2RunningGoogleAds,
    googleCount:   data.competitor2GoogleAdCount,
    aiScore:       data.competitor2AiScore,
    aiVerdict:     data.competitor2AiVerdict,
  };
}

// ── Section builders ──────────────────────────────────────────────────────────

function buildComparisonTable(data: DossierData, c1: CompetitorView, c2: CompetitorView): string {
  const tR = data.targetRating;
  const tC = data.targetReviewCount;

  // Win/lose helpers
  const win  = (bg: string, text: string) =>
    `style="background:rgba(82,168,130,0.08);color:#52A882;font-weight:600;padding:11px 14px;border-bottom:1px solid rgba(201,162,39,0.1)">${esc(text)}`;
  const lose = (bg: string, text: string) =>
    `style="background:rgba(224,82,82,0.08);color:#E05252;font-weight:600;padding:11px 14px;border-bottom:1px solid rgba(201,162,39,0.1)">${esc(text)}`;
  const neutral = (text: string) =>
    `style="color:rgba(240,237,230,0.55);font-weight:500;padding:11px 14px;border-bottom:1px solid rgba(201,162,39,0.1)">${esc(text)}`;
  const compCell = (text: string) =>
    `style="color:rgba(240,237,230,0.40);padding:11px 14px;border-bottom:1px solid rgba(201,162,39,0.06)">${esc(text)}`;

  function ratingCell(): string {
    const val = fmtRating(tR);
    const beats = (tR > 0 && c1.rating > tR) || (tR > 0 && c2.rating > tR);
    return beats ? `<td ${lose('', val)}</td>` : `<td ${win('', val)}</td>`;
  }
  function reviewCell(): string {
    const val = fmtCount(tC);
    const beats = (tC > 0 && c1.reviewCount > tC) || (tC > 0 && c2.reviewCount > tC);
    return beats ? `<td ${lose('', val)}</td>` : `<td ${win('', val)}</td>`;
  }
  function metaCell(): string {
    const val = data.targetRunningAds ? `✓ ${data.targetAdCount} oglasa` : '✗ Nije aktivan';
    if (data.targetRunningAds) return `<td ${win('', val)}</td>`;
    if (c1.metaRunning || c2.metaRunning) return `<td ${lose('', val)}</td>`;
    return `<td ${neutral(val)}</td>`;
  }
  function gadCell(): string {
    const val = data.targetRunningGoogleAds ? `✓ ${data.targetGoogleAdCount} oglasa` : '✗ Nije aktivan';
    if (data.targetRunningGoogleAds) return `<td ${win('', val)}</td>`;
    if (c1.googleRunning || c2.googleRunning) return `<td ${lose('', val)}</td>`;
    return `<td ${neutral(val)}</td>`;
  }
  function aiCell(): string {
    const s = data.visibilityScore;
    const col = scoreColor(s);
    return `<td style="padding:11px 14px;border-bottom:1px solid rgba(201,162,39,0.1)"><span style="color:${col};font-weight:700">${s}/100</span> <span style="font-size:11px;color:${col}">${esc(data.verdict)}</span></td>`;
  }
  function compAiCell(cv: CompetitorView): string {
    const col = scoreColor(cv.aiScore);
    return `<td style="padding:11px 14px;border-bottom:1px solid rgba(201,162,39,0.06)"><span style="color:${col};font-size:12px">${cv.aiScore}/100</span></td>`;
  }

  const th = (txt: string, isTarget = false) =>
    `<th style="padding:11px 14px;text-align:left;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;font-weight:400;color:rgba(240,237,230,0.45);font-family:Georgia,serif;border-bottom:2px solid ${isTarget ? GOLD : 'rgba(201,162,39,0.2)'}${isTarget ? ';color:' + GOLD : ''}">${esc(txt)}</th>`;

  const tdLabel = (txt: string) =>
    `<td style="padding:11px 14px;font-size:12px;color:rgba(240,237,230,0.45);border-bottom:1px solid rgba(201,162,39,0.1);white-space:nowrap">${esc(txt)}</td>`;

  const finRev  = data.financials.years[0]?.revenue ?? 0;
  const finEmp  = data.financials.years[0]?.employees ?? 0;

  return `
<table style="width:100%;border-collapse:collapse;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <thead>
    <tr>
      ${th('')}
      ${th(data.legalName.slice(0, 26), true)}
      ${th(c1.name !== '—' ? c1.name.slice(0, 22) : 'Konkurent 1')}
      ${th(c2.name !== '—' ? c2.name.slice(0, 22) : 'Konkurent 2')}
    </tr>
  </thead>
  <tbody>
    <tr style="background:#0E0C0A">
      ${tdLabel('Google ocjena')}
      ${ratingCell()}
      <td ${compCell(fmtRating(c1.rating))}</td>
      <td ${compCell(fmtRating(c2.rating))}</td>
    </tr>
    <tr>
      ${tdLabel('Broj recenzija')}
      ${reviewCell()}
      <td ${compCell(fmtCount(c1.reviewCount))}</td>
      <td ${compCell(fmtCount(c2.reviewCount))}</td>
    </tr>
    <tr style="background:#0E0C0A">
      ${tdLabel('Meta Ads')}
      ${metaCell()}
      <td ${compCell(c1.metaRunning ? `✓ ${c1.metaCount} oglasa` : '✗ Nije aktivan')}</td>
      <td ${compCell(c2.metaRunning ? `✓ ${c2.metaCount} oglasa` : '✗ Nije aktivan')}</td>
    </tr>
    <tr>
      ${tdLabel('Google Ads')}
      ${gadCell()}
      <td ${compCell(c1.googleRunning ? `✓ ${c1.googleCount} oglasa` : '✗ Nije aktivan')}</td>
      <td ${compCell(c2.googleRunning ? `✓ ${c2.googleCount} oglasa` : '✗ Nije aktivan')}</td>
    </tr>
    <tr style="background:#0E0C0A">
      ${tdLabel('AI Vidljivost')}
      ${aiCell()}
      ${compAiCell(c1)}
      ${compAiCell(c2)}
    </tr>
    ${finRev > 0 ? `
    <tr>
      ${tdLabel('Prihodi')}
      <td style="padding:11px 14px;border-bottom:1px solid rgba(201,162,39,0.1);color:${GOLD};font-weight:600">${esc(fmtEur(finRev))}</td>
      <td ${compCell('—')}</td>
      <td ${compCell('—')}</td>
    </tr>` : ''}
    ${finEmp > 0 ? `
    <tr style="background:#0E0C0A">
      ${tdLabel('Zaposleni')}
      <td style="padding:11px 14px;border-bottom:1px solid rgba(201,162,39,0.1);color:rgba(240,237,230,0.75);font-weight:500">${esc(String(finEmp))}</td>
      <td ${compCell('—')}</td>
      <td ${compCell('—')}</td>
    </tr>` : ''}
  </tbody>
</table>`.trim();
}

function buildAdsSection(data: DossierData, c1: CompetitorView, c2: CompetitorView): string {
  const allGoogleInactive = !data.targetRunningGoogleAds && !c1.googleRunning && !c2.googleRunning;

  function adCard(title: string, icon: string, entities: Array<{ name: string; running: boolean; count: number }>): string {
    const rows = entities.map(e => {
      const col = e.running ? '#52A882' : 'rgba(240,237,230,0.35)';
      const status = e.running ? `<span style="color:#52A882">✓ ${e.count} aktivnih oglasa</span>` : `<span style="color:rgba(240,237,230,0.35)">✗ Nije aktivan</span>`;
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(201,162,39,0.08)">
        <span style="font-size:13px;color:rgba(240,237,230,0.75)">${esc(e.name.slice(0, 28))}</span>
        <span style="font-size:12px">${status}</span>
      </div>`;
    }).join('');

    return `<div style="flex:1;background:#141210;border:1px solid rgba(201,162,39,0.3);padding:20px">
      <div style="font-size:10px;color:${GOLD};letter-spacing:0.25em;text-transform:uppercase;font-family:Georgia,serif;margin-bottom:14px">${icon} ${esc(title)}</div>
      ${rows}
    </div>`;
  }

  const metaCard = adCard('Meta Ads', '◈', [
    { name: data.legalName, running: data.targetRunningAds, count: data.targetAdCount },
    { name: c1.name !== '—' ? c1.name : 'Konkurent 1', running: c1.metaRunning, count: c1.metaCount },
    { name: c2.name !== '—' ? c2.name : 'Konkurent 2', running: c2.metaRunning, count: c2.metaCount },
  ]);

  const gadCard = adCard('Google Ads', '◇', [
    { name: data.legalName, running: data.targetRunningGoogleAds, count: data.targetGoogleAdCount },
    { name: c1.name !== '—' ? c1.name : 'Konkurent 1', running: c1.googleRunning, count: c1.googleCount },
    { name: c2.name !== '—' ? c2.name : 'Konkurent 2', running: c2.googleRunning, count: c2.googleCount },
  ]);

  const unusedNote = allGoogleInactive
    ? `<div style="margin-top:18px;padding:14px 18px;background:rgba(201,162,39,0.06);border-left:2px solid ${GOLD}">
        <p style="font-size:13px;color:rgba(240,237,230,0.75);font-style:italic">Nijedan konkurent ne koristi Google Ads u ovoj niši — ovo je neiskorištena priložnost za vas.</p>
      </div>`
    : '';

  return `<div style="display:flex;gap:16px">${metaCard}${gadCard}</div>${unusedNote}`;
}

function buildFinancialsSection(data: DossierData): string {
  const fin = data.financials;
  const latest = fin.years[0];
  if (!latest || latest.revenue <= 0) return '';

  const trendColor = fin.profitTrend === 'growing' ? '#52A882'
    : fin.profitTrend === 'declining' ? '#E05252'
    : fin.profitTrend === 'loss' ? '#E05252'
    : GOLD;
  const trendLabel = { growing: 'Rast ↑', declining: 'Pad ↓', stable: 'Stabilno →', loss: 'Gubitak ⚠' }[fin.profitTrend];

  const kpis = [
    { label: 'Godišnji prihod', value: fmtEur(latest.revenue), color: GOLD },
    { label: 'Dobit / gubitak', value: (latest.profit < 0 ? '- ' : '+ ') + fmtEur(Math.abs(latest.profit)), color: latest.profit >= 0 ? '#52A882' : '#E05252' },
    { label: 'Trend dobiti', value: trendLabel, color: trendColor },
    { label: 'Zaposleni', value: latest.employees > 0 ? String(latest.employees) : '—', color: 'rgba(240,237,230,0.75)' },
    { label: 'Procj. mktg budžet', value: fmtEur(fin.estimatedMarketingBudget), color: 'rgba(240,237,230,0.75)' },
  ].map(k => `
    <div style="flex:1;min-width:140px;background:#141210;border:1px solid rgba(201,162,39,0.25);padding:16px">
      <div style="font-size:10px;color:rgba(240,237,230,0.40);letter-spacing:0.2em;text-transform:uppercase;font-family:Georgia,serif;margin-bottom:8px">${esc(k.label)}</div>
      <div style="font-size:20px;font-style:italic;font-family:Georgia,serif;color:${k.color}">${esc(k.value)}</div>
    </div>`).join('');

  return `<div style="display:flex;flex-wrap:wrap;gap:12px">${kpis}</div>`;
}

function buildFindings(data: DossierData, c1: CompetitorView, c2: CompetitorView): string {
  const bullets: string[] = [];

  // AI visibility
  const aiColor = scoreColor(data.visibilityScore);
  bullets.push(`Vaš <strong>AI Visibility Score je ${data.visibilityScore}/100</strong> — status: <span style="color:${aiColor}">${esc(data.verdict)}</span>.${
    data.topCompetitorInAI
      ? ` AI preporučuje <strong>${esc(data.topCompetitorInAI)}</strong> vašim potencijalnim klijentima.`
      : ''
  }`);

  // Google rating comparison
  if (data.targetRating > 0 && (c1.rating > data.targetRating || c2.rating > data.targetRating)) {
    const top = c1.rating >= c2.rating ? c1 : c2;
    bullets.push(`Vaša Google ocjena je <strong>${fmtRating(data.targetRating)}</strong> (${fmtCount(data.targetReviewCount)} recenzija). Konkurent <strong>${esc(top.name)}</strong> ima <strong>${fmtRating(top.rating)}</strong> (${fmtCount(top.reviewCount)} recenzija).`);
  } else if (data.targetRating > 0) {
    bullets.push(`Vaša Google ocjena <strong>${fmtRating(data.targetRating)}</strong> (${fmtCount(data.targetReviewCount)} recenzija) je konkurentna u tržištu.`);
  }

  // Meta ads gap
  if (!data.targetRunningAds) {
    if (c1.metaRunning || c2.metaRunning) {
      const active = c1.metaRunning ? c1 : c2;
      bullets.push(`Ne oglašavate se na Meta platformama. <strong>${esc(active.name)}</strong> aktivno vodi <strong>${active.metaCount} Meta oglasa</strong>.`);
    } else {
      bullets.push('Nitko u vašoj niši ne koristi Meta oglašavanje — priložnost za prvi korak.');
    }
  } else {
    bullets.push(`Aktivno vodite <strong>${data.targetAdCount} Meta oglasa</strong> — digitalna prisutnost postoji.`);
  }

  // Google ads gap
  if (!data.targetRunningGoogleAds) {
    if (c1.googleRunning || c2.googleRunning) {
      const active = c1.googleRunning ? c1 : c2;
      bullets.push(`Ne koristite Google Ads. <strong>${esc(active.name)}</strong> se aktivno oglašava na Google pretrazi.`);
    }
  }

  // Financials
  const rev = data.financials.years[0]?.revenue ?? 0;
  if (rev > 0) {
    bullets.push(`Prema javnim podacima, vaši godišnji prihodi iznose <strong>${fmtEur(rev)}</strong>. Procijenjeni marketinški budžet koji industrija preporučuje: <strong>${fmtEur(data.financials.estimatedMarketingBudget)}</strong>.`);
  }

  return bullets
    .slice(0, 5)
    .map(b => `<li style="padding:10px 0;border-bottom:1px solid rgba(201,162,39,0.08);font-size:14px;color:rgba(240,237,230,0.80);line-height:1.6">${b}</li>`)
    .join('');
}

// ── Main generator ────────────────────────────────────────────────────────────

export async function generateLandingPage(data: DossierData): Promise<string> {
  const config = getConfigSafe();
  const outDir = resolve(process.cwd(), 'output/pages', data.slug);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'index.html');

  const whatsappUrl = 'https://wa.me/385992532420?text=Pozdrav%2C%20vidio%2Fsam%20dosje%20koji%20ste%20mi%20poslali%20i%20zanima%20me%20više%20informacija.';
  const trackerUrl  = config.TRACKER_URL ?? '';
  const agencyName  = config.AGENCY_NAME ?? '';

  const nicheRecord = getNiche(data.niche);
  const videoUrl = data.clientVideoUrl || nicheRecord?.videoUrl || '';

  const color = scoreColor(data.visibilityScore);
  const cityLoc = toCroatianLocative(data.city);
  const c1 = toCompView(data, 1);
  const c2 = toCompView(data, 2);

  const hasFinancials = (data.financials.years[0]?.revenue ?? 0) > 0;
  const finSection = buildFinancialsSection(data);

  const videoSection = videoUrl
    ? `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:800px;margin:0 auto;border:1px solid rgba(201,162,39,0.3)">
        <iframe src="${esc(videoUrl)}"
                style="position:absolute;top:0;left:0;width:100%;height:100%;border:none"
                allow="autoplay; fullscreen" allowfullscreen></iframe>
       </div>`
    : `<div style="max-width:800px;margin:0 auto;background:#141210;border:1px solid rgba(201,162,39,0.3);padding:44px;text-align:center">
        <p style="color:rgba(240,237,230,0.45);font-size:15px;font-family:Georgia,serif;font-style:italic">Video pregled u pripremi.</p>
        <p style="color:rgba(240,237,230,0.30);font-size:13px;margin-top:10px">Kontaktirajte nas za personalizirani demo.</p>
       </div>`;

  const trackerScript = trackerUrl
    ? `<script>
  (function(){
    try{
      fetch(${JSON.stringify(trackerUrl)},{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          event:'page_visit',
          slug:${JSON.stringify(data.slug)},
          businessName:${JSON.stringify(data.legalName)},
          directorName:${JSON.stringify(data.directorFullName)},
          visibilityScore:${data.visibilityScore},
          verdict:${JSON.stringify(data.verdict)},
          timestamp:new Date().toISOString(),
          userAgent:navigator.userAgent
        })
      });
    }catch(e){}
  })();
</script>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="hr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(data.legalName)} — Personalizirani pregled</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:${OBSIDIAN};color:rgba(240,237,230,0.95);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6}
    a{color:inherit;text-decoration:none}
    .container{max-width:900px;margin:0 auto;padding:0 24px}
    .section{padding:52px 0}
    .section+.section{border-top:1px solid rgba(201,162,39,0.12)}
    .eyebrow{font-size:10px;color:${GOLD};letter-spacing:0.3em;text-transform:uppercase;font-family:Georgia,serif;margin-bottom:14px}
    h1{font-family:Georgia,'Times New Roman',serif;font-size:clamp(22px,4vw,36px);font-weight:400;font-style:italic;color:rgba(240,237,230,0.95);line-height:1.2;margin-bottom:10px}
    h2{font-family:Georgia,'Times New Roman',serif;font-size:clamp(18px,3vw,26px);font-weight:400;font-style:italic;color:rgba(240,237,230,0.95);margin-bottom:16px;line-height:1.25}
    .sub{color:rgba(240,237,230,0.55);font-size:15px}
    .gold-line{height:1px;background:linear-gradient(to right,transparent,${GOLD},transparent);margin:22px 0}
    .cta-btn{display:inline-block;background:${GOLD};color:${OBSIDIAN};padding:15px 48px;font-weight:700;font-size:15px;margin-top:24px;letter-spacing:0.05em;cursor:pointer;transition:opacity .2s}
    .cta-btn:hover{opacity:.85}
    footer{padding:24px 0;border-top:1px solid rgba(201,162,39,0.15);text-align:center;color:rgba(240,237,230,0.25);font-size:11px;letter-spacing:0.08em}
    ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:#2A2820}
  </style>
</head>
<body>

<!-- ── Header ── -->
<header style="border-bottom:1px solid rgba(201,162,39,0.3);padding:14px 0">
  <div class="container" style="display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:11px;font-weight:400;color:${GOLD};letter-spacing:0.3em;text-transform:uppercase;font-family:Georgia,serif">${esc(agencyName)}</span>
    <span style="font-size:10px;color:rgba(240,237,230,0.30);letter-spacing:0.2em;text-transform:uppercase;border:1px solid rgba(201,162,39,0.35);padding:3px 12px">Povjerljivo</span>
  </div>
</header>

<!-- ── Section 1: Hero ── -->
<div class="section">
  <div class="container">
    <div class="eyebrow">— Personalizirani dosje —</div>
    <h1>Pripremljeno za: ${esc(data.legalName)}</h1>
    <p class="sub">Osobno za: <strong style="color:rgba(240,237,230,0.95)">${esc(data.directorFullName || 'upravu')}</strong> &nbsp;·&nbsp; ${esc(data.nicheLabel)}, ${esc(data.city)}</p>
  </div>
</div>

<!-- ── Section 2: Video ── -->
<div class="section">
  <div class="container">
    <div class="eyebrow">— Pregled situacije —</div>
    <h2>Vaša pozicija u ${esc(cityLoc)}</h2>
    <p class="sub" style="margin-bottom:28px">Što se dogodi kad potencijalni klijent u ${esc(cityLoc)} pita ChatGPT za ${esc(data.nicheLabel)}</p>
    ${videoSection}
  </div>
</div>

<!-- ── Section 3: AI Visibility Score ── -->
<div class="section">
  <div class="container">
    <div class="eyebrow">— AI vidljivost —</div>
    <div style="max-width:480px;background:#141210;border:1px solid rgba(201,162,39,0.4);padding:40px 36px;text-align:center;margin:0 auto">
      <div style="font-family:Georgia,serif;font-size:10px;color:rgba(240,237,230,0.30);letter-spacing:0.3em;text-transform:uppercase;margin-bottom:10px">AI Visibility Score</div>
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:84px;font-weight:400;font-style:italic;line-height:1;margin:10px 0;color:${color}">${esc(String(data.visibilityScore))}<span style="color:rgba(240,237,230,0.25);font-size:30px">/100</span></div>
      <div style="color:rgba(240,237,230,0.50);font-size:13px;margin-bottom:12px">od 100 mogućih bodova</div>
      <div style="font-family:Georgia,serif;font-size:22px;font-style:italic;color:rgba(240,237,230,0.95)">Status: <span style="color:${color}">${esc(data.verdict)}</span></div>
      ${data.topCompetitorInAI
        ? `<div style="margin-top:18px;padding:12px 16px;background:#0E0C0A;border-left:2px solid #E05252;text-align:left">
            <p style="font-size:12px;color:rgba(240,237,230,0.55)">AI preporučuje:</p>
            <p style="font-size:14px;color:#E05252;font-weight:600;margin-top:4px">${esc(data.topCompetitorInAI)}</p>
          </div>`
        : ''
      }
    </div>
  </div>
</div>

<!-- ── Section 4: Full comparison table ── -->
<div class="section">
  <div class="container">
    <div class="eyebrow">— Usporedba s konkurencijom —</div>
    <h2>Vi vs. tržište</h2>
    <div style="overflow-x:auto">
      ${buildComparisonTable(data, c1, c2)}
    </div>
  </div>
</div>

<!-- ── Section 5: Ads analysis ── -->
<div class="section">
  <div class="container">
    <div class="eyebrow">— Analiza oglašavanja —</div>
    <h2>Tko se oglašava — a tko ne</h2>
    ${buildAdsSection(data, c1, c2)}
  </div>
</div>

${hasFinancials && finSection ? `
<!-- ── Section 6: Financial intelligence ── -->
<div class="section">
  <div class="container">
    <div class="eyebrow">— Financijska inteligencija —</div>
    <h2>Vaši javni financijski podaci</h2>
    <p class="sub" style="margin-bottom:24px">Podaci iz javnih registara — ${esc(String(data.financials.years[0]?.year ?? ''))}</p>
    ${finSection}
  </div>
</div>` : ''}

<!-- ── Section 7: What we found ── -->
<div class="section">
  <div class="container">
    <div class="eyebrow">— Što smo otkrili —</div>
    <h2>Ključni nalazi</h2>
    <ul style="list-style:none;padding:0">
      ${buildFindings(data, c1, c2)}
    </ul>
  </div>
</div>

<!-- ── Section 8: CTA ── -->
<div class="section" style="text-align:center">
  <div class="container">
    <div class="eyebrow">— Sljedeći korak —</div>
    <h2>Razgovarajmo o vašim podacima</h2>
    <p class="sub">Bez obveza. Samo konkretni podaci i prijedlog akcijskog plana.</p>
    <a href="${whatsappUrl}" class="cta-btn" target="_blank" rel="noopener">Piši nam na WhatsApp →</a>
  </div>
</div>

<footer>
  <div class="container">
    ${esc(agencyName)} &mdash; Povjerljivo, pripremljeno isključivo za ${esc(data.legalName)}
  </div>
</footer>

${trackerScript}
</body>
</html>`;

  writeFileSync(outPath, html, 'utf-8');
  logger.success(`  Landing page written: ${outPath}`);
  return outPath;
}
