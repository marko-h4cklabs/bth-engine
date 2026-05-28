import { logger } from '../utils/logger.js';
import { getConfigSafe } from '../utils/config.js';

export async function deployLandingPage(
  sourcePath: string,
  slug: string,
): Promise<string> {
  const config = getConfigSafe();
  const domain = config.AGENCY_DOMAIN ?? 'https://agencija.hr';
  const url = `${domain}/klijenti/${slug}`;

  logger.info(`  Landing page path: ${sourcePath}`);
  logger.info(`  Expected public URL: ${url}`);
  logger.warn('  Deploy mode: local — manually upload output/pages/ to your web server');
  logger.warn('  Or: set DEPLOY_MODE=vercel in .env for automatic deployment');

  return url;
}
