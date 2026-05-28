import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import JSZip from 'jszip';
import { logger } from '../utils/logger.js';

async function zipDir(sourceDir: string): Promise<ArrayBuffer> {
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

export async function deployLandingPage(sourcePath: string, slug: string): Promise<string> {
  const clientUrl = `https://${slug}.netlify.app`;
  const token = process.env.NETLIFY_TOKEN;

  if (!token) {
    logger.warn('  NETLIFY_TOKEN not set — skipping auto-deploy');
    logger.warn('  Set NETLIFY_TOKEN in .env or use the dashboard Deploy button');
    return clientUrl;
  }

  logger.info(`  [Deploy] Creating/finding site "${slug}"...`);
  const siteId = await createOrFindSite(slug, token);
  logger.info(`  [Deploy] Site ID: ${siteId}`);

  const pageDir = resolve(process.cwd(), 'output', 'pages', slug);
  logger.info(`  [Deploy] Zipping ${pageDir}...`);
  const zipBuf = await zipDir(pageDir);
  logger.info(`  [Deploy] Zip ready (${(zipBuf.byteLength / 1024).toFixed(1)} KB)`);

  logger.info('  [Deploy] Uploading...');
  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
    body: zipBuf,
  });

  if (!deployRes.ok) {
    const errText = await deployRes.text();
    throw new Error(`Deploy upload failed (${deployRes.status}): ${errText}`);
  }

  const deploy = await deployRes.json() as { id: string; state: string };
  logger.info(`  [Deploy] State: ${deploy.state}`);
  logger.success(`  [Deploy] Live at: ${clientUrl}`);

  return clientUrl;
}
