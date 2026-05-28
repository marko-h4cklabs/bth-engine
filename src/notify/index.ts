import { getConfigSafe } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export interface VisitPayload {
  event: 'page_visit';
  client: string;
  businessName: string;
  directorName: string;
  visibilityScore?: number;
  verdict?: string;
  timestamp: string;
  userAgent: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildTelegramText(payload: VisitPayload): string {
  const score = payload.visibilityScore !== undefined ? payload.visibilityScore : '?';
  const verdict = payload.verdict ?? '—';
  const time = formatTime(payload.timestamp);

  return [
    '🟡 [BTH ENGINE]',
    '🔔 *Dosje otvoren*',
    '',
    `🏥 *Klinika:* ${payload.businessName}`,
    `👤 *Direktor:* ${payload.directorName}`,
    `📊 *AI Score:* ${score}/100 — ${verdict}`,
    `🕐 *Vrijeme:* ${time}`,
    '',
    '📞 Zovi odmah.',
  ].join('\n');
}

export async function dispatch(payload: VisitPayload): Promise<void> {
  const config = getConfigSafe();

  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    logger.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured — skipping notification');
    return;
  }

  const text = buildTelegramText(payload);
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram API responded with ${response.status}: ${await response.text()}`);
  }

  logger.success(`Telegram notification sent for ${payload.businessName}`);
}
