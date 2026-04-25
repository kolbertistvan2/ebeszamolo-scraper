import { EBeszamoloScraper } from './src/scraper';

const TAX_NUMBER = process.argv[2] || '27335109';
const YEARS = [2024, 2023];

(async () => {
  const scraper = new EBeszamoloScraper();
  for (const year of YEARS) {
    const result = await scraper.scrapeByTaxNumber(TAX_NUMBER, year);
    console.log(`\n=== ${year} ===`);
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(0);
})();
