import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import type { BusinessBase, GoogleData, AiAuditResult } from '../types/index.js';

const MODEL = 'claude-sonnet-4-6';

function buildSystemPrompt(city: string): string {
  return `You are simulating how an AI assistant like ChatGPT or Perplexity would respond to a patient or customer in ${city}, Croatia looking for a local business recommendation.
Respond naturally and helpfully as that AI assistant would, drawing on general knowledge about ${city} businesses and services. Do not mention that you are Claude or that you are simulating anything. Always answer in Croatian.
Keep your response between 100 and 200 words.`;
}

// Cities with irregular locative forms
const LOCATIVE_OVERRIDES: Record<string, string> = {
  zagreb: 'Zagrebu', split: 'Splitu', rijeka: 'Rijeci',
  osijek: 'Osijeku', zadar: 'Zadru', pula: 'Puli',
  šibenik: 'Šibeniku', varaždin: 'Varaždinu', karlovac: 'Karlovcu',
  sisak: 'Sisku', koprivnica: 'Koprivnici', bjelovar: 'Bjelovaru',
  dubrovnik: 'Dubrovniku', čakovec: 'Čakovcu', mačkovec: 'Mačkovcu',
  đakovo: 'Đakovu', vukovar: 'Vukovaru', vinkovci: 'Vinkovcima',
  'slavonski brod': 'Slavonskom Brodu',
};

function toCroatianLocative(city: string): string {
  const key = city.toLowerCase();
  if (LOCATIVE_OVERRIDES[key]) return LOCATIVE_OVERRIDES[key]!;
  const lower = city.toLowerCase();
  if (lower.endsWith('ec')) return city.slice(0, -2) + 'cu'; // Čakovec → Čakovcu
  if (lower.endsWith('a')) return city.slice(0, -1) + 'i';   // Rijeka → Rijeci
  return city + 'u';                                           // Zagreb → Zagrebu
}

function buildQueries(nicheLabel: string, city: string): string[] {
  const loc = toCroatianLocative(city);
  return [
    `Koja ${nicheLabel} u ${loc} biste preporučili i zašto?`,
    `Gdje mogu naći dobru ${nicheLabel} u ${loc}?`,
    `Koja je najpoznatija ${nicheLabel} u ${loc}?`,
    `Preporuči mi provjerenu ${nicheLabel} u ${loc}`,
    `Tražim ${nicheLabel} u ${loc} — koje biste vi odabrali?`,
  ];
}

// Generic sector/facility words that must never count as a brand identifier
const GENERIC_SECTOR_WORDS = new Set([
  'poliklinika', 'klinika', 'ordinacija', 'ambulanta', 'centar', 'dom',
  'bolnica', 'ljekarna', 'apoteka', 'laboratorij', 'zavod', 'ustanova',
  'dispanzer', 'hitna',
  'stomatolog', 'stomatologije', 'stomatološka', 'stomatološki',
  'dentalni', 'dentalna', 'dentalno', 'zubni', 'zubna', 'zubar',
  'medicinska', 'medicinski', 'specijalistička', 'specijalistički',
  'privatna', 'privatni', 'opća', 'opći',
  'kozmetički', 'kozmetička', 'kozmetika',
  'salon', 'studio', 'spa', 'wellness',
  'gym', 'fitness', 'teretana', 'sportski', 'sportska',
  'restoran', 'hotel', 'hostel', 'caffe', 'cafe', 'bar',
  'agencija', 'tvrtka', 'drustvo', 'obrt', 'servis', 'usluge', 'trgovina',
]);

const LEGAL_SUFFIX_RE = /\s+(d\.o\.o\.?|d\.d\.?|j\.d\.o\.o\.?|j\.t\.d\.?|k\.d\.?|s\.p\.?|o\.j\.?|p\.o\.).*$/i;

