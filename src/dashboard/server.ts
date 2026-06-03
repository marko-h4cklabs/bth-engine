#!/usr/bin/env node
import express from 'express';
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import type { Request, Response } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotenv({ path: resolve(__dirname, '../../.env') });

import { listNiches, listClients, updateClientStatus, updateClientVideoUrl, getClient } from '../db/client.js';
import { generateLandingPage } from '../landing/generator.js';
import { toNetlifySlug } from '../utils/slug.js';
import type { ClientStatus, DossierData } from '../types/index.js';

const port = Number(process.env.DASHBOARD_PORT ?? 4000);
const TSX = resolve(process.cwd(), 'node_modules/.bin/tsx');

const VALID_STATUSES: ClientStatus[] = [
  'generated', 'printed', 'delivered', 'called', 'meeting', 'signed', 'dead',
];

const app = express();
app.use(express.json());

// ── Static ────────────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(resolve(__dirname, 'index.html'));
});

// ── Data API ──────────────────────────────────────────────────────────────────

app.get('/api/niches', (_req: Request, res: Response) => {
  res.json(listNiches());
});

app.get('/api/clients', (_req: Request, res: Response) => {
  res.json(listClients());
});

// ── SSE helpers ───────────────────────────────────────────────────────────────

function startSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sseWrite(res: Response, data: object): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Spawn a child process and stream stdout/stderr as SSE log events.
// Disable chalk colors so the frontend can do its own coloring by keyword.
function spawnSSE(
  res: Response,
  cmd: string,
  args: string[],
  onClose: (code: number | null) => void,
): void {
  const proc = spawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  proc.stdout?.on('data', (d: Buffer) => sseWrite(res, { type: 'log', text: d.toString() }));
  proc.stderr?.on('data', (d: Buffer) => sseWrite(res, { type: 'log', text: d.toString() }));
  proc.on('close', onClose);
}

// ── POST /api/generate ────────────────────────────────────────────────────────

app.post('/api/generate', (req: Request, res: Response) => {
  const { googleMapsUrl, directorName, niche, competitor1Url, competitor2Url } = req.body as {
    googleMapsUrl?: string;
    directorName?: string;
    niche?: string;
    competitor1Url?: string | null;
    competitor2Url?: string | null;
  };

  if (!googleMapsUrl || !directorName || !niche) {
    res.status(400).json({ error: 'Missing googleMapsUrl, directorName, or niche' });
    return;
  }

  startSSE(res);
  const args = ['src/cli.ts', 'generate', googleMapsUrl, '--niche', niche, '--director', directorName];
  if (competitor1Url) args.push('--competitor1', competitor1Url);
  if (competitor2Url) args.push('--competitor2', competitor2Url);
  spawnSSE(res, TSX, args, (code) => {
    sseWrite(res, { type: 'done', success: code === 0 });
    res.end();
  });
});

// ── POST /api/export ──────────────────────────────────────────────────────────

app.post('/api/export', (req: Request, res: Response) => {
  const { slug } = req.body as { slug?: string };

  if (!slug) {
    res.status(400).json({ error: 'Missing slug' });
    return;
  }

  startSSE(res);
  spawnSSE(res, TSX, ['src/cli.ts', 'export', slug], (code) => {
    sseWrite(res, { type: 'done', success: code === 0 });
    res.end();
  });
});

// ── Netlify REST helpers ──────────────────────────────────────────────────────

interface NetlifySite { id: string; name: string; subdomain: string }

async function netlifyCreateOrFindSite(slug: string, token: string): Promise<string> {
  const createRes = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: slug }),
  });

  if (createRes.ok) {
    const site = await createRes.json() as NetlifySite;
    return site.id;
  }

  if (createRes.status === 422) {
    const listRes = await fetch('https://api.netlify.com/api/v1/sites?per_page=100', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) throw new Error(`Failed to list sites: ${listRes.status}`);
    const sites = await listRes.json() as NetlifySite[];
    const existing = sites.find((s) => s.name === slug || s.subdomain === slug);
    if (!existing) throw new Error(`Site name "${slug}" is taken by another Netlify account`);
    return existing.id;
  }

  const errText = await createRes.text();
  throw new Error(`sites create failed (${createRes.status}): ${errText}`);
}

