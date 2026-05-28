#!/usr/bin/env node
import express from 'express';
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import JSZip from 'jszip';
import type { Request, Response } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotenv({ path: resolve(__dirname, '../../.env') });

import { listNiches, listClients, updateClientStatus } from '../db/client.js';
import type { ClientStatus } from '../types/index.js';

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
  const { companyWallUrl, niche } = req.body as { companyWallUrl?: string; niche?: string };

  if (!companyWallUrl || !niche) {
    res.status(400).json({ error: 'Missing companyWallUrl or niche' });
    return;
  }

  startSSE(res);
  spawnSSE(res, TSX, ['src/cli.ts', 'generate', companyWallUrl, '--niche', niche], (code) => {
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

async function zipDirectory(sourceDir: string): Promise<ArrayBuffer> {
  const zip = new JSZip();

  function addDir(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const name = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        addDir(full, name);
      } else {
        zip.file(name, readFileSync(full));
      }
    }
  }

  addDir(sourceDir, '');
  const nodeBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength) as ArrayBuffer;
}

interface NetlifySite { id: string; name: string; subdomain: string }
interface NetlifyDeploy { id: string; state: string }

async function netlifyCreateOrFindSite(slug: string, token: string): Promise<string> {
  const createRes = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: slug }),
  });

  if (createRes.ok) {
    const site = await createRes.json() as NetlifySite;
    return site.id;
  }

  if (createRes.status === 422) {
    // Name taken — find the site in our own account
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
      // Step 1: create or reuse Netlify site
      sseWrite(res, { type: 'log', text: `[deploy] Creating / finding site "${slug}"...\n` });
      const siteId = await netlifyCreateOrFindSite(slug, token);
      sseWrite(res, { type: 'log', text: `[deploy] Site ID: ${siteId}\n` });

      // Step 2: zip the landing page folder
      const pageDir = resolve(process.cwd(), 'output', 'pages', slug);
      sseWrite(res, { type: 'log', text: `[deploy] Zipping ${pageDir}...\n` });
      const zipBuf = await zipDirectory(pageDir);
      sseWrite(res, { type: 'log', text: `[deploy] Zip ready (${(zipBuf.byteLength / 1024).toFixed(1)} KB)\n` });

      // Step 3: upload zip as a new deploy
      sseWrite(res, { type: 'log', text: '[deploy] Uploading to Netlify...\n' });
      const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/zip',
        },
        body: zipBuf,
      });

      if (!deployRes.ok) {
        const errText = await deployRes.text();
        throw new Error(`deploy upload failed (${deployRes.status}): ${errText}`);
      }

      const deploy = await deployRes.json() as NetlifyDeploy;
      const liveUrl = `https://${slug}.netlify.app`;

      sseWrite(res, { type: 'log', text: `[deploy] Deploy state: ${deploy.state}\n` });
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
