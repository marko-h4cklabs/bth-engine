import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import { getConfigSafe } from '../utils/config.js';
import { getNiche } from '../db/client.js';
import type { DossierData } from '../types/index.js';

// Aurelius brand colors
const GOLD    = '#C9A227';
const OBSIDIAN = '#0C0B09';

function scoreColor(score: number): string {
  if (score <= 39) return '#E05252';
  if (score <= 79) return GOLD;
  return '#52A882';
}

function jsonStr(value: string): string {
  return JSON.stringify(value);
}

export async function generateLandingPage(data: DossierData): Promise<string> {
  const config = getConfigSafe();
  const outDir = resolve(process.cwd(), 'output/pages', data.slug);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'index.html');

  const whatsappUrl = 'https://wa.me/385992532420?text=Pozdrav%2C%20vidio%2Fsam%20dosje%20koji%20ste%20mi%20poslali%20i%20zanima%20me%20više%20informacija.';
  const trackerUrl  = config.TRACKER_URL ?? '';
  const agencyName  = config.AGENCY_NAME ?? '';
  const color       = scoreColor(data.visibilityScore);

  const nicheRecord = getNiche(data.niche);
  // Client-specific video takes priority over niche default
  const videoUrl = data.clientVideoUrl || nicheRecord?.videoUrl || '';

  const videoSection = videoUrl
    ? `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:800px;margin:0 auto">
        <iframe src="${videoUrl}"
                style="position:absolute;top:0;left:0;width:100%;height:100%;border:none"
                allow="autoplay; fullscreen" allowfullscreen></iframe>
       </div>`
    : `<div style="max-width:800px;margin:0 auto;background:#141210;border:1px solid rgba(201,162,39,0.4);padding:40px;text-align:center">
        <p style="color:rgba(240,237,230,0.55);font-size:14px;font-family:Georgia,serif;font-style:italic">Video pregled u pripremi.</p>
        <p style="color:rgba(240,237,230,0.30);font-size:13px;margin-top:8px">Kontaktirajte nas za personalizirani demo.</p>
       </div>`;

  const html = `<!DOCTYPE html>
<html lang="hr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.legalName} — Personalizirani pregled</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:${OBSIDIAN};color:rgba(240,237,230,0.95);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6}
    a{color:inherit;text-decoration:none}
    .container{max-width:860px;margin:0 auto;padding:0 24px}

    header{border-bottom:1px solid rgba(201,162,39,0.4);padding:14px 0}
    header .inner{max-width:860px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between;align-items:center}
    header .agency{font-size:11px;font-weight:400;color:${GOLD};letter-spacing:0.3em;text-transform:uppercase;font-family:Georgia,serif}
    header .badge{font-size:10px;color:rgba(240,237,230,0.30);letter-spacing:0.2em;text-transform:uppercase;border:1px solid rgba(201,162,39,0.4);padding:3px 10px}

    section{padding:52px 0}
    section+section{border-top:1px solid rgba(201,162,39,0.12)}

    .section-eyebrow{font-size:10px;color:${GOLD};letter-spacing:0.3em;text-transform:uppercase;font-family:Georgia,serif;margin-bottom:14px}
    h1{font-family:Georgia,'Times New Roman',serif;font-size:clamp(24px,4vw,38px);font-weight:400;font-style:italic;color:rgba(240,237,230,0.95);line-height:1.2;margin-bottom:10px}
    h2{font-family:Georgia,'Times New Roman',serif;font-size:clamp(19px,3vw,26px);font-weight:400;font-style:italic;color:rgba(240,237,230,0.95);margin-bottom:14px;line-height:1.25}
    .sub{color:rgba(240,237,230,0.55);font-size:15px}
    .gold-line{height:1px;background:linear-gradient(to right,transparent,${GOLD},transparent);margin:20px 0}

    .score-block{text-align:center;padding:44px 20px;background:#141210;border:1px solid rgba(201,162,39,0.4)}
    .score-eyebrow{font-family:Georgia,serif;font-size:10px;color:rgba(240,237,230,0.30);letter-spacing:0.3em;text-transform:uppercase;margin-bottom:8px}
    .score-num{font-family:Georgia,'Times New Roman',serif;font-size:80px;font-weight:400;font-style:italic;line-height:1;margin:8px 0;color:${color}}
    .score-denom{color:rgba(240,237,230,0.30);font-size:28px}
    .score-label{color:rgba(240,237,230,0.55);font-size:13px;margin-bottom:10px}
    .verdict-text{font-family:Georgia,serif;font-size:20px;font-style:italic;color:rgba(240,237,230,0.95);margin-top:10px}

    .cta-btn{display:inline-block;background:${GOLD};color:${OBSIDIAN};padding:15px 44px;font-weight:600;font-size:15px;margin-top:22px;letter-spacing:0.04em;transition:opacity .2s}
    .cta-btn:hover{opacity:.85}

    footer{padding:22px 0;border-top:1px solid rgba(201,162,39,0.2);text-align:center;color:rgba(240,237,230,0.30);font-size:11px;letter-spacing:0.08em}
  </style>
</head>
<body>

<header>
  <div class="inner">
    <span class="agency">${agencyName}</span>
    <span class="badge">Povjerljivo</span>
  </div>
</header>

<section>
  <div class="container">
    <div class="section-eyebrow">— Personalizirani dosje —</div>
    <h1>Pripremljeno za: ${data.legalName}</h1>
    <p class="sub">Osobno za: <strong style="color:rgba(240,237,230,0.95)">${data.directorFullName || 'upravu klinike'}</strong></p>
  </div>
</section>

<section>
  <div class="container">
    <div class="section-eyebrow">— AI vidljivost —</div>
    <h2>Vaš AI vidljivost pregled</h2>
    <p class="sub" style="margin-bottom:26px">Što se dogodi kad pacijent u ${data.city}u pita ChatGPT za ${data.nicheLabel}</p>
    ${videoSection}
  </div>
</section>

<section>
  <div class="container">
    <div class="score-block">
      <div class="score-eyebrow">AI Visibility Score</div>
      <div class="score-num">${data.visibilityScore}<span class="score-denom">/100</span></div>
      <div class="score-label">od 100 mogućih bodova</div>
      <div class="verdict-text">AI vidljivost: <span style="color:${color}">${data.verdict}</span></div>
    </div>
  </div>
</section>

<section style="text-align:center">
  <div class="container">
    <div class="section-eyebrow">— Sljedeći korak —</div>
    <h2>Kontaktirajte nas direktno</h2>
    <p class="sub">Bez obveza. Samo podaci i konkretan prijedlog.</p>
    <a href="${whatsappUrl}" class="cta-btn" target="_blank" rel="noopener">Piši nam na WhatsApp →</a>
  </div>
</section>

<footer>
  <div class="container">
    ${agencyName} &mdash; Povjerljivo, pripremljeno isključivo za ${data.legalName}
  </div>
</footer>

<script>
  (function(){
    try{
      var w=${jsonStr(trackerUrl)};
      if(!w)return;
      fetch(w,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          event:'page_visit',
          slug:${jsonStr(data.slug)},
          businessName:${jsonStr(data.legalName)},
          directorName:${jsonStr(data.directorFullName)},
          visibilityScore:${data.visibilityScore},
          verdict:${jsonStr(data.verdict)},
          timestamp:new Date().toISOString(),
          userAgent:navigator.userAgent
        })
      });
    }catch(e){}
  })();
</script>
</body>
</html>`;

  writeFileSync(outPath, html, 'utf-8');
  logger.success(`  Landing page written: ${outPath}`);
  return outPath;
}
