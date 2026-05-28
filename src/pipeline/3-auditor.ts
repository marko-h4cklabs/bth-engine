import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import type { BusinessBase, GoogleData, AiAuditResult } from '../types/index.js';

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are simulating how an AI assistant like ChatGPT or Perplexity would respond to a patient or customer in Zagreb, Croatia looking for a local business recommendation.
Respond naturally and helpfully as that AI assistant would, drawing on general knowledge about Zagreb businesses and services. Do not mention that you are Claude or that you are simulating anything. Answer in Croatian unless the question is in English.
Keep your response between 100 and 200 words.`;

function buildQueries(nicheLabel: string): string[] {
  return [
    `Koja ${nicheLabel} u Zagrebu biste preporučili i zašto?`,
    `Gdje mogu pronaći dobru ${nicheLabel} u centru Zagreba?`,
    `Koja je najpoznatija ${nicheLabel} u Zagrebu prema iskustvima pacijenata?`,
    `Preporuči mi provjerenu ${nicheLabel} u Zagrebu — što si čuo o njima?`,
    `Best ${nicheLabel} in Zagreb?`,
  ];
}

// Generic Croatian business type words that appear in many company names
// and are too common to use for identity matching.
const GENERIC_PREFIXES = new Set([
  'poliklinika', 'klinika', 'ordinacija', 'ambulanta', 'centar', 'centar',
  'bolnica', 'ljekarna', 'apoteka', 'laboratorij', 'studio', 'salon',
  'agencija', 'tvrtka', 'drustvo', 'obrt', 'ustanova', 'zavod',
]);

// Extract the first non-generic identifying word from a legal name.
// "POLIKLINIKA BAGATIN d.o.o." → "bagatin"
// "Dental Centar Smiljan" → "dental"  (first is not generic)
// "BAGATIN d.o.o." → "bagatin"
function getIdentifyingWord(legalName: string): string {
  const words = legalName
    .toLowerCase()
    .split(/[\s\-,.()/]+/)
    .filter((w) => w.length >= 3);

  for (const word of words) {
    if (!GENERIC_PREFIXES.has(word)) return word;
  }
  // All words were generic — fall back to first word of reasonable length
  return words[0] ?? '';
}

function getTargetMentioned(response: string, legalName: string): boolean {
  const id = getIdentifyingWord(legalName);
  if (!id) return false;
  return response.toLowerCase().includes(id);
}

function getCompetitorsMentioned(
  response: string,
  competitors: GoogleData['competitors'],
): string[] {
  return competitors
    .filter((c) => {
      const id = getIdentifyingWord(c.name);
      return id.length >= 3 && response.toLowerCase().includes(id);
    })
    .map((c) => c.name);
}

function getTargetPosition(
  response: string,
  business: BusinessBase,
  competitors: GoogleData['competitors'],
): number | null {
  const allNames = [
    business.legalName,
    ...competitors.map((c) => c.name),
  ];

  const positions: Array<{ name: string; index: number }> = [];
  const lower = response.toLowerCase();

  for (const name of allNames) {
    const id = getIdentifyingWord(name);
    if (id.length < 3) continue;
    const idx = lower.indexOf(id);
    if (idx !== -1) {
      positions.push({ name, index: idx });
    }
  }

  positions.sort((a, b) => a.index - b.index);

  const targetId = getIdentifyingWord(business.legalName);
  const rank = positions.findIndex((p) =>
    getIdentifyingWord(p.name) === targetId,
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
  const queries = buildQueries(nicheLabel);

  const results: AiAuditResult['queries'] = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]!;
    logger.info(`  [AI] Query ${i + 1}/5: "${query}"`);

    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
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
