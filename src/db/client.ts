import Database from 'better-sqlite3';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { ALL_TABLES } from './schema.js';
import type { ClientRecord, ClientStatus, NicheRecord, CaseStudyRecord } from '../types/index.js';

const DB_DIR = resolve(process.cwd(), 'data');
const DB_PATH = resolve(DB_DIR, 'bth.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  for (const sql of ALL_TABLES) {
    _db.exec(sql);
  }

  // Idempotent migrations for existing databases
  try { _db.exec('ALTER TABLE clients ADD COLUMN videoUrl TEXT'); } catch { /* column already exists */ }
  try { _db.exec('ALTER TABLE clients ADD COLUMN competitor1Url TEXT'); } catch {}
  try { _db.exec('ALTER TABLE clients ADD COLUMN competitor2Url TEXT'); } catch {}
  try { _db.exec('ALTER TABLE clients ADD COLUMN competitor1Name TEXT'); } catch {}
  try { _db.exec('ALTER TABLE clients ADD COLUMN competitor2Name TEXT'); } catch {}

  return _db;
}

function now(): string {
  return new Date().toISOString();
}

// ── Clients ──────────────────────────────────────────────────────────────────

export function upsertClient(data: Omit<ClientRecord, 'id' | 'createdAt' | 'updatedAt'> & { createdAt?: string }): ClientRecord {
  const db = getDb();
  const ts = now();

  const existing = db.prepare('SELECT * FROM clients WHERE slug = ?').get(data.slug) as ClientRecord | undefined;

  if (existing) {
    db.prepare(`
      UPDATE clients SET
        businessName     = ?,
        oib              = ?,
        directorFullName = ?,
        niche            = ?,
        city             = ?,
        status           = ?,
        pdfPath          = ?,
        landingPageUrl   = ?,
        visibilityScore  = ?,
        verdict          = ?,
        pageVisitedAt    = ?,
        pageVisitCount   = ?,
        notes            = ?,
        competitor1Url   = ?,
        competitor2Url   = ?,
        competitor1Name  = ?,
        competitor2Name  = ?,
        updatedAt        = ?
      WHERE slug = ?
    `).run(
      data.businessName, data.oib ?? null, data.directorFullName ?? null,
      data.niche, data.city, data.status,
      data.pdfPath ?? null, data.landingPageUrl ?? null,
      data.visibilityScore ?? null, data.verdict ?? null,
      data.pageVisitedAt ?? null, data.pageVisitCount,
      data.notes ?? null,
      data.competitor1Url ?? null, data.competitor2Url ?? null,
      data.competitor1Name ?? null, data.competitor2Name ?? null,
      ts, data.slug,
    );
    // Preserve videoUrl on upsert — only updateClientVideoUrl changes it
  } else {
    db.prepare(`
      INSERT INTO clients (
        slug, businessName, oib, directorFullName, niche, city, status,
        pdfPath, landingPageUrl, visibilityScore, verdict,
        pageVisitedAt, pageVisitCount, notes,
        competitor1Url, competitor2Url, competitor1Name, competitor2Name,
        createdAt, updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      data.slug, data.businessName, data.oib ?? null, data.directorFullName ?? null,
      data.niche, data.city, data.status,
      data.pdfPath ?? null, data.landingPageUrl ?? null,
      data.visibilityScore ?? null, data.verdict ?? null,
      data.pageVisitedAt ?? null, data.pageVisitCount,
      data.notes ?? null,
      data.competitor1Url ?? null, data.competitor2Url ?? null,
      data.competitor1Name ?? null, data.competitor2Name ?? null,
      data.createdAt ?? ts, ts,
    );
  }

  return db.prepare('SELECT * FROM clients WHERE slug = ?').get(data.slug) as ClientRecord;
}

export function getClient(slug: string): ClientRecord | undefined {
  return getDb().prepare('SELECT * FROM clients WHERE slug = ?').get(slug) as ClientRecord | undefined;
}

export function listClients(): ClientRecord[] {
  return getDb().prepare('SELECT * FROM clients ORDER BY createdAt DESC').all() as ClientRecord[];
}

export function updateClientStatus(slug: string, status: ClientStatus): boolean {
  const result = getDb()
    .prepare('UPDATE clients SET status = ?, updatedAt = ? WHERE slug = ?')
    .run(status, now(), slug);
  return result.changes > 0;
}

export function updateClientVideoUrl(slug: string, videoUrl: string | null): boolean {
  const result = getDb()
    .prepare('UPDATE clients SET videoUrl = ?, updatedAt = ? WHERE slug = ?')
    .run(videoUrl, now(), slug);
  return result.changes > 0;
}

export function recordPageVisit(slug: string): void {
  const db = getDb();
  const client = db.prepare('SELECT pageVisitCount, pageVisitedAt FROM clients WHERE slug = ?').get(slug) as
    | Pick<ClientRecord, 'pageVisitCount' | 'pageVisitedAt'>
    | undefined;

  if (!client) return;

  const ts = now();
  db.prepare(`
    UPDATE clients SET
      pageVisitCount = ?,
      pageVisitedAt  = COALESCE(pageVisitedAt, ?),
      updatedAt      = ?
    WHERE slug = ?
  `).run(client.pageVisitCount + 1, ts, ts, slug);
}

// ── Niches ───────────────────────────────────────────────────────────────────

export function upsertNiche(data: Omit<NicheRecord, 'id'>): NicheRecord {
  const db = getDb();
  db.prepare(`
    INSERT INTO niches (slug, labelHR, videoUrl, exclusiveClientId, city)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      labelHR           = excluded.labelHR,
      videoUrl          = excluded.videoUrl,
      city              = excluded.city
  `).run(data.slug, data.labelHR, data.videoUrl ?? null, data.exclusiveClientId ?? null, data.city);

  return db.prepare('SELECT * FROM niches WHERE slug = ?').get(data.slug) as NicheRecord;
}

export function getNiche(slug: string): NicheRecord | undefined {
  return getDb().prepare('SELECT * FROM niches WHERE slug = ?').get(slug) as NicheRecord | undefined;
}

export function listNiches(): NicheRecord[] {
  return getDb().prepare('SELECT * FROM niches ORDER BY city, slug').all() as NicheRecord[];
}

// ── Case Studies ──────────────────────────────────────────────────────────────

export function insertCaseStudy(data: Omit<CaseStudyRecord, 'id'>): CaseStudyRecord {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO case_studies (niche, city, resultMetric, isActive)
    VALUES (?, ?, ?, ?)
  `).run(data.niche, data.city ?? null, data.resultMetric, data.isActive);

  return db.prepare('SELECT * FROM case_studies WHERE id = ?').get(result.lastInsertRowid) as CaseStudyRecord;
}

export function getCaseStudyForNiche(niche: string): CaseStudyRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM case_studies WHERE niche = ? AND isActive = 1 ORDER BY id DESC LIMIT 1')
    .get(niche) as CaseStudyRecord | undefined;
}

export function listCaseStudies(): CaseStudyRecord[] {
  return getDb().prepare('SELECT * FROM case_studies ORDER BY niche, id').all() as CaseStudyRecord[];
}
