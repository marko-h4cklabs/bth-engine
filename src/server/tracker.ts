#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotenv({ path: resolve(__dirname, '../../.env') });

import { getConfigSafe } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const config = getConfigSafe();
const port = config.TRACKER_PORT ?? 3456;
const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = config.TELEGRAM_CHAT_ID ?? '';

logger.info('BOT TOKEN set: ' + !!TELEGRAM_BOT_TOKEN);
logger.info('CHAT ID set: ' + !!TELEGRAM_CHAT_ID);

function buildMessage(body: {
  businessName: string;
  directorName?: string;
  visibilityScore?: number;
  verdict?: string;
  timestamp?: string;
}): string {
  const score = body.visibilityScore !== undefined ? body.visibilityScore : '?';
  const verdict = body.verdict ?? '—';
  const time = new Date(body.timestamp ?? new Date().toISOString())
    .toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return [
    '🟡 [BTH ENGINE]',
    '🔔 *Dosje otvoren*',
    '',
    `🏥 *Klinika:* ${body.businessName}`,
    `👤 *Direktor:* ${body.directorName ?? '—'}`,
    `📊 *AI Score:* ${score}/100 — ${verdict}`,
    `🕐 *Vrijeme:* ${time}`,
    '',
    '📞 Zovi odmah.',
  ].join('\n');
}

const app = express();
app.use(cors({
  origin: (_origin, callback) => callback(null, true),
}));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/track', async (req, res) => {
  const { slug, businessName, directorName, visibilityScore, verdict, timestamp, userAgent } = req.body as {
    slug?: string;
    businessName?: string;
    directorName?: string;
    visibilityScore?: number;
    verdict?: string;
    timestamp?: string;
    userAgent?: string;
  };

  logger.info(`POST /track — slug=${slug} business=${businessName} ua=${userAgent ?? 'unknown'}`);

  if (!slug || !businessName) {
    logger.warn('Missing slug or businessName — rejecting');
    res.sendStatus(400);
    return;
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.warn('Telegram credentials not set — skipping send');
    res.sendStatus(204);
    return;
  }

  const message = buildMessage({
    businessName,
    ...(directorName !== undefined && { directorName }),
    ...(visibilityScore !== undefined && { visibilityScore }),
    ...(verdict !== undefined && { verdict }),
    ...(timestamp !== undefined && { timestamp }),
  });

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
    const json = await tgRes.json();
    logger.info('Telegram response: ' + JSON.stringify(json));
  } catch (err) {
    logger.error('Telegram send failed: ' + String(err));
  }

  res.sendStatus(204);
});

app.listen(port, () => {
  logger.success(`BTH Tracker listening on port ${port}`);
});