// ── POST /api/deploy ──────────────────────────────────────────────────────────

app.post('/api/deploy', (req: Request, res: Response) => {
  const { slug } = req.body as { slug?: string };

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: 'Missing or invalid slug' });
    return;
  }

  startSSE(res);

  (async () => {
    const token = process.env.NETLIFY_TOKEN;
    if (!token) {
      sseWrite(res, { type: 'log', text: '[deploy] ERROR: NETLIFY_TOKEN is not set in .env\n' });
      sseWrite(res, { type: 'done', success: false });
      res.end();
      return;
    }

    try {
      // Step 1: REST API → get UUID site ID (bypasses CLI name resolution)
      sseWrite(res, { type: 'log', text: `[deploy] Creating / finding site "${slug}"...\n` });
      const siteId = await netlifyCreateOrFindSite(slug, token);
      sseWrite(res, { type: 'log', text: `[deploy] Site ID: ${siteId}\n` });

      // Step 2: Netlify CLI deploy with UUID site ID + --auth (no login state needed)
      const pageDir = resolve(process.cwd(), 'output', 'pages', slug);
      sseWrite(res, { type: 'log', text: `[deploy] Deploying ${pageDir}...\n` });

      await new Promise<void>((deployResolve, deployReject) => {
        const proc = spawn(
          'npx',
          ['netlify', 'deploy', '--prod', '--dir', pageDir, '--site', siteId, '--auth', token, '--json'],
          { cwd: process.cwd(), env: process.env },
        );

        proc.stdout?.on('data', (d: Buffer) => sseWrite(res, { type: 'log', text: d.toString() }));
        proc.stderr?.on('data', (d: Buffer) => sseWrite(res, { type: 'log', text: d.toString() }));
        proc.on('close', (code) => {
          if (code === 0) deployResolve();
          else deployReject(new Error(`Netlify CLI exited with code ${code}`));
        });
      });

      const liveUrl = `https://${slug}.netlify.app`;
      sseWrite(res, { type: 'log', text: `[deploy] Live at: ${liveUrl}\n` });
      sseWrite(res, { type: 'url', url: liveUrl });
      sseWrite(res, { type: 'done', success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sseWrite(res, { type: 'log', text: `[deploy] ERROR: ${msg}\n` });
      sseWrite(res, { type: 'done', success: false });
    }

    res.end();
  })();
});

// ── GET /api/open-pdf/:slug ───────────────────────────────────────────────────

