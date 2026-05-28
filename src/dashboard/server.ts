#!/usr/bin/env node
import express from 'express';
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import { existsSync } from 'fs';
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

// ── POST /api/deploy ──────────────────────────────────────────────────────────

app.post('/api/deploy', (req: Request, res: Response) => {
  const { slug } = req.body as { slug?: string };

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: 'Missing or invalid slug' });
    return;
  }

  startSSE(res);

  // Step 1: create dedicated Netlify site; collect output to detect "already exists"
  let createOutput = '';
  const create = spawn('netlify', ['sites:create', '--name', slug], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: '1' },
  });

  create.stdout?.on('data', (d: Buffer) => {
    const text = d.toString();
    createOutput += text;
    sseWrite(res, { type: 'log', text });
  });
  create.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    createOutput += text;
    sseWrite(res, { type: 'log', text });
  });

  create.on('close', (createCode) => {
    const alreadyExists = /already (exists|taken|in use)/i.test(createOutput);

    if (createCode !== 0 && !alreadyExists) {
      sseWrite(res, {
        type: 'log',
        text: `[deploy] sites:create exited ${createCode} — attempting deploy regardless...\n`,
      });
    }

    // Step 2: deploy to production (runs only after create fully exits)
    const deploy = spawn(
      'netlify',
      ['deploy', '--prod', '--dir', `output/pages/${slug}`, '--site', slug],
      { cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' } },
    );

    deploy.stdout?.on('data', (d: Buffer) => sseWrite(res, { type: 'log', text: d.toString() }));
    deploy.stderr?.on('data', (d: Buffer) => sseWrite(res, { type: 'log', text: d.toString() }));

    deploy.on('close', (code) => {
      sseWrite(res, { type: 'url', url: `https://${slug}.netlify.app` });
      sseWrite(res, { type: 'done', success: code === 0 });
      res.end();
    });
  });
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
