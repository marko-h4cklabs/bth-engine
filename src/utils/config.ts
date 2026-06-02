import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadDotenv({ path: resolve(__dirname, '../../.env') });

const ConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  GOOGLE_PLACES_API_KEY: z.string().optional(),

  AGENCY_NAME: z.string().min(1, 'AGENCY_NAME is required'),
  AGENCY_DOMAIN: z.string().url().default('https://agencija.hr'),

  DEPLOY_MODE: z.enum(['local', 'vercel']).default('local'),
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_ORG_ID: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TRACKER_PORT: z.coerce.number().default(3456),
  TRACKER_URL: z.string().url().default('http://localhost:3456'),

  OUTPUT_DIR: z.string().default('./output'),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuration error:\n${missing}\n\nCopy .env.example to .env and fill in values.`);
  }

  _config = result.data;
  return _config;
}

export function getConfigSafe(): Partial<Config> {
  const result = ConfigSchema.safeParse(process.env);
  return result.success ? result.data : {};
}
