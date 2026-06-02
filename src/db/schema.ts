export const CREATE_CLIENTS = `
  CREATE TABLE IF NOT EXISTS clients (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    slug             TEXT    UNIQUE NOT NULL,
    businessName     TEXT    NOT NULL,
    oib              TEXT,
    directorFullName TEXT,
    niche            TEXT    NOT NULL,
    city             TEXT    NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'generated',
    pdfPath          TEXT,
    landingPageUrl   TEXT,
    visibilityScore  INTEGER,
    verdict          TEXT,
    pageVisitedAt    TEXT,
    pageVisitCount   INTEGER NOT NULL DEFAULT 0,
    notes            TEXT,
    videoUrl         TEXT,
    createdAt        TEXT    NOT NULL,
    updatedAt        TEXT    NOT NULL
  )
`;

export const CREATE_NICHES = `
  CREATE TABLE IF NOT EXISTS niches (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    slug              TEXT    UNIQUE NOT NULL,
    labelHR           TEXT    NOT NULL,
    videoUrl          TEXT,
    exclusiveClientId INTEGER REFERENCES clients(id),
    city              TEXT    NOT NULL
  )
`;

export const CREATE_CASE_STUDIES = `
  CREATE TABLE IF NOT EXISTS case_studies (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    niche        TEXT    NOT NULL,
    city         TEXT,
    resultMetric TEXT    NOT NULL,
    isActive     INTEGER NOT NULL DEFAULT 1
  )
`;

export const ALL_TABLES = [CREATE_CLIENTS, CREATE_NICHES, CREATE_CASE_STUDIES];
