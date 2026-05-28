import { spawn } from 'child_process';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';

interface NetlifySite { id: string; name: string; subdomain: string }

async function createOrFindSite(slug: string, token: string): Promise<string> {
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
  throw new Error(`Create site failed (${createRes.status}): ${errText}`);
}

export async function deployLandingPage(_sourcePath: string, slug: string): Promise<string> {
  const clientUrl = `https://${slug}.netlify.app`;
  const token = process.env.NETLIFY_TOKEN;

  if (!token) {
    logger.warn('  NETLIFY_TOKEN not set — skipping auto-deploy');
    logger.warn('  Set NETLIFY_TOKEN in .env to enable auto-deploy');
    return clientUrl;
  }

  // Step 1: create or reuse the Netlify site via REST API → get UUID site ID
  logger.info(`  [Deploy] Creating/finding site "${slug}"...`);
  const siteId = await createOrFindSite(slug, token);
  logger.info(`  [Deploy] Site ID: ${siteId}`);

  // Step 2: deploy using Netlify CLI with the UUID site ID and --auth flag
  // This bypasses all CLI login state and name-resolution issues.
  const pageDir = resolve(process.cwd(), 'output', 'pages', slug);
  logger.info(`  [Deploy] Deploying ${pageDir}...`);

  await new Promise<void>((res, rej) => {
    const proc = spawn(
      'npx',
      ['netlify', 'deploy', '--prod', '--dir', pageDir, '--site', siteId, '--auth', token, '--json'],
      { cwd: process.cwd(), env: process.env },
    );

    proc.stdout?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) logger.info(`  [Deploy] ${text}`);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) logger.info(`  [Deploy] ${text}`);
    });
    proc.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`Netlify CLI exited with code ${code}`));
    });
  });

  logger.success(`  [Deploy] Live at: ${clientUrl}`);
  return clientUrl;
}
