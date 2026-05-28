import { chromium } from 'playwright';
import { logger } from '../utils/logger.js';
import { sleep, randomBetween } from '../utils/sleep.js';
import type { FinancialData, YearlyFinancials } from '../types/index.js';

function parseCroatianNumber(str: string): number {
  if (!str) return 0;
  const cleaned = str.trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// Maps normalised label substrings to YearlyFinancials field names
const LABEL_MAP: Array<[string, keyof YearlyFinancials]> = [
  ['ukupni prihodi',        'revenue'],
  ['ukupan prihod',         'revenue'],
  ['poslovni prihodi',      'revenue'],
  ['prihodi',               'revenue'],
  ['ukupni rashodi',        'expenses'],
  ['ukupan rashod',         'expenses'],
  ['rashodi',               'expenses'],
  ['neto dobit',            'profit'],
  ['dobit / gubitak',       'profit'],
  ['dobit/gubitak',         'profit'],
  ['dobit poslovne',        'profit'],
  ['dobit',                 'profit'],
  ['gubitak',               'profit'],
  ['kapital i rezerve',     'capital'],
  ['kapital',               'capital'],
  ['ukupna imovina',        'assets'],
  ['ukupna aktiva',         'assets'],
  ['imovina',               'assets'],
  ['sredstva',              'assets'],
  ['kratkoročne obveze',    'shortTermDebt'],
  ['kratkorocne obveze',    'shortTermDebt'],
  ['dugoročne obveze',      'longTermDebt'],
  ['dugorocne obveze',      'longTermDebt'],
  ['broj zaposlenih',       'employees'],
  ['zaposleni',             'employees'],
  ['prosj. bruto plaća',    'avgBruttoSalary'],
  ['prosječna bruto plaća', 'avgBruttoSalary'],
  ['prosj. placa',          'avgBruttoSalary'],
  ['bruto plaća',           'avgBruttoSalary'],
];

function matchLabel(raw: string): keyof YearlyFinancials | null {
  const lower = raw.toLowerCase().trim();
  for (const [key, field] of LABEL_MAP) {
    if (lower.includes(key)) return field;
  }
  return null;
}

const EMPTY: FinancialData = {
  years: [],
  revenueGrowth: 0,
  profitTrend: 'stable',
  employeeCount: 0,
  estimatedMarketingBudget: 0,
  currentDigitalSpend: 0,
  dataSource: 'companywall',
};

export async function scrapeFinancials(companyWallUrl: string): Promise<FinancialData> {
  const url = companyWallUrl.replace(/\/+$/, '') + '/financije';
  logger.info(`  [Financials] ${url}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'hr-HR',
      timezoneId: 'Europe/Zagreb',
      viewport: { width: 1366, height: 768 },
    });

    const page = await context.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,eot}', (r) => r.abort());

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(randomBetween(800, 1500));

    // Extract raw table data from the browser context
    const raw = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      if (tables.length === 0) return null;

      // Pick the table with the most rows (most likely the financials table)
      const mainTable = tables.reduce((best, t) =>
        t.rows.length > best.rows.length ? t : best,
      tables[0]!);

      // Year headers — look for 4-digit numbers starting with 20
      const yearCells = Array.from(
        mainTable.querySelectorAll('thead tr th, thead tr td, tr:first-child th, tr:first-child td'),
      );
      const years: number[] = [];
      const yearColIndexes: number[] = [];

      yearCells.forEach((cell, i) => {
        const text = cell.textContent?.trim() ?? '';
        if (/^20\d{2}$/.test(text)) {
          years.push(parseInt(text, 10));
          yearColIndexes.push(i);
        }
      });

      if (years.length === 0) return null;

      // Body rows
      const bodyRows: Array<{ label: string; values: string[] }> = [];
      const rows = Array.from(mainTable.querySelectorAll('tbody tr, tr')).slice(1); // skip header

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th'));
        if (cells.length < 2) continue;

        const label = cells[0]?.textContent?.trim() ?? '';
        if (!label) continue;

        // Values at the year column positions
        const values = yearColIndexes.map((ci) => cells[ci]?.textContent?.trim() ?? '');
        bodyRows.push({ label, values });
      }

      return { years, rows: bodyRows };
    });

    if (!raw || raw.years.length === 0 || raw.rows.length === 0) {
      logger.warn('  [Financials] No table data found — using empty defaults');
      return EMPTY;
    }

    // Take up to 3 most recent years (data comes newest-first from CompanyWall)
    const yearsToUse = raw.years.slice(0, 3);
    const numCols = yearsToUse.length;

    // Build one YearlyFinancials per year
    const yearData: YearlyFinancials[] = yearsToUse.map((year) => ({
      year,
      revenue: 0, expenses: 0, profit: 0,
      capital: 0, assets: 0,
      shortTermDebt: 0, longTermDebt: 0,
      employees: 0, avgBruttoSalary: 0,
    }));

    for (const row of raw.rows) {
      const field = matchLabel(row.label);
      if (!field) continue;
      for (let i = 0; i < numCols; i++) {
        const val = parseCroatianNumber(row.values[i] ?? '');
        if (yearData[i]) {
          (yearData[i] as unknown as Record<string, unknown>)[field] = val;
        }
      }
    }

    // Filter out years where we got zero revenue (no useful data)
    const validYears = yearData.filter((y) => y.revenue > 0 || y.profit !== 0 || y.employees > 0);

    if (validYears.length === 0) {
      logger.warn('  [Financials] Table found but all values are zero — using defaults');
      return EMPTY;
    }

    const latest = validYears[0]!;
    const oldest = validYears[validYears.length - 1]!;

    const revenueGrowth = oldest.revenue > 0
      ? Math.round(((latest.revenue - oldest.revenue) / oldest.revenue) * 1000) / 10
      : 0;

    let profitTrend: FinancialData['profitTrend'];
    if (latest.profit < 0) {
      profitTrend = 'loss';
    } else if (oldest.profit > 0 && latest.profit > oldest.profit * 1.1) {
      profitTrend = 'growing';
    } else if (oldest.profit > 0 && latest.profit < oldest.profit * 0.9) {
      profitTrend = 'declining';
    } else {
      profitTrend = 'stable';
    }

    logger.info(`  [Financials] Years: ${validYears.map((y) => y.year).join(', ')}`);
    logger.info(`  [Financials] Revenue: €${latest.revenue.toLocaleString('hr-HR')} | Profit: €${latest.profit.toLocaleString('hr-HR')} | Trend: ${profitTrend}`);
    logger.info(`  [Financials] Employees: ${latest.employees} | Avg brutto: €${latest.avgBruttoSalary}`);

    return {
      years: validYears,
      revenueGrowth,
      profitTrend,
      employeeCount: latest.employees,
      estimatedMarketingBudget: Math.round(latest.revenue * 0.05),
      currentDigitalSpend: 0,
      dataSource: 'companywall',
    };
  } catch (err) {
    logger.warn(`  [Financials] Failed: ${err instanceof Error ? err.message : err}`);
    return EMPTY;
  } finally {
    await browser.close();
  }
}
