import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import { sleep, randomBetween } from '../utils/sleep.js';
import type { BusinessBase } from '../types/index.js';

chromium.use(StealthPlugin());

async function getText(
  page: import('playwright').Page,
  selector: string,
): Promise<string> {
  try {
    const text = await page.locator(selector).first().textContent({ timeout: 5000 });
    return text?.trim() ?? '';
  } catch {
    return '';
  }
}

async function extractDlValue(
  page: import('playwright').Page,
  label: string,
): Promise<string> {
  return page.evaluate((lbl) => {
    const dts = Array.from(document.querySelectorAll('dl.row dt'));
    for (const dt of dts) {
      const text = dt.textContent?.trim() ?? '';
      if (text === lbl || text.includes(lbl)) {
        const dd = dt.nextElementSibling;
        if (dd?.tagName === 'DD') {
          return dd.textContent?.trim() ?? '';
        }
      }
    }
    return '';
  }, label);
}

async function extractDirector(page: import('playwright').Page): Promise<string> {
  return page.evaluate(() => {
    const dts = Array.from(document.querySelectorAll('dl.row dt'));
    const candidates: string[] = [];

    for (const dt of dts) {
      const dtText = dt.textContent?.trim() ?? '';
      if (dtText.includes('Zastupnik')) {
        const dd = dt.nextElementSibling;
        if (dd?.tagName === 'DD') {
          const ddText = dd.textContent?.trim() ?? '';
          const name = ddText.split(',')[0]?.trim() ?? '';
          if (name) {
            if (ddText.toLowerCase().includes('direktor')) {
              return name;
            }
            candidates.push(name);
          }
        }
      }
    }

    return candidates[0] ?? '';
  });
}

function extractCityFromAddress(address: string): string {
  const parts = address.split(',').map((p) => p.trim());
  for (let i = 0; i < parts.length; i++) {
    if (/^\d{5}$/.test(parts[i] ?? '')) {
      return parts[i + 1] ?? 'Zagreb';
    }
  }
  return parts[parts.length - 2] ?? 'Zagreb';
}

function saveDebugHtml(html: string): void {
  try {
    const dir = resolve(process.cwd(), 'output');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'debug-companywall.html'), html, 'utf-8');
    logger.warn('  Saved debug HTML → output/debug-companywall.html');
  } catch {
    // non-fatal
  }
}

export async function scrapeCompanyWall(url: string): Promise<BusinessBase> {
  logger.info(`Launching browser → ${url}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'hr-HR',
      timezoneId: 'Europe/Zagreb',
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,eot}', (r) => r.abort());

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(randomBetween(1500, 3500));

    const legalName = await getText(page, 'h1[itemprop="name"]');
    const fullLegalName = await extractDlValue(page, 'Naziv');

    if (!legalName) {
      logger.warn('  legalName empty — bot detection likely triggered, saving debug HTML');
      saveDebugHtml(await page.content());
    }

    logger.info(`  legalName: "${legalName}"`);
    if (fullLegalName && fullLegalName !== legalName) {
      logger.info(`  fullLegalName: "${fullLegalName}"`);
    }

    const oibItemprop = await getText(page, '[itemprop="vatID"]');
    const oibDl = await extractDlValue(page, 'OIB');
    const oibRaw = oibItemprop || oibDl;
    const oibMatch = oibRaw.replace(/\s/g, '').match(/\d{11}/);
    const oib = oibMatch?.[0] ?? '';
    logger.info(`  OIB: "${oib}"`);

    const street = await getText(page, '[itemprop="streetAddress"]');
    const postal = await getText(page, '[itemprop="postalCode"]');
    const cityItemprop = await getText(page, '[itemprop="addressLocality"]');
    const address = [street, postal, cityItemprop, 'Hrvatska'].filter(Boolean).join(', ');
    logger.info(`  address: "${address}"`);

    const city = extractCityFromAddress(address);
    const registeredActivity = (await extractDlValue(page, 'NKD')).replace(/\s+/g, ' ').trim();
    logger.info(`  registeredActivity: "${registeredActivity}"`);

    const directorRaw = await extractDirector(page);
    let directorFirstName = '';
    let directorLastName = '';
    let directorFullName = '';

    if (directorRaw) {
      const parts = directorRaw.trim().split(/\s+/);
      directorFirstName = parts[0] ?? '';
      directorLastName = parts.slice(1).join(' ');
      directorFullName = directorRaw.trim();
      logger.info(`  director: "${directorFullName}"`);
    } else {
      const vlMatch = legalName.match(/vl\.\s+([A-ZŠĐČĆŽ][a-zšđčćž]+\s+[A-ZŠĐČĆŽ][a-zšđčćž]+)/i);
      if (vlMatch?.[1]) {
        directorFullName = vlMatch[1].trim();
        const parts = directorFullName.split(/\s+/);
        directorFirstName = parts[0] ?? '';
        directorLastName = parts.slice(1).join(' ');
        logger.info(`  director (from legal name vl.): "${directorFullName}"`);
      } else {
        directorFullName = 'MANUAL_FILL';
        logger.warn('Director name not found — set manually via update-status or DB');
      }
    }

    return { legalName, oib, address, city, directorFirstName, directorLastName, directorFullName, registeredActivity };
  } finally {
    await browser.close();
  }
}
