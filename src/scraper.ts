import { chromium, Browser, Page, BrowserContext } from 'playwright-core';
import Browserbase from '@browserbasehq/sdk';
import * as fs from 'fs';
import { CompanyFinancialReport } from './types';
import { normalizeCompanyName } from './utils';

interface InitOptions {
  useBrowserbase?: boolean;  // Default: true if BROWSERBASE_API_KEY is set
  headless?: boolean;
}

export class EBeszamoloScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private bb: Browserbase | null = null;
  private sessionId: string | null = null;
  private readonly baseURL = 'https://e-beszamolo.im.gov.hu';
  private useBrowserbase = false;

  async initialize(options?: InitOptions) {
    // Determine if we should use Browserbase
    const hasBrowserbaseConfig = !!(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID);
    this.useBrowserbase = options?.useBrowserbase ?? hasBrowserbaseConfig;

    if (this.useBrowserbase && hasBrowserbaseConfig) {
      // Use Browserbase
      this.bb = new Browserbase({
        apiKey: process.env.BROWSERBASE_API_KEY!,
      });

      // Proxy options:
      // - false: no proxy (direct connection from Browserbase datacenter)
      // - true: US residential proxy
      // - [{ type: 'browserbase', geolocation: { country: 'HU' } }]: Hungarian residential proxy
      // Default: Hungarian proxy ON (e-beszamolo works better with Hungarian IP)
      // Set BROWSERBASE_PROXY=false to disable
      const useProxy = process.env.BROWSERBASE_PROXY !== 'false';
      const proxyConfig = useProxy
        ? [{ type: 'browserbase' as const, geolocation: { country: 'HU' } }]
        : false;

      const session = await this.bb.sessions.create({
        projectId: process.env.BROWSERBASE_PROJECT_ID!,
        region: 'eu-central-1',  // Frankfurt - closest to Hungary
        proxies: proxyConfig,
        browserSettings: {
          fingerprint: {
            browsers: ['chrome'],
            devices: ['desktop'],
            operatingSystems: ['windows'],
            locales: ['hu-HU', 'hu'],  // Hungarian locale
          },
          viewport: {
            width: 1280,
            height: 720,
          },
        },
      });

      this.sessionId = session.id;
      console.log(`✓ Browserbase session created: ${session.id}`);

      // Get live view URL
      const debugInfo = await this.bb.sessions.debug(session.id);
      console.log(`✓ Live view: ${debugInfo.debuggerFullscreenUrl}`);

      this.browser = await chromium.connectOverCDP(session.connectUrl);
      this.context = this.browser.contexts()[0];
      console.log('✓ Browser connected via Browserbase');
    } else {
      // Use local Chrome
      console.log('⚠ Browserbase not configured, using local Chrome');
      this.browser = await chromium.launch({
        headless: options?.headless ?? false,
        args: ['--disable-blink-features=AutomationControlled']
      });
      this.context = await this.browser.newContext();
      console.log('✓ Local browser launched');
    }
  }

  async close() {
    await this.browser?.close();
    console.log('✓ Browser closed');
  }

  // Reinitialize the browser session (for session timeout recovery)
  async reinitialize() {
    console.log('  → Reinitializing browser session...');
    try {
      await this.browser?.close();
    } catch {
      // Ignore close errors
    }
    await this.initialize({ useBrowserbase: this.useBrowserbase });
  }

  // Check if error indicates session has expired
  private isSessionExpiredError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('Target page, context or browser has been closed') ||
           msg.includes('Session closed') ||
           msg.includes('browser has been closed');
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

      await this.randomDelay(1500, 3500);
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

      await this.randomDelay(1500, 3500);
    }

    return results;
  }

  private async scrapeCompany(
    search: { type: 'name' | 'taxNumber'; value: string },
    targetYear: number,
    originalName?: string
  ): Promise<CompanyFinancialReport | null> {
    // ALWAYS create a new page for each scrape to avoid state issues
    // Close any existing pages first in Browserbase mode
    if (this.useBrowserbase) {
      const existingPages = this.context!.pages();
      for (const p of existingPages) {
        try {
          await p.close();
        } catch {
          // Ignore close errors
        }
      }
    }

    let page;
    try {
      page = await this.context!.newPage();
    } catch (error) {
      // Session expired - reinitialize and retry
      if (this.isSessionExpiredError(error)) {
        console.log('  ! Session expired, reinitializing...');
        await this.reinitialize();
        page = await this.context!.newPage();
      } else {
        throw error;
      }
    }

    try {
      // 1. Navigate to search page
      console.log('  → Navigating to search page...');
      await page.goto(`${this.baseURL}/oldal/beszamolo_kereses`, {
        waitUntil: 'networkidle'
      });

      // Check for IP block or access denied
      const pageText = await page.innerText('body').catch(() => '');
      const lowerText = pageText.toLowerCase();

      // Check for specific rate limit message from e-beszamolo
      // IMPORTANT: Only detect the ACTUAL rate limit message, not the general proxy warning on the page
      // The actual rate limit message is: "Túl sok kérés érkezett rövid időn belül az IP címről"
      // The normal page has a warning: "A rendszer a valós IP címet elrejtő Anonymous Proxy hálózatokból nem használható"
      // We must NOT trigger on the normal warning!
      const isRateLimited = lowerText.includes('túl sok kérés érkezett rövid időn belül');

      if (isRateLimited) {
        console.error('  ⛔ RATE LIMITED!');
        // Wait random time (45-75s) and reinitialize with new session/IP
        const waitTime = Math.floor(Math.random() * 30000) + 45000;
        console.log(`  → Waiting ${Math.round(waitTime/1000)}s before retry with new session...`);
        await this.delay(waitTime);
        await this.reinitialize();
        throw new Error('RATE_LIMITED: Too many requests, session reinitialized');
      }

      // Wait for search form to be ready
      await page.waitForSelector('input#firmTaxNumber', { timeout: 15000 });

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

      // Check for rate limit AFTER search submission (can appear after clicking search)
      await this.delay(1000); // Wait for any rate limit message to appear
      const postSearchText = await page.innerText('body').catch(() => '');
      if (postSearchText.toLowerCase().includes('túl sok kérés érkezett rövid időn belül')) {
        console.error('  ⛔ RATE LIMITED after search!');
        const waitTime = Math.floor(Math.random() * 30000) + 45000;
        console.log(`  → Waiting ${Math.round(waitTime/1000)}s before retry with new session...`);
        await this.delay(waitTime);
        await this.reinitialize();
        throw new Error('RATE_LIMITED: Too many requests, session reinitialized');
      }

      // 4. Wait for results table - look for link in any table row that's not the search form
      // Use longer timeout and retry logic for slow connections (e.g., proxy)
      let resultFound = false;
      for (let attempt = 0; attempt < 3 && !resultFound; attempt++) {
        try {
          await page.waitForSelector('table tbody tr td a[href="#"]', { timeout: 20000 });
          resultFound = true;
        } catch {
          if (attempt < 2) {
            console.log(`  → Retry ${attempt + 1}/2: waiting for search results...`);
            await this.delay(2000);
          } else {
            throw new Error('Search results not found after 3 attempts');
          }
        }
      }
      await this.delay(1000);

      // 5. Get all result indices and sort them
      const resultIndices = await page.evaluate((args: { searchTerm: string; isTaxSearch: boolean }) => {
          const { searchTerm, isTaxSearch } = args;
          // Find the results table by looking for a table with "Cégnév" header
          const tables = Array.from(document.querySelectorAll('table'));
          const resultsTable = tables.find(t => t.querySelector('th')?.textContent?.includes('Cégnév'));
          if (!resultsTable) return [];
          const rows = Array.from(resultsTable.querySelectorAll('tbody tr'));

          // Collect all rows with their name count
          const allRows: { index: number; nameCount: number }[] = [];

          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const firstCell = row.querySelector('td:first-child');
            if (!firstCell) continue;

            const link = firstCell.querySelector('a');
            if (!link) continue;

            // Count names by counting <br> tags + 1 (names are separated by <br>)
            const brCount = link.querySelectorAll('br').length;
            const nameCount = brCount + 1;
            allRows.push({ index: i, nameCount });
          }

          // For tax number search: try all results, starting with the most names
          // (more name changes = more likely to be the currently active company)
          if (isTaxSearch) {
            allRows.sort((a, b) => b.nameCount - a.nameCount);
            return allRows.map(r => r.index);
          }

          // For name search: return indices as-is (will be handled below)
          return allRows.map(r => r.index);
        }, { searchTerm: search.value, isTaxSearch: search.type === 'taxNumber' });

      if (resultIndices.length === 0) {
        console.log('  ✗ No search results found');
        return null;
      }

      console.log(`  [Debug] Found ${resultIndices.length} result(s), trying in order: ${resultIndices.join(', ')}`);

      // 6. Try each result until we find one with the target year
      let lastError: string | null = null;
      let lastCompanyInfo: { companyName: string; registrationNumber: string; taxNumber: string; headquarter: string } | null = null;

      for (const resultIndex of resultIndices) {
        // Get fresh result links (page might have been reset)
        const resultLinks = await page.$$('table:has(th:text("Cégnév")) tbody tr td:first-child a');
        if (resultLinks.length === 0) {
          console.log('  ✗ No search results found');
          return null;
        }

        const resultLink = resultLinks[resultIndex];
        if (!resultLink) continue;

        console.log(`  → Trying result #${resultIndex + 1}...`);
        await resultLink.click();
        await page.waitForLoadState('networkidle');

        // Wait for balance containers to load (they are loaded via JS)
        try {
          await page.waitForSelector('div.balance-container', { timeout: 10000 });
        } catch {
          // If no balance-container, try waiting for any report link
          try {
            await page.waitForSelector('a[href="#"]:has-text("záró")', { timeout: 5000 });
          } catch {
            // Continue anyway
          }
        }
        await this.delay(500); // Extra delay for JS rendering

        // Extract company info from the list page
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

        lastCompanyInfo = companyInfo;

        // Find and click on the report for the target year
        console.log(`  → Looking for financial reports for year ${targetYear}...`);

        // Keressük meg a megfelelő évre vonatkozó beszámolót
        const reportSearchResult = await page.evaluate((year: number) => {
          const availableYears: number[] = [];

          // Először próbáljuk a régi struktúrát (balance-container)
          const containers = document.querySelectorAll('div.balance-container');

          for (const container of Array.from(containers)) {
            const containerText = container.textContent || '';
            const yearMatch = containerText.match(/(\d{4})\.\s*december\s*31/i);
            if (yearMatch) {
              availableYears.push(parseInt(yearMatch[1]));
            }

            const yearPattern = new RegExp(`${year}\\.\\s*december\\s*31`, 'i');
            if (yearPattern.test(containerText)) {
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

          // Ha nem találtunk balance-container-t, próbáljuk az új struktúrát
          // Az új struktúrában a beszámolók generic div-ekben vannak,
          // a link szövege "Általános üzleti évet záró" vagy "ÜZLETI ÉVET ZÁRÓ"
          const allLinks = document.querySelectorAll('a[href="#"]');
          let foundLink: Element | null = null;
          let foundIndex = -1;

          for (let i = 0; i < allLinks.length; i++) {
            const link = allLinks[i];
            const linkText = link.textContent?.trim() || '';

            // Keressük a beszámoló linkeket
            // Robusztus keresés: elfogadjuk a link szöveget ha tartalmaz "évet záró" vagy "ÉVET ZÁRÓ" szöveget
            // (case insensitive és Unicode-barát)
            const isReportLink = /[üu]zleti\s+[ée]vet\s+z[aá]r[oó]/i.test(linkText) ||
                                 linkText.toUpperCase().includes('ÉVET ZÁRÓ') ||
                                 linkText.toLowerCase().includes('évet záró');
            if (isReportLink) {
              // Nézzük meg a környező szöveget, hogy tartalmazza-e a keresett évet
              const parent = link.parentElement;
              if (!parent) continue;

              const parentText = parent.textContent || '';

              // Keressük az évszámot: "YYYY. január 01. - YYYY. december 31."
              // Unicode-barát regex az ékezetes karakterekhez
              const yearRangeMatch = parentText.match(/(\d{4})\.\s*janu[aá]r\s*\d+\.\s*-\s*(\d{4})\.\s*december\s*31/i);
              if (yearRangeMatch) {
                const reportYear = parseInt(yearRangeMatch[2]);
                availableYears.push(reportYear);

                if (reportYear === year) {
                  foundLink = link;
                  foundIndex = i;
                }
              }
            }
          }

          if (foundLink && foundIndex >= 0) {
            // Adjunk egyedi azonosítót a linknek ha nincs
            const uniqueId = `report-link-${foundIndex}`;
            foundLink.setAttribute('data-report-id', uniqueId);
            return {
              found: true,
              selector: `a[data-report-id="${uniqueId}"]`,
              availableYears: [...new Set(availableYears)].sort((a, b) => b - a)
            };
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
          console.log(`  ✗ Result #${resultIndex + 1}: No report for year ${targetYear}. ${yearsText}`);
          lastError = `A ${targetYear}. évre nincs elérhető beszámoló. ${yearsText}`;

          // Go back to results page to try next result
          const currentResultIdx = resultIndices.indexOf(resultIndex);
          if (currentResultIdx < resultIndices.length - 1) {
            console.log(`  → Going back to try next result (${currentResultIdx + 2}/${resultIndices.length})...`);
            await page.goBack();
            await page.waitForLoadState('networkidle');
            await this.delay(1000); // Increased delay

            // Verify we're back on the results page
            const backOnResults = await page.$('table:has(th:text("Cégnév"))');
            if (!backOnResults) {
              console.log('  ! Not on results page, navigating back to search...');
              await page.goto(`${this.baseURL}/oldal/beszamolo_kereses`, { waitUntil: 'networkidle' });
              await page.waitForSelector('input#firmTaxNumber', { timeout: 15000 });
              await page.fill('input#firmTaxNumber', search.value);
              await this.solveCaptchaIfPresent(page);
              await page.click('button#btnSubmit');
              await page.waitForSelector('table tbody tr td a[href="#"]', { timeout: 20000 });
              await this.delay(1000);
            }
            continue; // Try next result
          }
          continue; // No more results to try
        }

        // Found the year! Extract the data
        await page.click(reportSearchResult.selector);
        await page.waitForLoadState('networkidle');

        // Wait for the financial tables to load - these are critical for data extraction
        console.log('  → Waiting for financial tables to load...');
        try {
          // Wait for either EREDMÉNYKIMUTATÁS or MÉRLEGE table to appear
          await page.waitForFunction(
            () => {
              const tables = Array.from(document.querySelectorAll('table'));
              for (const table of tables) {
                const text = (table as HTMLTableElement).innerText.toUpperCase();
                if (text.includes('EREDMÉNYKIMUTATÁS') || text.includes('MÉRLEGE')) {
                  // Also check that the table has actual data rows
                  const rows = table.querySelectorAll('tbody tr td');
                  if (rows.length > 10) return true;
                }
              }
              return false;
            },
            { timeout: 15000 }
          );
        } catch {
          console.log('  ! Warning: Financial tables not found after waiting');
        }
        await this.delay(500);

        // Extract financial data from the report page
        console.log('  → Extracting financial data tables...');
        const financialData = await this.extractFinancialData(page);

        if (!financialData) {
          continue; // Try next result
        }

        // Success! Return the data
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
      }

      // If we get here, none of the results had data for the target year
      if (lastError) {
        console.log(`  ✗ No results had data for year ${targetYear}`);
      }
      return null;

    } catch (error) {
      console.error('  ! Scraping error:', error instanceof Error ? error.message : error);
      return null;
    } finally {
      // ALWAYS close the page after each scrape
      try {
        await page.close();
      } catch {
        // Ignore close errors
      }
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
    try {
      // Wait briefly for popup to appear
      await this.delay(500);

      // Check if terms popup is visible
      const popup = await page.$('.modal-content, [role="dialog"]');
      if (!popup) {
        return false;
      }

      // Scroll down in the popup to make checkbox visible
      console.log('  → Scrolling through terms and conditions...');
      await page.evaluate(() => {
        const modalBody = document.querySelector('.modal-body');
        if (modalBody) {
          modalBody.scrollTop = modalBody.scrollHeight;
        }
        // Also try scrolling any scrollable container
        const scrollables = document.querySelectorAll('[style*="overflow"], .overflow-auto, .overflow-scroll');
        scrollables.forEach(el => {
          (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
        });
      });
      await this.delay(500);

      // Find and click the checkbox
      const checkbox = await page.$('#acceptCheck');
      if (checkbox) {
        console.log('  → Accepting terms and conditions...');

        // Scroll checkbox into view and click
        await checkbox.scrollIntoViewIfNeeded();
        await this.delay(200);
        await checkbox.click();
        await this.delay(500);

        // Click the submit button
        const submitButton = await page.$('button:has-text("Tovább")');
        if (submitButton) {
          await submitButton.scrollIntoViewIfNeeded();
          await this.delay(200);
          await submitButton.click();
          await this.delay(1500);
        }

        return true; // Popup was handled
      }
    } catch (error) {
      console.log('  → No terms popup or already accepted');
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

  // Randomized delay to avoid detection patterns
  private randomDelay(minMs: number, maxMs: number): Promise<void> {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return this.delay(ms);
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
