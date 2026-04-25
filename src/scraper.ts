import { chromium, Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import { CompanyFinancialReport } from './types';
import { normalizeCompanyName } from './utils';

interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export class EBeszamoloScraper {
  private browser: Browser | null = null;
  private readonly baseURL = 'https://e-beszamolo.im.gov.hu';
  private termsAccepted = false;
  private proxyConfig: ProxyConfig | null = null;

  async initialize(options?: { proxy?: ProxyConfig }) {
    // Check for proxy from options or environment variables
    if (options?.proxy) {
      this.proxyConfig = options.proxy;
    } else if (process.env.PROXY_SERVER) {
      this.proxyConfig = {
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD
      };
    }

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled']
    };

    if (this.proxyConfig) {
      launchOptions.proxy = {
        server: this.proxyConfig.server,
        username: this.proxyConfig.username,
        password: this.proxyConfig.password
      };
      console.log(`✓ Using proxy: ${this.proxyConfig.server}`);
    }

    this.browser = await chromium.launch(launchOptions);
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
        const normalizedName = normalizeCompanyName(companyName);
        const report = await this.scrapeCompany({ type: 'name', value: normalizedName }, targetYear, companyName);
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

  async scrapeSingleCompany(
    companyName: string,
    targetYear: number = 2024
  ): Promise<CompanyFinancialReport | null> {
    console.log(`\nProcessing: ${companyName}`);
    const normalizedName = normalizeCompanyName(companyName);
    console.log(`Normalized name: ${normalizedName}`);

    try {
      const report = await this.scrapeCompany({ type: 'name', value: normalizedName }, targetYear, companyName);
      if (report) {
        console.log(`✓ Successfully scraped: ${companyName}`);
        return report;
      }
    } catch (error) {
      console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
    }

    return null;
  }

  async scrapeByTaxNumber(
    taxNumber: string,
    targetYear: number = 2024
  ): Promise<CompanyFinancialReport | null> {
    // Extract first 8 digits of tax number
    const taxNumberClean = taxNumber.replace(/[^0-9]/g, '').substring(0, 8);
    console.log(`\nProcessing tax number: ${taxNumberClean}`);

    try {
      const report = await this.scrapeCompany({ type: 'taxNumber', value: taxNumberClean }, targetYear);
      if (report) {
        console.log(`✓ Successfully scraped: ${report.companyName}`);
        return report;
      }
    } catch (error) {
      console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
    }

    return null;
  }

  async scrapeCompaniesByTaxNumbers(
    taxNumbers: string[],
    targetYear: number = 2024
  ): Promise<CompanyFinancialReport[]> {
    const results: CompanyFinancialReport[] = [];

    for (let i = 0; i < taxNumbers.length; i++) {
      const taxNumber = taxNumbers[i];
      console.log(`\n[${i + 1}/${taxNumbers.length}] Processing tax number: ${taxNumber}`);

      try {
        const report = await this.scrapeByTaxNumber(taxNumber, targetYear);
        if (report) {
          results.push(report);
        }
      } catch (error) {
        console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
      }

      await this.delay(2000);
    }

    return results;
  }

  private async scrapeCompany(
    search: { type: 'name' | 'taxNumber'; value: string },
    targetYear: number,
    originalName?: string
  ): Promise<CompanyFinancialReport | null> {
    const page = await this.browser!.newPage();

    try {
      // 1. Navigate to search page
      console.log('  → Navigating to search page...');
      await page.goto(`${this.baseURL}/oldal/beszamolo_kereses`, {
        waitUntil: 'networkidle'
      });

      // 2. Helper to fill and submit search form
      const fillAndSubmit = async () => {
        if (search.type === 'taxNumber') {
          console.log('  → Searching by tax number...');
          await page.fill('input#firmTaxNumber', search.value);
        } else {
          console.log('  → Searching by company name...');
          await page.fill('input#firmName', search.value);
        }
        await this.solveCaptchaIfPresent(page);
        await page.click('button#btnSubmit');
      };

      await fillAndSubmit();

      // 3. Handle terms acceptance popup (first time only)
      const popupHandled = await this.handleTermsPopup(page);

      // If popup was handled, the form was reset - need to re-submit
      if (popupHandled) {
        await fillAndSubmit();
        await this.delay(2000); // Wait for results to load after re-submit
      }

      // 4. Wait for results table - look for link in any table row that's not the search form
      await page.waitForSelector('table tbody tr td a[href="#"]', { timeout: 15000 });
      await this.delay(1000);

      // 5. Find best matching result
      // For both tax number and name search, prefer rows with fewer historical names
      const bestMatch = await page.evaluate((args: { searchTerm: string; isTaxSearch: boolean }) => {
          const { searchTerm, isTaxSearch } = args;
          // Find the results table by looking for a table with "Cégnév" header
          const tables = Array.from(document.querySelectorAll('table'));
          const resultsTable = tables.find(t => t.querySelector('th')?.textContent?.includes('Cégnév'));
          if (!resultsTable) return { found: false, index: 0, debug: [] };
          const rows = Array.from(resultsTable.querySelectorAll('tbody tr'));

          // Collect all rows with their name count
          const allRows: { index: number; nameCount: number; exact: boolean }[] = [];

          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const firstCell = row.querySelector('td:first-child');
            if (!firstCell) continue;

            const link = firstCell.querySelector('a');
            if (!link) continue;

            // Count names by counting <br> tags + 1 (names are separated by <br>)
            const brCount = link.querySelectorAll('br').length;
            const nameCount = brCount + 1;
            allRows.push({ index: i, nameCount, exact: false });
          }

          // For tax number search: prefer row with fewest names (likely the current/active company)
          if (isTaxSearch) {
            if (allRows.length === 0) return { found: false, index: 0, debug: [] };
            // Sort by nameCount ascending (fewer names = better)
            allRows.sort((a, b) => a.nameCount - b.nameCount);
            return { found: true, index: allRows[0].index, debug: allRows };
          }

          // For name search: match by company name
          const searchUpper = searchTerm.toUpperCase();

          // Common company suffixes to strip for comparison
          const suffixes = ['KFT', 'KFT.', 'ZRT', 'ZRT.', 'NYRT', 'NYRT.', 'BT', 'BT.',
                          'KKT', 'KKT.', 'RT', 'RT.', 'KORLÁTOLT FELELŐSSÉGŰ TÁRSASÁG',
                          'ZÁRTKÖRŰEN MŰKÖDŐ RÉSZVÉNYTÁRSASÁG', 'BETÉTI TÁRSASÁG'];

          const stripSuffix = (name: string): string => {
            let result = name.toUpperCase().trim();
            for (const suffix of suffixes) {
              if (result.endsWith(suffix)) {
                result = result.slice(0, -suffix.length).trim();
              }
            }
            return result;
          };

          const searchStripped = stripSuffix(searchUpper);
          const matches: { index: number; nameCount: number; exact: boolean }[] = [];

          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const firstCell = row.querySelector('td:first-child');
            if (!firstCell) continue;

            const link = firstCell.querySelector('a');
            if (!link) continue;

            const cellText = firstCell.textContent || '';
            const names = cellText.split('\n').map((l: string) => l.trim()).filter((l: string) => l);

            // Check each name in this row - first look for exact matches
            let foundExact = false;
            for (const name of names) {
              const nameStripped = stripSuffix(name);
              if (nameStripped === searchStripped) {
                matches.push({ index: i, nameCount: names.length, exact: true });
                foundExact = true;
                break;
              }
            }
            // If no exact match, check for startsWith
            if (!foundExact) {
              for (const name of names) {
                const nameStripped = stripSuffix(name);
                if (nameStripped.startsWith(searchStripped)) {
                  matches.push({ index: i, nameCount: names.length, exact: false });
                  break;
                }
              }
            }
          }

          if (matches.length > 0) {
            // Sort: prefer exact matches first, then by fewer names
            matches.sort((a, b) => {
              if (a.exact !== b.exact) return a.exact ? -1 : 1;
              return a.nameCount - b.nameCount;  // Prefer fewer historical names
            });
            return { found: true, index: matches[0].index, debug: matches };
          }

          // Fallback: return last row (usually most recent)
          return { found: false, index: rows.length - 1, debug: [] };
        }, { searchTerm: search.value, isTaxSearch: search.type === 'taxNumber' });

      // Debug output
      if ('debug' in bestMatch && Array.isArray(bestMatch.debug)) {
        console.log(`  [Debug] Matches found: ${JSON.stringify(bestMatch.debug)}`);
      }

      // Get the result link directly using the index from bestMatch
      const resultLinks = await page.$$('table:has(th:text("Cégnév")) tbody tr td:first-child a');
      if (resultLinks.length === 0) {
        console.log('  ✗ No search results found');
        return null;
      }

      const resultLink = resultLinks[bestMatch.index];

      if (!resultLink) {
        console.log('  ✗ No search results found');
        return null;
      }

      if (!bestMatch.found) {
        console.log('  ⚠ No exact match found, using last result (most recent)');
      }

      await resultLink.click();
      await page.waitForLoadState('networkidle');

      // 6. Extract company info from the list page
      console.log('  → Extracting company information...');
      const companyInfo = await page.evaluate(() => {
        const text = document.body.innerText;
        // Extract company name from "Cég neve:" field
        const nameMatch = text.match(/Cég neve:\s*([^\n\t]+)/);
        // Try both formats: "Cégjegyzékszáma:" and "Nyilvántartási szám:"
        const regMatch = text.match(/(?:Cégjegyzékszáma|Nyilvántartási szám):\s*(\d{2}-\d{2}-\d{6})/);
        const taxMatch = text.match(/Adószám:\s*([\d-]+)/);
        const hqMatch = text.match(/Székhely:\s*([^\n]+)/);

        return {
          companyName: nameMatch ? nameMatch[1].trim() : '',
          registrationNumber: regMatch ? regMatch[1] : '',
          taxNumber: taxMatch ? taxMatch[1] : '',
          headquarter: hqMatch ? hqMatch[1].trim() : ''
        };
      });

      // 7. Find and click on the report for the target year
      console.log(`  → Looking for financial reports for year ${targetYear}...`);

      // Keressük meg a megfelelő évre vonatkozó beszámolót
      const reportSearchResult = await page.evaluate((year: number) => {
        // Keressük a balance-container div-eket
        const containers = document.querySelectorAll('div.balance-container');

        // Gyűjtsük össze az elérhető éveket
        const availableYears: number[] = [];

        for (const container of Array.from(containers)) {
          const containerText = container.textContent || '';

          // Keressük az évszámot a december 31. előtt
          const yearMatch = containerText.match(/(\d{4})\.\s*december\s*31/i);
          if (yearMatch) {
            availableYears.push(parseInt(yearMatch[1]));
          }

          // Keressük a tárgyév mintáját: "YYYY. december 31."
          const yearPattern = new RegExp(`${year}\\.\\s*december\\s*31`, 'i');
          if (yearPattern.test(containerText)) {
            // Megtaláltuk - keressük meg benne a beszámoló linket
            const link = container.querySelector('a.view-obr-balance-link');
            if (link) {
              return {
                found: true,
                selector: 'a.view-obr-balance-link[data-code="' + link.getAttribute('data-code') + '"]',
                availableYears
              };
            }
          }
        }

        // Nem találtuk meg a keresett évet
        return {
          found: false,
          selector: null,
          availableYears: [...new Set(availableYears)].sort((a, b) => b - a)
        };
      }, targetYear);

      if (!reportSearchResult.found || !reportSearchResult.selector) {
        const yearsText = reportSearchResult.availableYears.length > 0
          ? `Elérhető évek: ${reportSearchResult.availableYears.join(', ')}`
          : 'Nincs elérhető beszámoló';
        console.log(`  ✗ No report found for year ${targetYear}. ${yearsText}`);
        throw new Error(`A ${targetYear}. évre nincs elérhető beszámoló. ${yearsText}`);
      }

      await page.click(reportSearchResult.selector);
      await page.waitForLoadState('networkidle');
      await this.delay(1000);

      // 8. Extract financial data from the report page
      console.log('  → Extracting financial data tables...');
      const financialData = await this.extractFinancialData(page);

      if (!financialData) {
        return null;
      }

      return {
        companyName: originalName || companyInfo.companyName || financialData.companyName || search.value,
        registrationNumber: companyInfo.registrationNumber || financialData.registrationNumber,
        taxNumber: companyInfo.taxNumber || financialData.taxNumber,
        headquarter: companyInfo.headquarter || financialData.headquarter,
        year: targetYear,
        previousYear: financialData.extractedPreviousYear || targetYear - 1,
        targetYear: financialData.extractedTargetYear || targetYear,
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

  private async solveCaptchaIfPresent(page: Page, timeoutMs = 30000): Promise<void> {
    const widget = await page.$('altcha-widget');
    if (!widget) return;

    console.log('  → ALTCHA widget detected, triggering proof-of-work...');

    await page.click('altcha-widget input[type="checkbox"]');

    try {
      await page.waitForSelector('altcha-widget .altcha[data-state="verified"]', { timeout: timeoutMs });
      console.log('  → ✓ ALTCHA verified');
    } catch {
      console.log('  → ⚠ ALTCHA verification did not complete within timeout');
    }

    await this.delay(300);
  }

  private async handleTermsPopup(page: Page): Promise<boolean> {
    if (this.termsAccepted) {
      return false;
    }

    try {
      // Check if terms popup is visible
      const checkbox = await page.$('#acceptCheck', { strict: true });
      if (checkbox) {
        console.log('  → Accepting terms and conditions...');
        await checkbox.click();
        await this.delay(300);

        const submitButton = await page.$('button:has-text("Tovább")');
        if (submitButton) {
          await submitButton.click();
          await this.delay(1000);
        }

        this.termsAccepted = true;
        return true; // Popup was handled
      }
    } catch {
      // Popup not present, continue
    }
    return false;
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
        if (!text || text.trim() === '' || text.trim() === '—') return 0;
        const cleaned = text
          .trim()
          .replace(/\s+/g, '')
          .replace(/\./g, '')  // Remove thousand separators
          .replace(',', '.');   // Convert decimal comma to dot
        const num = parseFloat(cleaned);
        return isNaN(num) ? text.trim() : num;
      };

      const pageText = document.body.innerText;

      // Extract metadata
      const filingMatch = pageText.match(/Elfogadás időpontja:\s*(\d{4}\.\s*[a-zá-ű]+\s*\d{1,2}\.?)/i);
      const filingDate = filingMatch ? filingMatch[1] : '';

      const currencyMatch = pageText.match(/Pénznem:\s*(HUF|EUR|USD)/);
      const currency = currencyMatch ? currencyMatch[1] : 'HUF';

      const unitMatch = pageText.match(/Pénzegység:\s*(ezer|millió)/);
      const unit = unitMatch ? unitMatch[1] : 'ezer';

      // Extract company info from report page
      const companyNameMatch = pageText.match(/A cég elnevezése:\s*([^\n\t]+)/);
      const companyName = companyNameMatch ? companyNameMatch[1].trim() : '';

      const regMatch = pageText.match(/Nyilvántartási száma?:\s*(\d{2}-\d{2}-\d{6})/);
      const registrationNumber = regMatch ? regMatch[1] : '';

      const taxMatch = pageText.match(/Adószáma?:\s*([\d-]+)/);
      const taxNumber = taxMatch ? taxMatch[1] : '';

      const hqMatch = pageText.match(/Székhely:\s*([^\n]+)/);
      const headquarter = hqMatch ? hqMatch[1].trim() : '';

      // Évszámok kinyerése a beszámoló időszakból
      // Keressük a mintát: "YYYY. január 01. - YYYY. december 31." vagy hasonló
      let extractedPreviousYear = 0;
      let extractedTargetYear = 0;

      const periodMatch = pageText.match(/(\d{4})\.\s*január\s*\d{1,2}\.\s*-\s*(\d{4})\.\s*december\s*\d{1,2}\./i);
      if (periodMatch) {
        extractedPreviousYear = parseInt(periodMatch[1]) - 1; // Előző év = tárgyév - 1
        extractedTargetYear = parseInt(periodMatch[2]);
      }

      // Extract Income Statement and Balance Sheet
      const incomeStatementRows: RowData[] = [];
      const balanceSheetRows: RowData[] = [];

      const tables = document.querySelectorAll('table');

      tables.forEach((table: HTMLTableElement) => {
        const tableText = table.innerText.toUpperCase();

        // Check if this is Balance Sheet table (MÉRLEGE)
        if (tableText.includes('MÉRLEGE')) {
          const rows = table.querySelectorAll('tbody tr');
          rows.forEach((rowEl) => {
            const row = rowEl as HTMLTableRowElement;
            const cells = row.querySelectorAll('td');

            // Skip header rows and rows with insufficient cells
            if (cells.length < 3) return;

            const rowText = row.innerText.toLowerCase();
            if (rowText.includes('sorszám') ||
                rowText.includes('előző üzleti év') ||
                rowText.includes('tételsor elnevezése') ||
                rowText.includes('lezárt üzleti év')) {
              return;
            }

            const rowNumber = cells[0]?.innerText.trim() || '';
            const itemName = cells[1]?.innerText.trim() || '';

            // Skip if no valid row number (like "001.", "002.", etc.)
            if (!rowNumber.match(/^\d{3}\.?$/)) return;

            let previousYear: number | string = 0;
            let amendments: number | string = '—';
            let targetYear: number | string = 0;

            if (cells.length === 5) {
              // Has amendments column
              previousYear = parseValue(cells[2]?.innerText || '0');
              amendments = parseValue(cells[3]?.innerText || '—');
              targetYear = parseValue(cells[4]?.innerText || '0');
            } else if (cells.length >= 3) {
              // No amendments column or different structure
              previousYear = parseValue(cells[2]?.innerText || '0');
              targetYear = parseValue(cells[cells.length - 1]?.innerText || '0');
            }

            if (rowNumber && itemName) {
              balanceSheetRows.push({
                rowNumber: rowNumber.replace('.', ''),
                itemCode: '',
                itemName,
                previousYearData: previousYear,
                amendments,
                targetYearData: targetYear
              });
            }
          });
        }

        // Check if this is Income Statement table (EREDMÉNYKIMUTATÁS)
        if (tableText.includes('EREDMÉNYKIMUTATÁS')) {
          const rows = table.querySelectorAll('tbody tr');
          rows.forEach((rowEl) => {
            const row = rowEl as HTMLTableRowElement;
            const cells = row.querySelectorAll('td');

            // Skip header rows and rows with insufficient cells
            if (cells.length < 3) return;

            const rowText = row.innerText.toLowerCase();
            if (rowText.includes('sorszám') ||
                rowText.includes('előző üzleti év') ||
                rowText.includes('tételsor elnevezése') ||
                rowText.includes('lezárt üzleti év')) {
              return;
            }

            const rowNumber = cells[0]?.innerText.trim() || '';
            const itemName = cells[1]?.innerText.trim() || '';

            // Skip if no valid row number (like "001.", "002.", etc.)
            if (!rowNumber.match(/^\d{3}\.?$/)) return;

            let previousYear: number | string = 0;
            let amendments: number | string = '—';
            let targetYear: number | string = 0;

            if (cells.length === 5) {
              // Has amendments column
              previousYear = parseValue(cells[2]?.innerText || '0');
              amendments = parseValue(cells[3]?.innerText || '—');
              targetYear = parseValue(cells[4]?.innerText || '0');
            } else if (cells.length >= 3) {
              // No amendments column or different structure
              previousYear = parseValue(cells[2]?.innerText || '0');
              targetYear = parseValue(cells[cells.length - 1]?.innerText || '0');
            }

            if (rowNumber && itemName) {
              incomeStatementRows.push({
                rowNumber: rowNumber.replace('.', ''),
                itemCode: '',
                itemName,
                previousYearData: previousYear,
                amendments,
                targetYearData: targetYear
              });
            }
          });
        }
      });

      return {
        companyName,
        filingDate,
        currency,
        unit,
        registrationNumber,
        taxNumber,
        headquarter,
        extractedPreviousYear,
        extractedTargetYear,
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

  // Export single report to JSON
  exportSingleToJSON(report: CompanyFinancialReport, outputPath: string): void {
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`✓ JSON exported to: ${outputPath}`);
  }

  // Export Income Statements to CSV
  exportIncomeStatementToCSV(reports: CompanyFinancialReport[], outputPath: string): void {
    // Build headers dynamically based on first report's years
    const firstReport = reports[0];
    const prevYearLabel = firstReport?.previousYear || 'Previous Year';
    const targetYearLabel = firstReport?.targetYear || 'Target Year';

    const headers = [
      'Cégnév',
      'Cégjegyzékszám',
      'Beszámoló éve',
      'Sorszám',
      'Megnevezés',
      prevYearLabel.toString(),
      'Módosítások',
      targetYearLabel.toString()
    ];

    // UTF-8 BOM for Excel compatibility
    const rows: string[] = [headers.join(',')];

    for (const report of reports) {
      for (const row of report.incomeStatement.rows) {
        rows.push([
          `"${report.companyName}"`,
          `"${report.registrationNumber}"`,
          report.year,
          `"${row.rowNumber}"`,
          `"${row.itemName}"`,
          row.previousYearData,
          row.amendments,
          row.targetYearData
        ].join(','));
      }
    }

    const csvContent = '\uFEFF' + rows.join('\n');
    fs.writeFileSync(outputPath, csvContent, 'utf-8');
    console.log(`✓ Income Statement CSV exported to: ${outputPath}`);
  }

  // Export Balance Sheets to CSV
  exportBalanceSheetToCSV(reports: CompanyFinancialReport[], outputPath: string): void {
    // Build headers dynamically based on first report's years
    const firstReport = reports[0];
    const prevYearLabel = firstReport?.previousYear || 'Previous Year';
    const targetYearLabel = firstReport?.targetYear || 'Target Year';

    const headers = [
      'Cégnév',
      'Cégjegyzékszám',
      'Beszámoló éve',
      'Sorszám',
      'Megnevezés',
      prevYearLabel.toString(),
      'Módosítások',
      targetYearLabel.toString()
    ];

    // UTF-8 BOM for Excel compatibility
    const rows: string[] = [headers.join(',')];

    for (const report of reports) {
      for (const row of report.balanceSheet.rows) {
        rows.push([
          `"${report.companyName}"`,
          `"${report.registrationNumber}"`,
          report.year,
          `"${row.rowNumber}"`,
          `"${row.itemName}"`,
          row.previousYearData,
          row.amendments,
          row.targetYearData
        ].join(','));
      }
    }

    const csvContent = '\uFEFF' + rows.join('\n');
    fs.writeFileSync(outputPath, csvContent, 'utf-8');
    console.log(`✓ Balance Sheet CSV exported to: ${outputPath}`);
  }

  // Export summary to CSV
  exportSummaryToCSV(reports: CompanyFinancialReport[], outputPath: string): void {
    const headers = [
      'Cégnév',
      'Cégjegyzékszám',
      'Adószám',
      'Székhely',
      'Beszámoló éve',
      'Előző év',
      'Tárgyév',
      'Pénznem',
      'Egység',
      'Benyújtás dátuma',
      'Eredménykimutatás sorok',
      'Mérleg sorok',
      'Lekérdezve',
      'Forrás URL'
    ];

    // UTF-8 BOM for Excel compatibility
    const rows: string[] = [headers.join(',')];

    for (const report of reports) {
      rows.push([
        `"${report.companyName}"`,
        `"${report.registrationNumber}"`,
        `"${report.taxNumber}"`,
        `"${report.headquarter}"`,
        report.year,
        report.previousYear,
        report.targetYear,
        `"${report.currency}"`,
        `"${report.unit}"`,
        `"${report.filingDate}"`,
        report.incomeStatement.rows.length,
        report.balanceSheet.rows.length,
        `"${report.extractedAt}"`,
        `"${report.sourceURL}"`
      ].join(','));
    }

    const csvContent = '\uFEFF' + rows.join('\n');
    fs.writeFileSync(outputPath, csvContent, 'utf-8');
    console.log(`✓ Summary CSV exported to: ${outputPath}`);
  }
}
