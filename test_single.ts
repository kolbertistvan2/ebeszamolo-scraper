import 'dotenv/config';
import { EBeszamoloScraper } from './src/scraper';

async function test() {
  const scraper = new EBeszamoloScraper();
  await scraper.initialize();
  
  // Test the problematic tax number
  const result = await scraper.scrapeByTaxNumber('12731231', 2024);
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  
  await scraper.close();
}

test().catch(console.error);
