#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from './utils/logger.js';
import {
  listClients,
  getClient,
  updateClientStatus,
  upsertNiche,
  insertCaseStudy,
  listCaseStudies,
  listNiches,
  getNiche,
} from './db/client.js';
import type { ClientStatus } from './types/index.js';

const VALID_STATUSES: ClientStatus[] = [
  'generated', 'printed', 'delivered', 'called', 'meeting', 'signed', 'dead',
];

const DEFAULT_NICHES = [
  { slug: 'estetska-medicina', labelHR: 'Estetska medicina', city: 'zagreb' },
  { slug: 'stomatologija',     labelHR: 'Stomatologija',     city: 'zagreb' },
  { slug: 'fitnes',            labelHR: 'Fitnes',            city: 'zagreb' },
  { slug: 'nekretnine',        labelHR: 'Nekretnine',        city: 'zagreb' },
  { slug: 'wellness',          labelHR: 'Wellness',          city: 'zagreb' },
];

const DEFAULT_CASE_STUDIES = [
  { niche: 'estetska-medicina', city: 'zagreb', resultMetric: '+340% zakazanih termina u 60 dana', isActive: 1 },
  { niche: 'stomatologija',     city: 'zagreb', resultMetric: '+180% novih pacijenata u 45 dana',  isActive: 1 },
  { niche: 'fitnes',            city: 'zagreb', resultMetric: '+220% novih članova u 30 dana',     isActive: 1 },
];

const program = new Command();

program
  .name('bth')
  .description('Balkan Trojan Horse Engine — B2B acquisition dossier generator')
  .version('0.1.0');

// ── bth generate ─────────────────────────────────────────────────────────────

