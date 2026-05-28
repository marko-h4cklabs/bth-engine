import { logger } from '../utils/logger.js';
import { getConfigSafe } from '../utils/config.js';

export async function deployLandingPage(
  sourcePath: string,
  slug: string,
): Promise<string> {
  const clientUrl = `https://${slug}.netlify.app`;

  logger.info(`  Landing page path: ${sourcePath}`);
  logger.info(`  Client URL: ${clientUrl}`);
  logger.warn('  Run `bth export` for the ready-to-paste Netlify deploy command');

  return clientUrl;
}
