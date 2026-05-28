import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import { getConfigSafe } from '../utils/config.js';
import { getNiche } from '../db/client.js';
import type { DossierData } from '../types/index.js';

function scoreColor(score: number): string {
  if (score <= 39) return '#E05252';
  if (score <= 79) return '#C9A84C';
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

  const calendlyUrl = config.CALENDLY_URL ?? '#';
  const trackerUrl  = config.TRACKER_URL ?? '';
  const agencyName  = config.AGENCY_NAME ?? '';
  const color       = scoreColor(data.visibilityScore);

  // Fetch video URL from niche record
  const nicheRecord = getNiche(data.niche);
  const videoUrl = nicheRecord?.videoUrl ?? '';

  const videoSection = videoUrl
    ? `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:800px;margin:0 auto">
        <iframe src="${videoUrl}"
                style="position:absolute;top:0;left:0;width:100%;height:100%;border:none"
                allow="autoplay; fullscreen" allowfullscreen></iframe>
       </div>`
    : `<div style="max-width:800px;margin:0 auto;background:#141414;border:1px solid rgba(201,168,76,0.2);padding:40px;text-align:center">
        <p style="color:#9A9590;font-size:14px">Video pregled u pripremi.</p>
        <p style="color:#9A9590;font-size:13px;margin-top:8px">Kontaktirajte nas za personalizirani demo.</p>
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
    body{background:#0A0A0A;color:#F0EDE8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6}
    a{color:inherit;text-decoration:none}
    .container{max-width:860px;margin:0 auto;padding:0 24px}
    header{border-bottom:1px solid rgba(201,168,76,0.2);padding:16px 0}
    header .inner{max-width:860px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between;align-items:center}
    header .agency{font-size:13px;font-weight:600;color:#C9A84C;letter-spacing:0.08em;text-transform:uppercase}
    header .badge{font-size:11px;color:#9A9590;letter-spacing:0.06em;text-transform:uppercase;border:1px solid rgba(201,168,76,0.2);padding:3px 10px}
    section{padding:56px 0}
    section + section{border-top:1px solid rgba(201,168,76,0.08)}
    h1{font-family:Georgia,'Times New Roman',serif;font-size:clamp(26px,4vw,40px);font-weight:700;color:#F0EDE8;line-height:1.2;margin-bottom:10px}
    h2{font-family:Georgia,'Times New Roman',serif;font-size:clamp(20px,3vw,28px);font-weight:700;color:#F0EDE8;margin-bottom:16px;line-height:1.25}
    .sub{color:#9A9590;font-size:15px}
    .score-block{text-align:center;padding:48px 20px;background:#111}
    .score-num{font-size:80px;font-weight:700;line-height:1;margin:12px 0;color:${color}}
    .score-label{color:#9A9590;font-size:14px}
    .verdict-text{font-size:22px;font-weight:600;color:#F0EDE8;margin-top:12px}
    .cta-btn{display:inline-block;background:#C9A84C;color:#0A0A0A;padding:16px 48px;font-weight:600;font-size:16px;margin-top:24px;letter-spacing:0.02em;transition:opacity .2s}
    .cta-btn:hover{opacity:.85}
    footer{padding:24px 0;border-top:1px solid rgba(201,168,76,0.1);text-align:center;color:#9A9590;font-size:12px}
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
    <h1>Pripremljeno za: ${data.legalName}</h1>
    <p class="sub" style="margin-top:8px">Osobno za: <strong style="color:#F0EDE8">${data.directorFullName || 'upravu klinike'}</strong></p>
  </div>
</section>

<section>
  <div class="container">
    <h2>Vaš AI vidljivost pregled</h2>
    <p class="sub" style="margin-bottom:28px">Snimka zaslona — što se dogodi kad pacijent u ${data.city}u pita ChatGPT za ${data.nicheLabel}</p>
    ${videoSection}
  </div>
</section>

<section>
  <div class="container">
    <div class="score-block">
      <p class="score-label">Vaš AI Visibility Score</p>
      <div class="score-num">${data.visibilityScore}</div>
      <p class="score-label">od 100 mogućih bodova</p>
      <div class="verdict-text">AI vidljivost: <span style="color:${color}">${data.verdict}</span></div>
    </div>
  </div>
</section>

<section style="text-align:center">
  <div class="container">
    <h2>Zakazajte 15-minutni razgovor</h2>
    <p class="sub">Bez obveza. Samo podaci i konkretan prijedlog.</p>
    <a href="${calendlyUrl}" class="cta-btn">Zakaži razgovor →</a>
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