// Extract the unique brand name from a legal or display name.
// "POLIKLINIKA BAGATIN d.o.o." → "Bagatin"
// "DENTAL FABRIQUE LAB d.o.o." → "Dental Fabrique Lab"
// "SRNEC TEKSTIL d.o.o." → "Srnec Tekstil"
export function extractBrandName(legalName: string): string {
  const withoutLegal = legalName.replace(LEGAL_SUFFIX_RE, '').trim();
  const words = withoutLegal
    .split(/[\s\-\/,.()+]+/)
    .map((w) => w.replace(/[^a-zA-Z0-9čćšđžČĆŠĐŽ]/g, ''))
    .filter((w) => w.length >= 2 && !GENERIC_SECTOR_WORDS.has(w.toLowerCase()));

  if (words.length === 0) {
    // All words were generic — return full name without legal suffix, title-cased
    return withoutLegal
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getTargetMentioned(response: string, legalName: string): boolean {
  const brand = extractBrandName(legalName);
  if (!brand) return false;
  return response.toLowerCase().includes(brand.toLowerCase());
}

function getCompetitorsMentioned(
  response: string,
  competitors: GoogleData['competitors'],
): string[] {
  return competitors
    .filter((c) => {
      const brand = extractBrandName(c.name);
      return brand.length >= 2 && response.toLowerCase().includes(brand.toLowerCase());
    })
    .map((c) => c.name);
}

function getTargetPosition(
  response: string,
  business: BusinessBase,
  competitors: GoogleData['competitors'],
): number | null {
  const allNames = [business.legalName, ...competitors.map((c) => c.name)];
  const positions: Array<{ name: string; index: number }> = [];
  const lower = response.toLowerCase();

  for (const name of allNames) {
    const brand = extractBrandName(name);
    if (brand.length < 2) continue;
    const idx = lower.indexOf(brand.toLowerCase());
    if (idx !== -1) positions.push({ name, index: idx });
  }

  positions.sort((a, b) => a.index - b.index);

  const targetBrand = extractBrandName(business.legalName).toLowerCase();
  const rank = positions.findIndex(
    (p) => extractBrandName(p.name).toLowerCase() === targetBrand,
  );

  return rank === -1 ? null : rank + 1;
}

export async function runAiAudit(
  business: BusinessBase,
  _niche: string,
  nicheLabel: string,
  competitors: GoogleData['competitors'],
): Promise<AiAuditResult> {
  const client = new Anthropic();
  const city = business.city;
  const queries = buildQueries(nicheLabel, city);
  const systemPrompt = buildSystemPrompt(city);

  const brandName = extractBrandName(business.legalName);
  logger.info(`  [AI] Brand name: "${brandName}" (extracted from "${business.legalName}")`);
  logger.info(`  [AI] Queries in: ${toCroatianLocative(city)}`);

  const results: AiAuditResult['queries'] = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]!;
    logger.info(`  [AI] Query ${i + 1}/5: "${query}"`);

    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: query }],
      });

      const responseText =
        message.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('') ?? '';

      const targetMentioned = getTargetMentioned(responseText, business.legalName);
      const competitorsMentioned = getCompetitorsMentioned(responseText, competitors);
      const targetPosition = getTargetPosition(responseText, business, competitors);

      logger.info(
        `  [AI] Mentioned target: ${targetMentioned} | Competitors: ${competitorsMentioned.join(', ') || 'none'}`,
      );

      results.push({
        query,
        response: responseText,
        targetMentioned,
        targetPosition,
        competitorsMentioned,
      });
    } catch (err) {
      logger.warn(`  [AI] Query ${i + 1} failed: ${err instanceof Error ? err.message : err}`);
      results.push({
        query,
        response: '',
        targetMentioned: false,
        targetPosition: null,
        competitorsMentioned: [],
      });
    }

    if (i < queries.length - 1) {
      await sleep(1000);
    }
  }

  // ── Score ────────────────────────────────────────────────────────────────────
  const mentionedCount = results.filter((r) => r.targetMentioned).length;
  const visibilityScore = Math.round((mentionedCount / 5) * 100);

  const verdict: AiAuditResult['verdict'] =
    visibilityScore === 0 ? 'INVISIBLE'
    : visibilityScore <= 40 ? 'WEAK'
    : visibilityScore <= 80 ? 'PRESENT'
    : 'DOMINANT';

  // Most frequently mentioned competitor across all 5 responses
  const competitorFrequency: Record<string, number> = {};
  for (const r of results) {
    for (const name of r.competitorsMentioned) {
      competitorFrequency[name] = (competitorFrequency[name] ?? 0) + 1;
    }
  }

  const topCompetitorInAI =
    Object.entries(competitorFrequency).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  logger.info(`  [AI] Visibility score: ${visibilityScore}/100 → verdict: ${verdict}`);
  if (topCompetitorInAI) {
    logger.info(`  [AI] Top competitor in AI: "${topCompetitorInAI}"`);
  }

  return {
    queries: results,
    visibilityScore,
    topCompetitorInAI,
    verdict,
  };
}
