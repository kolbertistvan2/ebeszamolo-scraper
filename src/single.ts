import 'dotenv/config';
import { EBeszamoloScraper } from './scraper';
import { getTimestamp, sanitizeFilename } from './utils';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage:');
    console.error('  By name:       npm run single "<company name>" [year]');
    console.error('  By tax number: npm run single --tax "<tax number>" [year]');
    console.error('');
    console.error('Examples:');
    console.error('  npm run single "OTP Bank Nyrt" 2024');
    console.error('  npm run single --tax "12345678" 2024');
    console.error('  npm run single --tax "12345678-2-41" 2024');
    process.exit(1);
  }

  const isTaxSearch = args[0] === '--tax';
  const searchValue = isTaxSearch ? args[1] : args[0];
  const yearArg = isTaxSearch ? args[2] : args[1];
  const targetYear = yearArg ? parseInt(yearArg, 10) : 2024;

  if (!searchValue) {
    console.error('Error: Missing search value');
    process.exit(1);
  }

  if (isNaN(targetYear)) {
    console.error('Error: Year must be a number');
    process.exit(1);
  }

  const scraper = new EBeszamoloScraper();

  try {
    await scraper.initialize();

    console.log('\n========================================');
    console.log('E-Beszámolo Single Company Scraper');
    console.log('========================================');
    if (isTaxSearch) {
      console.log(`Tax Number: ${searchValue}`);
    } else {
      console.log(`Company: ${searchValue}`);
    }
    console.log(`Year: ${targetYear}`);
    console.log('========================================\n');

    const report = isTaxSearch
      ? await scraper.scrapeByTaxNumber(searchValue, targetYear)
      : await scraper.scrapeSingleCompany(searchValue, targetYear);

    if (report) {
      const timestamp = getTimestamp();
      const safeFilename = sanitizeFilename(report.companyName || searchValue);

      scraper.exportSingleToJSON(report, `results/${safeFilename}_${timestamp}.json`);
      scraper.exportIncomeStatementToCSV([report], `results/${safeFilename}_income_${timestamp}.csv`);
      scraper.exportBalanceSheetToCSV([report], `results/${safeFilename}_balance_${timestamp}.csv`);

      console.log('\n========================================');
      console.log('✓ Scraping completed successfully!');
      console.log('========================================');
    } else {
      console.log('\n✗ No data was extracted.');
      process.exit(1);
    }

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await scraper.close();
  }
}

main();
