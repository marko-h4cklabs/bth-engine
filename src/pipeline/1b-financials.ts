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

      // Fix 3: target the table that contains 'Ukupni prihodi', not just the largest
      const revenueKeywords = ['ukupni prihodi', 'prihodi', 'prihod'];
      const mainTable = tables.find((t) => {
        const text = t.textContent?.toLowerCase() ?? '';
        return revenueKeywords.some((kw) => text.includes(kw));
      }) ?? tables.reduce((best, t) =>
        t.rows.length > best.rows.length ? t : best, tables[0]!);

      // Year headers — look for 4-digit numbers starting with 20
      const headerCells = Array.from(
        mainTable.querySelectorAll('thead tr th, thead tr td, tr:first-child th, tr:first-child td'),
      );

      // Fix 1: collect {year, colIdx} pairs, sort descending after
      const yearCols: Array<{ year: number; colIdx: number }> = [];
      headerCells.forEach((cell, i) => {
        const text = cell.textContent?.trim() ?? '';
        if (/^20\d{2}$/.test(text)) {
          yearCols.push({ year: parseInt(text, 10), colIdx: i });
        }
      });

      if (yearCols.length === 0) return null;

      // Body rows — store ALL cell values so we can index by colIdx after sorting
      const bodyRows: Array<{ label: string; allValues: string[] }> = [];
      const rows = Array.from(mainTable.querySelectorAll('tbody tr, tr')).slice(1);

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th'));
        if (cells.length < 2) continue;
        const label = cells[0]?.textContent?.trim() ?? '';
        if (!label) continue;
        const allValues = cells.map((c) => c.textContent?.trim() ?? '');
        bodyRows.push({ label, allValues });
      }

      return { yearCols, rows: bodyRows };
    });

    if (!raw || raw.yearCols.length === 0 || raw.rows.length === 0) {
      logger.warn('  [Financials] No table data found — using empty defaults');
      return EMPTY;
    }

    // Fix 1: sort descending, take 3 most recent
    const sortedYearCols = raw.yearCols
      .slice()
      .sort((a, b) => b.year - a.year)
      .slice(0, 3);

    // Build one YearlyFinancials per year
    const yearData: YearlyFinancials[] = sortedYearCols.map(({ year }) => ({
      year,
      revenue: 0, expenses: 0, profit: 0,
      capital: 0, assets: 0,
      shortTermDebt: 0, longTermDebt: 0,
      employees: 0, avgBruttoSalary: 0,
    }));

    for (const row of raw.rows) {
      const field = matchLabel(row.label);
      if (!field) continue;
      sortedYearCols.forEach(({ colIdx }, i) => {
        let val = parseCroatianNumber(row.allValues[colIdx] ?? '');
        // Fix 2: employee count must be an integer, not float
        if (field === 'employees') val = Math.round(val);
        if (yearData[i]) {
          (yearData[i] as unknown as Record<string, unknown>)[field] = val;
        }
      });
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
