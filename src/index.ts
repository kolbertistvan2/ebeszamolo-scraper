import { chromium, Browser, Page } from '@playwright/test';
import * as fs from 'fs';

// ==================== INTERFACES ====================

interface IncomeStatementRow {
  rowNumber: string;
  itemCode: string;
  itemName: string;
  previousYearData: number | string;
  amendments: number | string;
  targetYearData: number | string;
}

interface BalanceSheetRow {
  rowNumber: string;
  itemCode: string;
  itemName: string;
  previousYearData: number | string;
  amendments: number | string;
  targetYearData: number | string;
}

interface CompanyFinancialReport {
  companyName: string;
  registrationNumber: string;
  taxNumber: string;
  headquarter: string;
  year: number;
  currency: string;
  unit: string;
  filingDate: string;
  incomeStatement: {
    rows: IncomeStatementRow[];
  };
  balanceSheet: {
    rows: BalanceSheetRow[];
  };
  extractedAt: string;
  sourceURL: string;
}

// ==================== SCRAPER CLASS ====================

class EBeszamoloScraper {
  private browser: Browser | null = null;
  private readonly baseURL = 'https://e-beszamolo.im.gov.hu';

  async initialize() {
    this.browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled']
    });
    console.log('✓ Browser launched');
  }

  async close() {
    await this.browser?.close();
    console.log('✓ Browser closed');
  }

  async scrapeCompanies(
    companyNames: string[],
    targetYear: number = 2024
  ): Promise<CompanyFinancialReport[]> {
    const results: CompanyFinancialReport[] = [];

    for (let i = 0; i < companyNames.length; i++) {
      const companyName = companyNames[i];
      console.log(`\n[${i + 1}/${companyNames.length}] Processing: ${companyName}`);

      try {
        const report = await this.scrapeCompany(companyName, targetYear);
        if (report) {
          results.push(report);
          console.log(`✓ Successfully scraped: ${companyName}`);
        }
      } catch (error) {
        console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
      }

      await this.delay(2000);
    }

    return results;
  }

  private async scrapeCompany(
    companyName: string,
    targetYear: number
  ): Promise<CompanyFinancialReport | null> {
    const page = await this.browser!.newPage();

    try {
      // 1. Navigate to search page
      console.log('  → Navigating to search page...');
      await page.goto(`${this.baseURL}/oldal/beszamolo_kereses`, {
        waitUntil: 'networkidle'
      });

      // 2. Fill search form
      console.log('  → Searching for company...');
      await page.fill('input#firmName', companyName);
      await page.click('button#btnSubmit');

      // 3. Wait for results
      await page.waitForSelector('table tbody tr', { timeout: 10000 });
      await this.delay(1000);

      // 4. Click first result
      const firstResult = await page.$('table tbody tr:first-child td:first-child a');
      if (!firstResult) {
        console.log('  ✗ No search results found');
        return null;
      }

      await firstResult.click();
      await page.waitForLoadState('networkidle');

      // 5. Extract company info
      console.log('  → Extracting company information...');
      const companyInfo = await page.evaluate(() => {
        const text = document.body.innerText;
        const regMatch = text.match(/Cégjegyzékszáma:\s*(\d{2}-\d{2}-\d{6})/);
        const taxMatch = text.match(/Adószáma:\s*([\d-]+)/);
        const hqMatch = text.match(/Székhely:\s*([^\n]+)/);

        return {
          registrationNumber: regMatch ? regMatch[1] : '',
          taxNumber: taxMatch ? taxMatch[1] : '',
          headquarter: hqMatch ? hqMatch[1].trim() : ''
        };
      });

      // 6. Find report link
      console.log('  → Looking for financial reports...');
      const reportLinks = await page.$$eval(
        'a[href*="kereses_megjelenites"]',
        (links) => links.map((l) => l.getAttribute('href')).filter(Boolean) as string[]
      );

      if (reportLinks.length === 0) {
        console.log('  ✗ No reports found');
        return null;
      }

      // 7. Navigate to report
      const reportUrl = `${this.baseURL}${reportLinks[0].substring(1)}`;
      console.log('  → Loading financial statements...');
      await page.goto(reportUrl, { waitUntil: 'networkidle' });

      // 8. Extract financial data
      console.log('  → Extracting financial data tables...');
      const financialData = await this.extractFinancialData(page);

      if (!financialData) {
        return null;
      }

      return {
        companyName,
        registrationNumber: companyInfo.registrationNumber,
        taxNumber: companyInfo.taxNumber,
        headquarter: companyInfo.headquarter,
        year: targetYear,
        currency: financialData.currency,
        unit: financialData.unit,
        filingDate: financialData.filingDate,
        incomeStatement: financialData.incomeStatement,
        balanceSheet: financialData.balanceSheet,
        extractedAt: new Date().toISOString(),
        sourceURL: page.url()
      };

    } catch (error) {
      console.error('  ! Scraping error:', error instanceof Error ? error.message : error);
      return null;
    } finally {
      await page.close();
    }
  }

  private async extractFinancialData(page: Page) {
    return await page.evaluate(() => {
      interface RowData {
        rowNumber: string;
        itemCode: string;
        itemName: string;
        previousYearData: number | string;
        amendments: number | string;
        targetYearData: number | string;
      }

      const parseValue = (text: string): number | string => {
        if (!text || text.trim() === '—') return '—';
        const cleaned = text
          .trim()
          .replace(/\s+/g, '')
          .replace(/\.(\d{0,2})$/g, '')
          .replace(/\./g, '')
          .replace(',', '.');
        const num = parseFloat(cleaned);
        return isNaN(num) ? text.trim() : num;
      };

      const pageText = document.body.innerText;

      // Extract metadata
      const filingMatch = pageText.match(/Elfogadás időpontja:\s*(\d{4}\.\s*[a-zá-ú]+\s*\d{1,2}\.)/i);
      const filingDate = filingMatch ? filingMatch[1] : '';

      const currencyMatch = pageText.match(/Pénznem:\s*(HUF|EUR|USD)/);
      const currency = currencyMatch ? currencyMatch[1] : 'HUF';

      const unitMatch = pageText.match(/Pénzegység:\s*(ezer|millió)/);
      const unit = unitMatch ? unitMatch[1] : 'ezer';

      // Extract Income Statement
      const incomeStatementRows: RowData[] = [];
      const balanceSheetRows: RowData[] = [];

      const tables = document.querySelectorAll('table');

      tables.forEach((table: HTMLTableElement) => {
        const headerText = table.innerText;

        if (headerText.includes('EREDMÉNYKIMUTATÁSA')) {
          // Extract Income Statement
          const rows = table.querySelectorAll('tbody tr');
          rows.forEach((rowEl) => {
            const row = rowEl as HTMLTableRowElement;
            const cells = row.querySelectorAll('td');
            if (cells.length >= 4) {
              const text = row.innerText.toLowerCase();
              if (text.includes('előző üzleti év') || text.includes('lezárt üzleti')) {
                return;
              }

              const rowNumber = cells[0]?.innerText.trim() || '';
              const itemCode = cells[1]?.innerText.trim() || '';
              const itemName = cells[2]?.innerText.trim() || '';
              const previousYear = parseValue(cells[3]?.innerText || '0');
              const amendments = cells.length > 5 ? parseValue(cells[4]?.innerText || '—') : '—';
              const targetYear = parseValue(cells[cells.length - 1]?.innerText || '0');

              if (rowNumber && itemName) {
                incomeStatementRows.push({
                  rowNumber,
                  itemCode,
                  itemName,
                  previousYearData: previousYear,
                  amendments,
                  targetYearData: targetYear
                });
              }
            }
          });
        }

        if (headerText.includes('MÉRLEGE')) {
          // Extract Balance Sheet
          const rows = table.querySelectorAll('tbody tr');
          rows.forEach((rowEl) => {
            const row = rowEl as HTMLTableRowElement;
            const cells = row.querySelectorAll('td');
            if (cells.length >= 4) {
              const text = row.innerText.toLowerCase();
              if (text.includes('előző üzleti év') || text.includes('lezárt üzleti')) {
                return;
              }

              const rowNumber = cells[0]?.innerText.trim() || '';
              const itemCode = cells[1]?.innerText.trim() || '';
              const itemName = cells[2]?.innerText.trim() || '';
              const previousYear = parseValue(cells[3]?.innerText || '0');
              const amendments = cells.length > 5 ? parseValue(cells[4]?.innerText || '—') : '—';
              const targetYear = parseValue(cells[cells.length - 1]?.innerText || '0');

              if (rowNumber && itemName) {
                balanceSheetRows.push({
                  rowNumber,
                  itemCode,
                  itemName,
                  previousYearData: previousYear,
                  amendments,
                  targetYearData: targetYear
                });
              }
            }
          });
        }
      });

      return {
        filingDate,
        currency,
        unit,
        incomeStatement: { rows: incomeStatementRows },
        balanceSheet: { rows: balanceSheetRows }
      };
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Export to JSON
  exportToJSON(reports: CompanyFinancialReport[], outputPath: string): void {
    fs.writeFileSync(outputPath, JSON.stringify(reports, null, 2), 'utf-8');
    console.log(`✓ JSON exported to: ${outputPath}`);
  }

  // Export Income Statements to CSV
  exportIncomeStatementToCSV(reports: CompanyFinancialReport[], outputPath: string): void {
    const headers = [
      'Company Name',
      'Registration Number',
      'Year',
      'Row Number',
      'Item Code',
      'Item Name',
      'Previous Year',
      'Amendments',
      'Target Year'
    ];

    const rows: string[] = [headers.join(',')];

    for (const report of reports) {
      for (const row of report.incomeStatement.rows) {
        rows.push([
          `"${report.companyName}"`,
          `"${report.registrationNumber}"`,
          report.year,
          `"${row.rowNumber}"`,
          `"${row.itemCode}"`,
          `"${row.itemName}"`,
          row.previousYearData,
          row.amendments,
          row.targetYearData
        ].join(','));
      }
    }

    fs.writeFileSync(outputPath, rows.join('\n'), 'utf-8');
    console.log(`✓ Income Statement CSV exported to: ${outputPath}`);
  }

  // Export Balance Sheets to CSV
  exportBalanceSheetToCSV(reports: CompanyFinancialReport[], outputPath: string): void {
    const headers = [
      'Company Name',
      'Registration Number',
      'Year',
      'Row Number',
      'Item Code',
      'Item Name',
      'Previous Year',
      'Amendments',
      'Target Year'
    ];

    const rows: string[] = [headers.join(',')];

    for (const report of reports) {
      for (const row of report.balanceSheet.rows) {
        rows.push([
          `"${report.companyName}"`,
          `"${report.registrationNumber}"`,
          report.year,
          `"${row.rowNumber}"`,
          `"${row.itemCode}"`,
          `"${row.itemName}"`,
          row.previousYearData,
          row.amendments,
          row.targetYearData
        ].join(','));
      }
    }

    fs.writeFileSync(outputPath, rows.join('\n'), 'utf-8');
    console.log(`✓ Balance Sheet CSV exported to: ${outputPath}`);
  }

  // Export summary to CSV
  exportSummaryToCSV(reports: CompanyFinancialReport[], outputPath: string): void {
    const headers = [
      'Company Name',
      'Registration Number',
      'Tax Number',
      'Headquarter',
      'Year',
      'Currency',
      'Unit',
      'Filing Date',
      'Income Statement Rows',
      'Balance Sheet Rows',
      'Extracted At',
      'Source URL'
    ];

    const rows: string[] = [headers.join(',')];

    for (const report of reports) {
      rows.push([
        `"${report.companyName}"`,
        `"${report.registrationNumber}"`,
        `"${report.taxNumber}"`,
        `"${report.headquarter}"`,
        report.year,
        `"${report.currency}"`,
        `"${report.unit}"`,
        `"${report.filingDate}"`,
        report.incomeStatement.rows.length,
        report.balanceSheet.rows.length,
        `"${report.extractedAt}"`,
        `"${report.sourceURL}"`
      ].join(','));
    }

    fs.writeFileSync(outputPath, rows.join('\n'), 'utf-8');
    console.log(`✓ Summary CSV exported to: ${outputPath}`);
  }
}

// ==================== MAIN EXECUTION ====================

async function main() {
  const scraper = new EBeszamoloScraper();

  // Example companies to scrape
  const companies = [
    'OTP Bank Nyrt',
    'MOL Nyrt',
    'Richter Gedeon Nyrt'
  ];

  try {
    await scraper.initialize();

    console.log('\n========================================');
    console.log('E-Beszámolo Financial Data Scraper');
    console.log('========================================\n');

    const reports = await scraper.scrapeCompanies(companies, 2024);

    if (reports.length > 0) {
      // Export results
      const timestamp = new Date().toISOString().split('T')[0];

      scraper.exportToJSON(reports, `results/financial_reports_${timestamp}.json`);
      scraper.exportIncomeStatementToCSV(reports, `results/income_statements_${timestamp}.csv`);
      scraper.exportBalanceSheetToCSV(reports, `results/balance_sheets_${timestamp}.csv`);
      scraper.exportSummaryToCSV(reports, `results/summary_${timestamp}.csv`);

      console.log('\n========================================');
      console.log(`✓ Scraping completed! ${reports.length}/${companies.length} companies processed.`);
      console.log('========================================');
    } else {
      console.log('\n✗ No data was extracted.');
    }

  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    await scraper.close();
  }
}

main();