app.get('/api/open-pdf/:slug', (req: Request, res: Response) => {
  const raw = req.params['slug'];
  const slug = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');

  if (!/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const pdfPath = resolve(process.cwd(), 'output', 'pdfs', `${slug}.pdf`);

  if (!existsSync(pdfPath)) {
    res.status(404).json({ error: 'PDF not found' });
    return;
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${opener} "${pdfPath}"`);
  res.json({ ok: true });
});

// ── POST /api/update-status ───────────────────────────────────────────────────

app.post('/api/update-status', (req: Request, res: Response) => {
  const { slug, status } = req.body as { slug?: string; status?: string };

  if (!slug || !status) {
    res.status(400).json({ error: 'Missing slug or status' });
    return;
  }

  if (!VALID_STATUSES.includes(status as ClientStatus)) {
    res.status(400).json({ error: `Invalid status: ${status}` });
    return;
  }

  const ok = updateClientStatus(slug, status as ClientStatus);
  res.json({ ok });
});

// ── POST /api/update-video-url ────────────────────────────────────────────────

function toYouTubeEmbed(url: string): string {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : url;
}

app.post('/api/update-video-url', (req: Request, res: Response) => {
  const { slug, videoUrl } = req.body as { slug?: string; videoUrl?: string };

  if (!slug) {
    res.status(400).json({ error: 'Missing slug' });
    return;
  }

  const embed = videoUrl ? toYouTubeEmbed(videoUrl.trim()) : null;
  const ok = updateClientVideoUrl(slug, embed || null);
  res.json({ ok, url: embed });
});

// ── POST /api/regen-landing ───────────────────────────────────────────────────
// Regenerates the landing page HTML from the stored dossier sidecar JSON
// (written by generateLandingPage at generation time), applies the current
// videoUrl from the DB, then redeploys via Netlify CLI.

app.post('/api/regen-landing', (req: Request, res: Response) => {
  const { slug } = req.body as { slug?: string };

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: 'Missing or invalid slug' });
    return;
  }

  startSSE(res);

  (async () => {
    try {
      const dossierPath = resolve(process.cwd(), 'output', 'dossiers', `${slug}.json`);
      if (!existsSync(dossierPath)) {
        throw new Error('Dossier JSON not found — run a full generate first to create the sidecar file');
      }

      // Load stored DossierData and patch the videoUrl from DB
      const dossierData = JSON.parse(readFileSync(dossierPath, 'utf-8')) as DossierData;
      const client = getClient(slug);
      dossierData.clientVideoUrl = client?.videoUrl ?? null;

      sseWrite(res, { type: 'log', text: `[regen] Regenerating landing page (videoUrl: ${dossierData.clientVideoUrl ?? 'none'})...\n` });
      await generateLandingPage(dossierData);
      sseWrite(res, { type: 'log', text: '[regen] Landing page HTML updated\n' });

      const token = process.env.NETLIFY_TOKEN;
      if (!token) {
        sseWrite(res, { type: 'log', text: '[regen] NETLIFY_TOKEN not set — HTML updated locally but not deployed\n' });
        sseWrite(res, { type: 'done', success: true });
        res.end();
        return;
      }

      const nSlug = toNetlifySlug(dossierData.legalName, dossierData.city);
      sseWrite(res, { type: 'log', text: `[regen] Creating/finding Netlify site "${nSlug}"...\n` });
      const siteId = await netlifyCreateOrFindSite(nSlug, token);
      sseWrite(res, { type: 'log', text: `[regen] Site ID: ${siteId}\n` });

      const pageDir = resolve(process.cwd(), 'output', 'pages', slug);
      sseWrite(res, { type: 'log', text: `[regen] Deploying ${pageDir}...\n` });

      await new Promise<void>((ok, fail) => {
        const proc = spawn(
          'npx',
          ['netlify', 'deploy', '--prod', '--dir', pageDir, '--site', siteId, '--auth', token, '--json'],
          { cwd: process.cwd(), env: process.env },
        );
        proc.stdout?.on('data', (d: Buffer) => sseWrite(res, { type: 'log', text: d.toString() }));
        proc.stderr?.on('data', (d: Buffer) => sseWrite(res, { type: 'log', text: d.toString() }));
        proc.on('close', (code) => code === 0 ? ok() : fail(new Error(`Netlify CLI exited ${code}`)));
      });

      const liveUrl = `https://${nSlug}.netlify.app`;
      sseWrite(res, { type: 'log', text: `[regen] Live at: ${liveUrl}\n` });
      sseWrite(res, { type: 'url', url: liveUrl });
      sseWrite(res, { type: 'done', success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sseWrite(res, { type: 'log', text: `[regen] ERROR: ${msg}\n` });
      sseWrite(res, { type: 'done', success: false });
    }
    res.end();
  })();
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(port, () => {
  const D = '─'.repeat(60);
  console.log(`\n${D}`);
  console.log('  BTH Engine — Dashboard');
  console.log(D);
  console.log('');
  console.log(`  ◆  Local dashboard: http://localhost:${port}`);
  console.log('  ◆  Open in browser and start generating');
  console.log('');
  console.log(`${D}\n`);
});
