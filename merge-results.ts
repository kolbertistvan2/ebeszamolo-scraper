import * as fs from 'fs';

const INPUT_FILE = 'jav_ngm_find-company-name-top10000-FINAL.csv';
const OUTPUT_FILE = 'output/multi_year_summary_2026-03-18_11-08-32.csv';
const MERGED_CSV = 'merged_results.csv';
const MERGED_XLSX_SCRIPT = true; // will also generate XLSX

// Parse CSV with given delimiter
function parseCSV(content: string, delimiter: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content.trim().split(/\r?\n/);
  const headers = lines[0].replace(/^\uFEFF/, '').split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted fields with delimiters inside
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter.charAt(0) && !inQuotes) {
        values.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim().replace(/^"|"$/g, ''));

    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

function extractFirst8Digits(taxId: string): string {
  const digits = taxId.replace(/\D/g, '');
  return digits.substring(0, 8);
}

// Escape CSV field
function csvField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

async function main() {
  // Read input
  const inputContent = fs.readFileSync(INPUT_FILE, 'utf-8');
  const input = parseCSV(inputContent, ',');
  console.log(`Input: ${input.rows.length} sor, oszlopok: ${input.headers.join(', ')}`);

  // Read output
  const outputContent = fs.readFileSync(OUTPUT_FILE, 'utf-8');
  const output = parseCSV(outputContent, ';');
  console.log(`Output: ${output.rows.length} sor, oszlopok: ${output.headers.join(', ')}`);

  // Build lookup map from output: adószám -> row
  const outputMap = new Map<string, Record<string, string>>();
  for (const row of output.rows) {
    const taxNum = row['Adószám']?.trim();
    if (taxNum) {
      outputMap.set(taxNum, row);
    }
  }
  console.log(`Output lookup: ${outputMap.size} egyedi adószám`);

  // Merged headers: input columns + scraped financial columns
  const financialColumns = [
    'Cégnév (e-beszámoló)',
    'Cégjegyzékszám',
    'Székhely',
    'Nettó árbevétel 2024',
    'Üzemi eredmény 2024',
    'Adózott eredmény 2024',
    'Nettó árbevétel 2023',
    'Üzemi eredmény 2023',
    'Adózott eredmény 2023',
    'Pénznem',
    'Egység',
    'Megjegyzések'
  ];

  const mergedHeaders = [...input.headers, ...financialColumns];
  const mergedRows: string[][] = [];

  let matched = 0;
  let unmatched = 0;

  for (const inputRow of input.rows) {
    const rawTaxId = inputRow['TAX_ID'] || '';
    const first8 = extractFirst8Digits(rawTaxId);

    const outputRow = first8.length === 8 ? outputMap.get(first8) : undefined;

    const row = input.headers.map(h => inputRow[h] || '');

    if (outputRow) {
      matched++;
      row.push(
        outputRow['Cégnév'] || '',
        outputRow['Cégjegyzékszám'] || '',
        outputRow['Székhely'] || '',
        outputRow['Nettó árbevétel 2024'] || '',
        outputRow['Üzemi eredmény 2024'] || '',
        outputRow['Adózott eredmény 2024'] || '',
        outputRow['Nettó árbevétel 2023'] || '',
        outputRow['Üzemi eredmény 2023'] || '',
        outputRow['Adózott eredmény 2023'] || '',
        outputRow['Pénznem'] || '',
        outputRow['Egység'] || '',
        outputRow['Megjegyzések'] || ''
      );
    } else {
      unmatched++;
      row.push(...financialColumns.map(() => ''));
    }

    mergedRows.push(row);
  }

  console.log(`\nEredmény: ${matched} illeszkedik, ${unmatched} nem (üres adószám vagy nem volt adat)`);

  // Write CSV (semicolon delimited for Excel compatibility)
  const delimiter = ';';
  const csvLines = [
    '\uFEFF' + mergedHeaders.map(h => csvField(h, delimiter)).join(delimiter),
    ...mergedRows.map(row => row.map(v => csvField(v, delimiter)).join(delimiter))
  ];
  fs.writeFileSync(MERGED_CSV, csvLines.join('\n'), 'utf-8');
  console.log(`\nCSV mentve: ${MERGED_CSV}`);

  // Write XLSX using a simple approach with csv-to-xlsx via exceljs if available
  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.default.Workbook();
    const sheet = workbook.addWorksheet('Merged Results');

    // Headers
    sheet.addRow(mergedHeaders);
    // Bold headers
    sheet.getRow(1).font = { bold: true };

    // Data rows
    for (const row of mergedRows) {
      const processedRow = row.map(val => {
        const num = Number(val);
        return !isNaN(num) && val.trim() !== '' ? num : val;
      });
      sheet.addRow(processedRow);
    }

    // Auto-width
    sheet.columns.forEach(col => {
      let maxLen = 10;
      col.eachCell?.({ includeEmpty: false }, cell => {
        const len = String(cell.value || '').length;
        if (len > maxLen) maxLen = Math.min(len, 40);
      });
      col.width = maxLen + 2;
    });

    const xlsxFile = 'merged_results.xlsx';
    await workbook.xlsx.writeFile(xlsxFile);
    console.log(`XLSX mentve: ${xlsxFile}`);
  } catch {
    console.log('XLSX-hez telepítsd: npm install exceljs');
    console.log('Csak CSV lett mentve.');
  }
}

main().catch(console.error);
