import 'dotenv/config';
import { EBeszamoloScraper } from './scraper';
import { getTimestamp } from './utils';

async function main() {
  const args = process.argv.slice(2);
  const isTaxSearch = args[0] === '--tax';

  // Default lists - edit these or load from file
  const companies = [
    'OTP Bank Nyrt',
    'MOL Nyrt',
    'Richter Gedeon Nyrt'
  ];

  const taxNumbers = [
    '12345678',
    '87654321'
  ];

  const targetYear = 2024;

  const scraper = new EBeszamoloScraper();

  try {
    await scraper.initialize();

    console.log('\n========================================');
    console.log('E-Beszámolo Bulk Scraper');
    console.log('========================================');

    let reports;
    let totalCount;

    if (isTaxSearch) {
      console.log(`Mode: Tax Number Search`);
      console.log(`Tax Numbers: ${taxNumbers.length}`);
      console.log(`Year: ${targetYear}`);
      console.log('========================================\n');

      reports = await scraper.scrapeCompaniesByTaxNumbers(taxNumbers, targetYear);
      totalCount = taxNumbers.length;
    } else {
      console.log(`Mode: Company Name Search`);
      console.log(`Companies: ${companies.length}`);
      console.log(`Year: ${targetYear}`);
      console.log('========================================\n');

      reports = await scraper.scrapeCompanies(companies, targetYear);
      totalCount = companies.length;
    }

    if (reports.length > 0) {
      const timestamp = getTimestamp();
      const prefix = isTaxSearch ? 'bulk_tax' : 'bulk';

      scraper.exportToJSON(reports, `results/${prefix}_reports_${timestamp}.json`);
      scraper.exportIncomeStatementToCSV(reports, `results/${prefix}_income_${timestamp}.csv`);
      scraper.exportBalanceSheetToCSV(reports, `results/${prefix}_balance_${timestamp}.csv`);
      scraper.exportSummaryToCSV(reports, `results/${prefix}_summary_${timestamp}.csv`);

      console.log('\n========================================');
      console.log(`✓ Scraping completed! ${reports.length}/${totalCount} processed.`);
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
