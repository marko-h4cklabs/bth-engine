import { createWriteStream, readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver') as (format: import('archiver').Format, options?: import('archiver').ArchiverOptions) => import('archiver').Archiver;
import { logger } from '../utils/logger.js';

function zipDir(sourceDir: string): Promise<ArrayBuffer> {
  return new Promise((done, fail) => {
    const tmp = resolve(tmpdir(), `bth-deploy-${Date.now()}.zip`);
    const out = createWriteStream(tmp);
    const arc = archiver('zip', { zlib: { level: 9 } });

    out.on('close', () => {
      try {
        const buf = readFileSync(tmp);
        unlinkSync(tmp);
        done(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      } catch (e) { fail(e); }
    });
    arc.on('error', fail);
    arc.pipe(out);
    arc.directory(sourceDir, false);
    arc.finalize();
  });
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