program
  .command('generate <companyWallUrl>')
  .description('Run the full pipeline for a CompanyWall URL and generate PDF + landing page')
  .requiredOption('--niche <slug>', 'Business niche slug (e.g. estetska-medicina)')
  .option('--deploy', 'Deploy landing page after generation')
  .option('--dry-run', 'Run all steps, print output, skip PDF and deploy')
  .option('--competitor1 <url>', 'CompanyWall URL for manual competitor 1')
  .option('--competitor2 <url>', 'CompanyWall URL for manual competitor 2')
  .action(async (companyWallUrl: string, opts: {
    niche: string;
    deploy?: boolean;
    dryRun?: boolean;
    competitor1?: string;
    competitor2?: string;
  }) => {
    logger.section('BTH Generate');
    logger.info(`URL:   ${chalk.bold(companyWallUrl)}`);
    logger.info(`Niche: ${opts.niche}`);
    if (opts.dryRun) logger.warn('DRY RUN — PDF and deploy will be skipped');

    try {
      const { runPipeline } = await import('./pipeline/index.js');
      await runPipeline({
        companyWallUrl,
        niche: opts.niche,
        ...(opts.deploy !== undefined && { deploy: opts.deploy }),
        ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
        competitor1Url: opts.competitor1 ?? null,
        competitor2Url: opts.competitor2 ?? null,
      });
    } catch (err) {
      logger.error('Pipeline failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ── bth list ─────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all clients with their current pipeline status')
  .action(() => {
    const clients = listClients();

    const divider = '─'.repeat(60);
    console.log(chalk.dim(divider));
    console.log(`  ${chalk.bold('BTH ENGINE — Client Pipeline')}`);
    console.log(chalk.dim(divider));

    if (clients.length === 0) {
      console.log(chalk.dim('\n  No clients yet. Run `bth generate` to create one.\n'));
      console.log(chalk.dim(divider));
      return;
    }

    console.log();
    console.log(
      `  ${chalk.dim('#'.padEnd(3))}` +
      `${chalk.dim('Business'.padEnd(32))}` +
      `${chalk.dim('Niche'.padEnd(20))}` +
      `${chalk.dim('Score'.padEnd(8))}` +
      `${chalk.dim('Verdict'.padEnd(12))}` +
      `${chalk.dim('Status')}`,
    );
    console.log(
      `  ${chalk.dim('─'.padEnd(3))}` +
      `${chalk.dim('─'.repeat(30).padEnd(32))}` +
      `${chalk.dim('─'.repeat(18).padEnd(20))}` +
      `${chalk.dim('─'.repeat(6).padEnd(8))}` +
      `${chalk.dim('─'.repeat(10).padEnd(12))}` +
      `${chalk.dim('─'.repeat(10))}`,
    );

    function statusColor(s: string): string {
      switch (s) {
        case 'generated':  return chalk.gray(s);
        case 'printed':    return chalk.blue(s);
        case 'delivered':  return chalk.yellow(s);
        case 'called':     return chalk.cyan(s);
        case 'meeting':    return chalk.magenta(s);
        case 'signed':     return chalk.bold.green(s);
        case 'dead':       return chalk.dim.red(s);
        default:           return chalk.white(s);
      }
    }

    function verdictColor(v: string | null): string {
      if (!v) return chalk.dim('—');
      switch (v) {
        case 'INVISIBLE': return chalk.red(v);
        case 'WEAK':      return chalk.yellow(v);
        case 'PRESENT':   return chalk.cyan(v);
        case 'DOMINANT':  return chalk.green(v);
        default:          return chalk.white(v);
      }
    }

    clients.forEach((c, i) => {
      const score = c.visibilityScore !== null ? `${c.visibilityScore}/100` : '—';
      const visited = c.pageVisitCount > 0 ? chalk.yellow(` ✓×${c.pageVisitCount}`) : '';
      console.log(
        `  ${chalk.dim(String(i + 1).padEnd(3))}` +
        `${chalk.bold(c.businessName.slice(0, 30).padEnd(32))}` +
        `${c.niche.padEnd(20)}` +
        `${score.padEnd(8)}` +
        `${(verdictColor(c.verdict) + ' '.repeat(Math.max(0, 12 - (c.verdict?.length ?? 1)))).padEnd(12)}` +
        `${statusColor(c.status)}${visited}`,
      );
    });

    const signed  = clients.filter(c => c.status === 'signed').length;
    const meeting = clients.filter(c => c.status === 'meeting').length;

    console.log();
    console.log(chalk.dim(`  Total: ${clients.length} client${clients.length !== 1 ? 's' : ''} | ${signed} signed | ${meeting} in meeting`));
    console.log(chalk.dim(divider));
    console.log();
  });

// ── bth status ───────────────────────────────────────────────────────────────

program
  .command('status <slug>')
  .description('Show full detail for one client record')
  .action((slug: string) => {
    const client = getClient(slug);
    if (!client) {
      logger.error(`Client not found: ${slug}`);
      process.exit(1);
    }

    logger.section(`Client: ${client.businessName}`);
    logger.data('Slug',             client.slug);
    logger.data('OIB',              client.oib ?? '—');
    logger.data('Director',         client.directorFullName ?? '—');
    logger.data('Niche',            client.niche);
    logger.data('City',             client.city);
    logger.data('Status',           client.status);
    logger.data('PDF',              client.pdfPath ?? '—');
    logger.data('Landing page',     client.landingPageUrl ?? '—');
    logger.data('AI score',         client.visibilityScore !== null ? `${client.visibilityScore}/100` : '—');
    logger.data('AI verdict',       client.verdict ?? '—');
    logger.data('Page visits',      client.pageVisitCount);
    logger.data('First visit',      client.pageVisitedAt ?? '—');
    logger.data('Notes',            client.notes ?? '—');
    logger.data('Created',          client.createdAt);
    logger.data('Updated',          client.updatedAt);
    console.log();
  });

// ── bth update-status ────────────────────────────────────────────────────────

program
  .command('update-status <slug> <status>')
  .description(`Manually update a client's pipeline status (${VALID_STATUSES.join(' | ')})`)
  .action((slug: string, status: string) => {
    if (!VALID_STATUSES.includes(status as ClientStatus)) {
      logger.error(`Invalid status "${status}". Valid: ${VALID_STATUSES.join(', ')}`);
      process.exit(1);
    }

    const ok = updateClientStatus(slug, status as ClientStatus);
    if (!ok) {
      logger.error(`Client not found: ${slug}`);
      process.exit(1);
    }

    logger.success(`${slug} → ${status}`);
  });

// ── bth open ─────────────────────────────────────────────────────────────────

program
  .command('open <slug>')
  .description('Open the PDF and landing page for a client in the default viewer')
  .action((slug: string) => {
    const client = getClient(slug);
    if (!client) {
      logger.error(`Client not found: ${slug}`);
      process.exit(1);
    }

    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';

    const pdfPath = resolve(process.cwd(), 'output/pdfs', `${slug}.pdf`);
    if (existsSync(pdfPath)) {
      spawnSync(opener, [pdfPath], { stdio: 'ignore' });
      logger.success(`Opened PDF: ${pdfPath}`);
    } else {
      logger.warn(`PDF not found: ${pdfPath}`);
    }

    const pagePath = resolve(process.cwd(), 'output/pages', slug, 'index.html');
    if (existsSync(pagePath)) {
      spawnSync(opener, [pagePath], { stdio: 'ignore' });
      logger.success(`Opened page: ${pagePath}`);
    } else {
      logger.warn(`Landing page not found: ${pagePath}`);
    }
  });

// ── bth export ───────────────────────────────────────────────────────────────

program
  .command('export <slug>')
  .description('Create a self-contained delivery folder at output/export/{slug}/')
  .action((slug: string) => {
    const client = getClient(slug);
    if (!client) {
      logger.error(`Client not found: ${slug}`);
      process.exit(1);
    }

    const nicheRecord = getNiche(client.niche);
    const nicheLabel = nicheRecord?.labelHR ?? client.niche;

    const exportDir = resolve(process.cwd(), 'output/export', slug);
    const landingDir = resolve(exportDir, 'landing');
    mkdirSync(landingDir, { recursive: true });

    // ── Copy PDF ──────────────────────────────────────────────────────────────
    const safeName = client.businessName.replace(/[/\\?%*:|"<>]/g, '-');
    const srcPdf = resolve(process.cwd(), 'output/pdfs', `${slug}.pdf`);
    const dstPdf = resolve(exportDir, `DOSJE_${safeName}.pdf`);

    if (existsSync(srcPdf)) {
      copyFileSync(srcPdf, dstPdf);
      logger.success(`  PDF: DOSJE_${safeName}.pdf`);
    } else {
      logger.warn(`  PDF not found — skipping (${srcPdf})`);
    }

    // ── Copy landing page ─────────────────────────────────────────────────────
    const srcPage = resolve(process.cwd(), 'output/pages', slug, 'index.html');
    const dstPage = resolve(landingDir, 'index.html');

    if (existsSync(srcPage)) {
      copyFileSync(srcPage, dstPage);
      logger.success('  Landing page: landing/index.html');
    } else {
      logger.warn(`  Landing page not found — skipping (${srcPage})`);
    }

    // ── Generate DELIVERY_NOTE.txt ────────────────────────────────────────────
    const directorFirstName = (client.directorFullName ?? '').split(' ')[0] ?? 'Direktoru';
    const landingUrl = `https://${slug}.netlify.app`;
    const netlifyCreateCmd = `netlify sites:create --name ${slug}`;
    const netlifyDeployCmd = `netlify deploy --prod --dir output/pages/${slug} --site ${slug}`;
    const score = client.visibilityScore !== null ? `${client.visibilityScore}/100` : '—';
    const verdict = client.verdict ?? '—';

    const note = [
      'BTH ENGINE — Delivery Package',
      '══════════════════════════════════════════════════════',
      '',
      `Client:    ${client.businessName}`,
      `Director:  ${client.directorFullName ?? '—'}`,
      `Niche:     ${nicheLabel}`,
      `City:      ${client.city}`,
      `Generated: ${client.createdAt}`,
      `Slug:      ${client.slug}`,
      '',
      `AI SCORE:  ${score} — ${verdict}`,
      '',
      '──────────────────────────────────────────────────────',
      'PRINT INSTRUCTIONS',
      '──────────────────────────────────────────────────────',
      `File:      DOSJE_${safeName}.pdf`,
      'Paper:     170g–200g mat Kunstdruck (coated matte)',
      'Size:      A4 (with 3mm bleed — do not crop)',
      'Color:     Full color (CMYK conversion by print shop)',
      'Pages:     5',
      'Copies:    1 (plus 1 spare)',
      'Finish:    No lamination. No binding. Loose pages.',
      'Envelope:  Black, C4 size (229×324mm), no window',
      '',
      '──────────────────────────────────────────────────────',
      'NETLIFY DEPLOY (run both commands from project root)',
      '──────────────────────────────────────────────────────',
      '1. Create dedicated site (skip if already created):',
      netlifyCreateCmd,
      '',
      '2. Deploy landing page to production:',
      netlifyDeployCmd,
      '',
      `Landing page URL: ${landingUrl}`,
      'QR code points to this URL — deploy before sending envelope.',
      '',
      '──────────────────────────────────────────────────────',
      'CLOSER CHECKLIST',
      '──────────────────────────────────────────────────────',
      `[ ] Envelope addressed: "${client.directorFullName ?? 'Direktoru'}"`,
      '[ ] Marked: "POVJERLJIVO — osobno za direktora"',
      '[ ] PDF printed and inserted (5 pages, correct order)',
      '[ ] Landing page uploaded and live',
      '[ ] QR code tested — scans correctly to landing page',
      '[ ] Delivery confirmed (courier receipt / signature)',
      '[ ] Follow-up call scheduled: 24–48h after delivery',
      '[ ] Telegram notifications active (pnpm tracker)',
      '',
      'CALL OPENER (use verbatim):',
      `"Dobar dan, mogu li govoriti s ${directorFirstName}?`,
      'Zovem se [YOUR NAME] — poslali smo vam dosje s oznakom',
      'Povjerljivo. Imam 2 minute za vas, radi se o podacima',
      'koje smo prikupili o vašoj poziciji na tržištu."',
      '',
      '══════════════════════════════════════════════════════',
    ].join('\n');

    const notePath = resolve(exportDir, 'DELIVERY_NOTE.txt');
    writeFileSync(notePath, note, 'utf-8');
    logger.success('  Delivery note: DELIVERY_NOTE.txt');

    logger.section(`Export complete`);
    logger.data('Location', exportDir);
    console.log(`\n${'═'.repeat(58)}`);
    console.log('NETLIFY DEPLOY — copy and run these two commands:');
    console.log('═'.repeat(58));
    console.log(`1. ${netlifyCreateCmd}`);
    console.log(`2. ${netlifyDeployCmd}`);
    console.log(`\nLive URL after deploy: ${landingUrl}`);
    console.log('═'.repeat(58) + '\n');
  });

// ── bth notify-test ──────────────────────────────────────────────────────────

program
  .command('notify-test <slug>')
  .description('Fire a test Telegram notification for a given client (for setup testing)')
  .action(async (slug: string) => {
    const client = getClient(slug);
    if (!client) {
      logger.error(`Client not found: ${slug}`);
      process.exit(1);
    }

    try {
      const { dispatch } = await import('./notify/index.js');
      await dispatch({
        event: 'page_visit',
        client: client.slug,
        businessName: client.businessName,
        directorName: client.directorFullName ?? '—',
        ...(client.visibilityScore !== null && { visibilityScore: client.visibilityScore }),
        ...(client.verdict !== null && { verdict: client.verdict }),
        timestamp: new Date().toISOString(),
        userAgent: 'BTH-test-trigger/1.0',
      });
      logger.success('Test notification dispatched');
    } catch (err) {
      logger.error('Notification failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ── bth tracker ───────────────────────────────────────────────────────────────

program
  .command('tracker')
  .description('Start the local tracker server (receives page visits → Telegram)')
  .action(async () => {
    await import('./server/tracker.js');
  });

// ── bth seed-niches ───────────────────────────────────────────────────────────

program
  .command('seed-niches')
  .description('Seed the niches table with default Zagreb niches')
  .action(() => {
    logger.section('Seeding niches');
    for (const niche of DEFAULT_NICHES) {
      upsertNiche({ ...niche, videoUrl: null, exclusiveClientId: null });
      logger.success(`  ${niche.slug} (${niche.labelHR})`);
    }

    const all = listNiches();
    logger.info(`\n${all.length} niches in database.`);
  });

// ── bth seed-casestudies ──────────────────────────────────────────────────────

program
  .command('seed-casestudies')
  .description('Seed placeholder case studies (fill with real data after first client)')
  .action(() => {
    logger.section('Seeding case studies');
    logger.warn('These are PLACEHOLDER entries — replace with real client results before printing.');

    for (const cs of DEFAULT_CASE_STUDIES) {
      insertCaseStudy(cs);
      logger.success(`  ${cs.niche}: "${cs.resultMetric}"`);
    }

    const all = listCaseStudies();
    logger.info(`\n${all.length} case studies in database.`);
    logger.info('Edit data/bth.db with any SQLite client to update metrics.');
  });

// ── Error handling ────────────────────────────────────────────────────────────

program.on('command:*', () => {
  logger.error(`Unknown command: ${program.args.join(' ')}`);
  logger.info('Run `bth --help` for available commands.');
  process.exit(1);
});

program.parseAsync(process.argv).catch((err) => {
  logger.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
