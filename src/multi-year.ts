import 'dotenv/config';
import * as fs from 'fs';
import { EBeszamoloScraper } from './scraper';
import { getTimestamp } from './utils';

interface InputRow {
  taxNumber: string;
  originalData: Record<string, string>;
}

interface YearlyData {
  netRevenue: number | null;      // Nettó árbevétel
  operatingProfit: number | null; // Üzemi eredmény
  profitBeforeTax: number | null; // Adózás előtti eredmény
  netProfit: number | null;       // Adózott/Mérleg szerinti eredmény
  currency: string;
  unit: string;
}

interface CompanyResult {
  taxNumber: string;
  companyName: string;
  registrationNumber: string;
  headquarter: string;
  years: Record<number, YearlyData | null>;
  errors: string[];
}

interface CheckpointData {
  inputFile: string;
  years: number[];
  completedTaxNumbers: string[];
  results: CompanyResult[];
  startedAt: string;
  lastUpdatedAt: string;
}

const CHECKPOINT_FILE = 'output/checkpoint.json';

function loadCheckpoint(): CheckpointData | null {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = fs.readFileSync(CHECKPOINT_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Ignore errors
  }
  return null;
}

function saveCheckpoint(data: CheckpointData): void {
  data.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Parse CSV with automatic delimiter detection
function parseCSV(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length === 0) return { headers: [], rows: [] };

  // Detect delimiter (semicolon or comma)
  const firstLine = lines[0];
  const delimiter = firstLine.includes(';') ? ';' : ',';

  const headers = firstLine.split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

// Find the tax number column in CSV
function findTaxNumberColumn(headers: string[]): string | null {
  const taxPatterns = [
    /ad[oó]sz[aá]m/i,
    /tax.*number/i,
    /tax.*id/i,
    /^tax$/i,
    /adosz/i
  ];

  for (const header of headers) {
    for (const pattern of taxPatterns) {
      if (pattern.test(header)) {
        return header;
      }
    }
  }

  // If no obvious match, look for column with 8-11 digit values
  return null;
}

// Extract key financial figures from income statement
// Returns both target year and previous year data from a single report
function extractKeyFigures(report: any, useTargetYear: boolean = true): YearlyData {
  const result: YearlyData = {
    netRevenue: null,
    operatingProfit: null,
    profitBeforeTax: null,
    netProfit: null,
    currency: report.currency || 'HUF',
    unit: report.unit || 'ezer'
  };

  if (!report.incomeStatement?.rows) return result;

  for (const row of report.incomeStatement.rows) {
    const name = row.itemName.toUpperCase();
    // Choose which year's data to extract
    const value = useTargetYear
      ? (typeof row.targetYearData === 'number' ? row.targetYearData : null)
      : (typeof row.previousYearData === 'number' ? row.previousYearData : null);

    // Nettó árbevétel (row 001 or I. NETTÓ ÁRBEVÉTEL)
    if (row.rowNumber === '001' || name.includes('NETTÓ ÁRBEVÉTEL')) {
      if (result.netRevenue === null) {
        result.netRevenue = value;
      }
    }

    // Üzemi (üzleti) tevékenység eredménye (row typically 013-014)
    if (name.includes('ÜZEMI') && name.includes('EREDMÉNY')) {
      result.operatingProfit = value;
    }

    // Adózás előtti eredmény (typically row 016)
    if (name.includes('ADÓZÁS ELŐTTI') || name.includes('ADÓZÁS ELÖTTI')) {
      result.profitBeforeTax = value;
    }

    // Adózott eredmény / Mérleg szerinti eredmény (typically rows 018-020)
    if (name.includes('ADÓZOTT EREDMÉNY') || name.includes('MÉRLEG SZERINTI EREDMÉNY')) {
      result.netProfit = value;
    }
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let inputFile = '';
  let taxColumn = '';
  let years = [2024, 2023];
  let workers = 5;  // Number of parallel Browserbase sessions

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' || args[i] === '-i') {
      inputFile = args[++i];
    } else if (args[i] === '--column' || args[i] === '-c') {
      taxColumn = args[++i];
    } else if (args[i] === '--years' || args[i] === '-y') {
      years = args[++i].split(',').map(y => parseInt(y.trim()));
    } else if (args[i] === '--workers' || args[i] === '-w') {
      workers = Math.min(20, Math.max(1, parseInt(args[++i]) || 5));
    } else if (!inputFile && !args[i].startsWith('-')) {
      inputFile = args[i];
    }
  }

  if (!inputFile) {
    console.log(`
E-Beszámolo Multi-Year Scraper
==============================

Használat:
  npm run multi-year <input.csv> [opciók]

Opciók:
  --input, -i    Input CSV fájl elérési útja
  --column, -c   Adószám oszlop neve (automatikus ha nem adod meg)
  --years, -y    Évek vesszővel elválasztva (alapértelmezett: 2024,2023,2022)
  --workers, -w  Párhuzamos böngészők száma (1-10, alapértelmezett: 5)

Példák:
  npm run multi-year cegek.csv
  npm run multi-year cegek.csv --column "Adószám" --years 2024,2023
  npm run multi-year cegek.csv --workers 10
`);
    process.exit(1);
  }

  // Read and parse CSV
  console.log(`\n========================================`);
  console.log(`E-Beszámolo Multi-Year Scraper`);
  console.log(`========================================`);
  console.log(`Input fájl: ${inputFile}`);

  if (!fs.existsSync(inputFile)) {
    console.error(`\n✗ Hiba: A fájl nem található: ${inputFile}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(inputFile, 'utf-8');
  const { headers, rows } = parseCSV(csvContent);

  console.log(`Oszlopok: ${headers.join(', ')}`);
  console.log(`Sorok száma: ${rows.length}`);

  // Find tax number column
  if (!taxColumn) {
    taxColumn = findTaxNumberColumn(headers) || '';
    if (!taxColumn) {
      console.error(`\n✗ Hiba: Nem találom az adószám oszlopot. Használd a --column opciót.`);
      console.log(`Elérhető oszlopok: ${headers.join(', ')}`);
      process.exit(1);
    }
  }

  if (!headers.includes(taxColumn)) {
    console.error(`\n✗ Hiba: A megadott oszlop nem létezik: ${taxColumn}`);
    console.log(`Elérhető oszlopok: ${headers.join(', ')}`);
    process.exit(1);
  }

  console.log(`Adószám oszlop: ${taxColumn}`);
  console.log(`Évek: ${years.join(', ')}`);
  console.log(`========================================\n`);

  // Extract and validate tax numbers
  const inputRows: InputRow[] = [];
  const skippedRows: { row: number; reason: string; value: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawValue = row[taxColumn]?.trim() || '';

    // Skip empty
    if (!rawValue) {
      skippedRows.push({ row: i + 2, reason: 'üres', value: '' });
      continue;
    }

    // Extract only digits
    const digitsOnly = rawValue.replace(/[^0-9]/g, '');

    // Hungarian tax numbers are 8 or 11 digits
    // We need at least 8 digits
    if (digitsOnly.length < 8) {
      skippedRows.push({ row: i + 2, reason: 'túl rövid', value: rawValue });
      continue;
    }

    // Check if it looks like a Hungarian tax number (starts with valid prefix)
    // Hungarian company tax numbers typically start with 1-2
    const first8 = digitsOnly.substring(0, 8);
    if (!/^[12]\d{7}$/.test(first8)) {
      skippedRows.push({ row: i + 2, reason: 'nem magyar adószám', value: rawValue });
      continue;
    }

    inputRows.push({
      taxNumber: first8,
      originalData: row
    });
  }

  // Deduplicate tax numbers (keep first occurrence)
  const uniqueTaxNumbers = new Map<string, InputRow>();
  let duplicateCount = 0;
  for (const row of inputRows) {
    if (!uniqueTaxNumbers.has(row.taxNumber)) {
      uniqueTaxNumbers.set(row.taxNumber, row);
    } else {
      duplicateCount++;
    }
  }
  const dedupedRows = Array.from(uniqueTaxNumbers.values());

  console.log(`Összes adószám: ${inputRows.length}`);
  console.log(`Egyedi adószámok: ${dedupedRows.length}${duplicateCount > 0 ? ` (${duplicateCount} duplikált kihagyva)` : ''}`);
  if (skippedRows.length > 0) {
    console.log(`Kihagyott sorok: ${skippedRows.length}`);
    if (skippedRows.length <= 10) {
      skippedRows.forEach(s => console.log(`  - Sor ${s.row}: ${s.reason}${s.value ? ` (${s.value})` : ''}`));
    }
  }

  if (dedupedRows.length === 0) {
    console.error(`\n✗ Hiba: Nem található érvényes adószám a fájlban.`);
    process.exit(1);
  }

  // Load checkpoint if exists
  let checkpoint = loadCheckpoint();
  let results: CompanyResult[] = [];
  let completedTaxNumbers = new Set<string>();

  if (checkpoint && checkpoint.inputFile === inputFile && JSON.stringify(checkpoint.years) === JSON.stringify(years)) {
    results = checkpoint.results;
    completedTaxNumbers = new Set(checkpoint.completedTaxNumbers);
    console.log(`\n✓ Checkpoint betöltve: ${completedTaxNumbers.size} cég már feldolgozva`);
  } else {
    // New run - create fresh checkpoint
    checkpoint = {
      inputFile,
      years,
      completedTaxNumbers: [],
      results: [],
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString()
    };
  }

  // Filter out already completed
  const remainingRows = dedupedRows.filter(r => !completedTaxNumbers.has(r.taxNumber));
  console.log(`Hátralévő adószámok: ${remainingRows.length}`);

  if (remainingRows.length === 0) {
    console.log(`\n✓ Minden cég feldolgozva! Exportálás...`);
    const timestamp = getTimestamp();
    exportSummaryCSV(results, years, `output/multi_year_summary_${timestamp}.csv`);
    exportDetailedJSON(results, `output/multi_year_detailed_${timestamp}.json`);
    process.exit(0);
  }

  // Adjust workers based on remaining work
  const actualWorkers = Math.min(workers, remainingRows.length);
  console.log(`Párhuzamos böngészők: ${actualWorkers}`);

  // Initialize scrapers for parallel processing
  const scrapers: EBeszamoloScraper[] = [];
  let completedCount = completedTaxNumbers.size;

  try {
    // Create and initialize all scrapers
    console.log(`\nBöngészők indítása...`);
    for (let i = 0; i < actualWorkers; i++) {
      const scraper = new EBeszamoloScraper();
      await scraper.initialize();
      scrapers.push(scraper);
      console.log(`  Worker ${i + 1}/${actualWorkers} kész`);
    }

    // Process company with a specific scraper
    // Optimized: fetches the latest year's report and extracts both target and previous year from it
    async function processCompany(scraper: EBeszamoloScraper, item: InputRow, index: number): Promise<CompanyResult> {
      const companyResult: CompanyResult = {
        taxNumber: item.taxNumber,
        companyName: '',
        registrationNumber: '',
        headquarter: '',
        years: {},
        errors: []
      };

      // Sort years descending to fetch the latest first
      const sortedYears = [...years].sort((a, b) => b - a);
      const latestYear = sortedYears[0];
      const previousYear = sortedYears[1];

      try {
        // Fetch only the latest year's report - it contains both current and previous year data!
        const report = await scraper.scrapeByTaxNumber(item.taxNumber, latestYear);

        if (report) {
          companyResult.companyName = report.companyName;
          companyResult.registrationNumber = report.registrationNumber;
          companyResult.headquarter = report.headquarter;

          // Extract target year data (e.g., 2024)
          companyResult.years[latestYear] = extractKeyFigures(report, true);

          // Extract previous year data from the same report (e.g., 2023)
          // The report contains "previousYearData" which is the year before the report's year
          if (previousYear && report.previousYear === previousYear) {
            const prevYearData = extractKeyFigures(report, false);
            // Only use if we actually got data (not all nulls)
            if (prevYearData.netRevenue !== null || prevYearData.operatingProfit !== null) {
              companyResult.years[previousYear] = prevYearData;
            } else {
              companyResult.years[previousYear] = null;
              companyResult.errors.push(`${previousYear}: Nincs adat`);
            }
          } else if (previousYear) {
            // Previous year doesn't match - need to fetch separately
            const prevReport = await scraper.scrapeByTaxNumber(item.taxNumber, previousYear);
            if (prevReport) {
              companyResult.years[previousYear] = extractKeyFigures(prevReport, true);
            } else {
              companyResult.years[previousYear] = null;
              companyResult.errors.push(`${previousYear}: Nincs adat`);
            }
          }
        } else {
          // No report for latest year - try each year separately
          for (const year of sortedYears) {
            const yearReport = await scraper.scrapeByTaxNumber(item.taxNumber, year);
            if (yearReport) {
              if (!companyResult.companyName) {
                companyResult.companyName = yearReport.companyName;
                companyResult.registrationNumber = yearReport.registrationNumber;
                companyResult.headquarter = yearReport.headquarter;
              }
              companyResult.years[year] = extractKeyFigures(yearReport, true);
            } else {
              companyResult.years[year] = null;
              companyResult.errors.push(`${year}: Nincs adat`);
            }
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        for (const year of years) {
          if (!companyResult.years[year]) {
            companyResult.years[year] = null;
            companyResult.errors.push(`${year}: ${errMsg}`);
          }
        }
      }

      completedCount++;
      const status = Object.values(companyResult.years).some(y => y !== null) ? '✓' : '✗';
      console.log(`[${completedCount}/${dedupedRows.length}] ${status} ${item.taxNumber} - ${companyResult.companyName || 'N/A'}`);

      return companyResult;
    }

    // Process all companies in parallel using worker pool
    console.log(`\nFeldolgozás indítása...\n`);

    // Create a queue of work items
    const queue = [...remainingRows.entries()];
    const workerPromises: Promise<void>[] = [];

    for (let i = 0; i < actualWorkers; i++) {
      const scraper = scrapers[i];

      const workerTask = async () => {
        while (queue.length > 0) {
          const work = queue.shift();
          if (!work) break;

          const [, item] = work;
          const result = await processCompany(scraper, item, 0);
          results.push(result);

          // Save individual company JSON file
          const companyFile = `output/${item.taxNumber}.json`;
          fs.writeFileSync(companyFile, JSON.stringify(result, null, 2), 'utf-8');

          // Save checkpoint after each company
          checkpoint!.results = results;
          checkpoint!.completedTaxNumbers = results.map(r => r.taxNumber);
          saveCheckpoint(checkpoint!);

          // Reinitialize session to get new proxy IP for each company
          // This enables IP rotation when using Browserbase proxies
          if (queue.length > 0) {
            console.log(`  → New session for next company...`);
            await scraper.reinitialize();
          }

          // Small delay between companies for the same worker
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      };

      workerPromises.push(workerTask());
    }

    // Wait for all workers to complete
    await Promise.all(workerPromises);

    // Export results
    const timestamp = getTimestamp();
    exportSummaryCSV(results, years, `output/multi_year_summary_${timestamp}.csv`);
    exportDetailedJSON(results, `output/multi_year_detailed_${timestamp}.json`);

    console.log(`\n========================================`);
    console.log(`✓ Feldolgozás kész!`);
    console.log(`  Sikeres: ${results.filter(r => Object.values(r.years).some(y => y !== null)).length}/${results.length}`);
    console.log(`========================================`);

  } catch (error) {
    console.error('\nFatális hiba:', error);
  } finally {
    // Close all scrapers
    for (const scraper of scrapers) {
      await scraper.close();
    }
  }
}

function exportSummaryCSV(results: CompanyResult[], years: number[], outputPath: string): void {
  // Build headers
  const baseHeaders = ['Adószám', 'Cégnév', 'Cégjegyzékszám', 'Székhely'];
  const yearHeaders: string[] = [];

  for (const year of years) {
    yearHeaders.push(`Nettó árbevétel ${year}`);
    yearHeaders.push(`Üzemi eredmény ${year}`);
    yearHeaders.push(`Adózott eredmény ${year}`);
  }

  const headers = [...baseHeaders, ...yearHeaders, 'Pénznem', 'Egység', 'Megjegyzések'];

  // Build rows
  const csvRows: string[] = [headers.join(';')];

  for (const result of results) {
    const row: (string | number)[] = [
      result.taxNumber,
      `"${result.companyName}"`,
      `"${result.registrationNumber}"`,
      `"${result.headquarter}"`
    ];

    let currency = 'HUF';
    let unit = 'ezer';

    for (const year of years) {
      const data = result.years[year];
      if (data) {
        row.push(data.netRevenue ?? '');
        row.push(data.operatingProfit ?? '');
        row.push(data.netProfit ?? '');
        currency = data.currency;
        unit = data.unit;
      } else {
        row.push('', '', '');
      }
    }

    row.push(currency);
    row.push(unit);
    row.push(`"${result.errors.join('; ')}"`);

    csvRows.push(row.join(';'));
  }

  const csvContent = '\uFEFF' + csvRows.join('\n');
  fs.writeFileSync(outputPath, csvContent, 'utf-8');
  console.log(`\n✓ Összesítő CSV exportálva: ${outputPath}`);
}

function exportDetailedJSON(results: CompanyResult[], outputPath: string): void {
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`✓ Részletes JSON exportálva: ${outputPath}`);
}

main();
