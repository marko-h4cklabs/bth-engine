import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';
import { logger } from '../utils/logger.js';

interface NetlifySite { id: string; name: string; subdomain: string }
interface NetlifyDeploy { id: string; state: string; error_message?: string; required: string[] }

// Walk a directory recursively, returning [absolutePath, netlifySitePath] pairs.
// netlifySitePath is the deploy-root-relative path with a leading slash, e.g. /index.html
function walkDir(dir: string): Array<[string, string]> {
  const results: Array<[string, string]> = [];
  for (const entry of readdirSync(dir, { recursive: true } as Parameters<typeof readdirSync>[1])) {
    const abs = join(dir, String(entry));
    if (statSync(abs).isFile()) {
      results.push([abs, '/' + relative(dir, abs).replace(/\\/g, '/')]);
    }
  }
  return results;
}

async function createOrFindSite(slug: string, token: string): Promise<string> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const createRes = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers,
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

// Shared pure-REST deploy. No CLI, no zip.
// onLog receives progress messages for streaming to the caller.
export async function deployViaRestApi(
  netlifySlug: string,
  pagesDir: string,
  token: string,
  onLog: (msg: string) => void,
): Promise<string> {
  const authHeader = { Authorization: `Bearer ${token}` };

  // ── Step 1: site ────────────────────────────────────────────────────────────
  onLog(`Creating/finding site "${netlifySlug}"...`);
  const siteId = await createOrFindSite(netlifySlug, token);
  onLog(`Site ID: ${siteId}`);

  // ── Step 2: build file map ──────────────────────────────────────────────────
  const entries = walkDir(pagesDir);
  const fileMap: Record<string, string> = {};
  const fileBuffers: Record<string, Buffer> = {};

  for (const [abs, sitePath] of entries) {
    const buf = readFileSync(abs);
    const sha1 = createHash('sha1').update(buf).digest('hex');
    fileMap[sitePath] = sha1;
    fileBuffers[sitePath] = buf;
  }
  onLog(`Files to deploy: ${entries.length}`);

  // ── Step 3: create deploy with SHA1 map ─────────────────────────────────────
  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: fileMap }),
  });

  if (!deployRes.ok) {
    const errText = await deployRes.text();
    throw new Error(`Create deploy failed (${deployRes.status}): ${errText}`);
  }

  const deploy = await deployRes.json() as NetlifyDeploy;
  const deployId = deploy.id;
  const required: string[] = deploy.required ?? [];
  onLog(`Deploy ID: ${deployId} | Files to upload: ${required.length}`);

  // ── Step 4: upload required files ──────────────────────────────────────────
  // sha1 → sitePath lookup
  const sha1ToPath: Record<string, string> = {};
  for (const [sitePath, sha1] of Object.entries(fileMap)) sha1ToPath[sha1] = sitePath;

  for (const sha1 of required) {
    const sitePath = sha1ToPath[sha1];
    if (!sitePath) continue;
    const buf = fileBuffers[sitePath]!;
    const uploadRes = await fetch(
      `https://api.netlify.com/api/v1/deploys/${deployId}/files${sitePath}`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/octet-stream' },
        body: buf as unknown as BodyInit,
      },
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Upload failed for ${sitePath} (${uploadRes.status}): ${errText}`);
    }
    onLog(`Uploaded: ${sitePath}`);
  }

  // ── Step 5: poll until ready ─────────────────────────────────────────────────
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setTimeout(r, 3000));
    const statusRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}`, {
      headers: authHeader,
    });
    const status = await statusRes.json() as NetlifyDeploy;
    onLog(`State: ${status.state}`);
    if (status.state === 'ready') break;
    if (status.state === 'error') throw new Error(`Deploy error: ${status.error_message ?? 'unknown'}`);
  }

  return `https://${netlifySlug}.netlify.app`;
}

// netlifySlug is the short ≤63-char slug used as the Netlify site name/subdomain.
// slug is the full filesystem slug (used for output/pages/{slug}/).
export async function deployLandingPage(sourcePath: string, slug: string, netlifySlug?: string): Promise<string> {
  const effectiveSlug = netlifySlug ?? slug;
  const clientUrl = `https://${effectiveSlug}.netlify.app`;
  const token = process.env.NETLIFY_TOKEN;

  if (!token) {
    logger.warn('  NETLIFY_TOKEN not set — skipping auto-deploy');
    logger.warn('  Set NETLIFY_TOKEN in .env to enable auto-deploy');
    return clientUrl;
  }

  const pagesDir = sourcePath
    ? dirname(resolve(sourcePath))
    : resolve(process.cwd(), 'output', 'pages', slug);

  logger.info(`  [Deploy] Deploying ${pagesDir}...`);

  const liveUrl = await deployViaRestApi(
    effectiveSlug,
    pagesDir,
    token,
    (msg) => logger.info(`  [Deploy] ${msg}`),
  );

  logger.success(`  [Deploy] Live at: ${liveUrl}`);
  return liveUrl;
}
