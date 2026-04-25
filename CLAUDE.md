# E-Beszámolo Scraper - Project Guide

## Project Overview
Hungarian company financial data scraper that extracts data from e-beszamolo.im.gov.hu (official Hungarian government financial reporting portal).

## Project Purpose
This tool was built for **MPL (Magyar Posta Logisztika)** to analyze their client base financially:
- Input: CSV file with client company tax numbers (adószámok)
- Output: Financial data (revenue, profit) for each company for multiple years (2024, 2023)
- Goal: Identify financially healthy vs. risky clients

## What It Extracts
From each company's official annual report (beszámoló):
- **Nettó árbevétel** (Net revenue) - from income statement row "I."
- **Adózás előtti eredmény** (Profit before tax) - from income statement row "E."
- Company name, registration number, headquarters
- Data for multiple years in one run

## Key Commands

```bash
# Multi-year bulk scraping (main command)
npm run multi-year -- <input.csv> --workers <N>

# Examples:
npm run multi-year -- mpl-clientbase-2025dec-clean.csv --workers 10
npm run multi-year -- cegek.csv --workers 5 --years 2024,2023
```

## Important Files

- `src/scraper.ts` - Main scraper class with Browserbase integration
- `src/multi-year.ts` - Bulk processing with checkpoint support
- `results/checkpoint.json` - Progress tracking (auto-resume on restart)
- `mpl-clientbase-2025dec-clean.csv` - Main input file with tax numbers

## Checkpoint System

The scraper saves progress after each company. If interrupted:
- Just restart with the same command
- It will skip already processed tax numbers
- No need to delete checkpoint.json

## Key Technical Details

### Tax Number Search Logic
When searching by tax number, multiple results may appear (same company, different registrations due to county transfers). The scraper:
1. Sorts results by historical name count (descending)
2. More name changes = likely active company
3. Tries each result until finding one with target year data
4. Uses `page.goBack()` to try next result if needed

### Browserbase Configuration

**Proxy beállítások:**
- **Magyar residential proxy**: Alapértelmezetten BE van kapcsolva
- Geolocation: `{ country: 'HU' }` - Magyar IP cím
- Kikapcsolás: `BROWSERBASE_PROXY=false` environment variable

**Region és locale:**
- Region: `eu-central-1` (Frankfurt - legközelebb Magyarországhoz)
- Locale: `hu-HU, hu` - Magyar nyelvi beállítások
- Fingerprint: Chrome/Windows/Desktop

**IP Rotation (FONTOS!):**
- Minden egyes cég feldolgozása után **új browser session** indul
- Ez biztosítja az IP rotációt proxy használatakor
- Korábban 1 session = 1 IP volt, ami rate limit-hez vezetett több worker esetén
- Most: 1 cég = 1 új session = 1 új IP

**Miért fontos az IP rotation:**
- A régi megoldásban 5-10 worker = 5-10 fix IP
- Az e-beszamolo.im.gov.hu hamar tiltotta az azonos IP-ről jövő kéréseket
- Új megoldással minden cég új IP-t kap, így több worker is használható

### Worker Limits
- Default: 5 workers
- Max: 20 workers
- Ajánlott: 10 worker (IP rotation-nel már stabilabb)

## Common Issues

### "Nincs adat" (No data)
- Company may not have filed reports for that year
- Company may be inactive/dissolved
- All registration variants tried, none had the year

### Page Structure Warning (IMPORTANT!)
The e-beszamolo website has TWO different page structures for reports:

**Old structure (pre-2016 reports):**
- Uses `div.balance-container` with `a.view-obr-balance-link`
- Has clickable "Mérleg" and "Eredménykimutatás" links

**New structure (2016+ reports):**
- Reports listed as generic divs on `kereses_merleglista` page
- Link text: "Általános üzleti évet záró" or "ÜZLETI ÉVET ZÁRÓ"
- Year pattern in parent div: "YYYY. január 01. - YYYY. december 31."
- Clicking the link navigates to `/oldal/beszamolo_megjelenites` with full tables

The scraper (`scraper.ts` line ~302) handles BOTH structures:
1. First tries old `div.balance-container` selector
2. If not found, looks for links with "üzleti évet záró" text
3. Matches year from parent element's text

### Unicode Character Matching Bug (CRITICAL!)
**Problem discovered (2026-01):** The scraper was returning "Nincs adat" for companies that HAD data.

**Root cause:** Exact string matching failed due to Hungarian Unicode characters:
```typescript
// OLD (BROKEN):
linkText.includes('üzleti évet záró')  // Failed silently!

// NEW (FIXED):
/[üu]zleti\s+[ée]vet\s+z[aá]r[oó]/i.test(linkText)
```

**Why it failed:**
- Hungarian characters (ü, é, á, ó) have multiple Unicode representations
- The website may use different encoding than the source code
- Exact string matching is NOT reliable for Hungarian text

**The fix (in scraper.ts ~line 342):**
```typescript
const isReportLink = /[üu]zleti\s+[ée]vet\s+z[aá]r[oó]/i.test(linkText) ||
                     linkText.toUpperCase().includes('ÉVET ZÁRÓ') ||
                     linkText.toLowerCase().includes('évet záró');
```

**Also fixed year pattern (line ~354):**
```typescript
// Accept both "január" and "januar" (with or without accent)
/(\d{4})\.\s*janu[aá]r\s*\d+\.\s*-\s*(\d{4})\.\s*december\s*31/i
```

### Test Companies for Debugging
- **GPS Marketing (10558982)** - Has 2023/2024 data, uses NEW structure, good for testing Unicode fix
- **VIMPEX DRINK (13294401)** - Multiple search results, tests multi-result logic
- **MOBILAKCIÓK WEBÁRUHÁZ (26293084)** - Only has 2022 data, legitimate "Nincs adat"

**Lesson learned:** When you see high "Nincs adat" rate (~80%+), manually verify a few companies on the website! Some may actually have data but the scraper isn't finding it.

### Terms popup not accepting
The scraper scrolls through terms and clicks checkbox automatically. If failing:
- Check `handleTermsPopup()` in scraper.ts
- Modal selectors may have changed

## Output Files

Results saved to `output/` folder:
- `<adószám>.json` - Egyedi cég adatai (pl. `10558982.json`)
- `multi_year_summary_<timestamp>.csv` - Összesítő CSV
- `multi_year_detailed_<timestamp>.json` - Összes cég részletes JSON
- `checkpoint.json` - Folyamat állapota (restart támogatás)

## Related Project

`/Users/kolbert/Dev/ebeszamolo-app` - Web app version (single company lookup)

**FONTOS:** Az ebeszamolo-app scraper-je (`src/lib/scraper.ts`) NINCS frissítve az Unicode fix-szel!
- Csak a régi `div.balance-container` struktúrát kezeli
- Ha ott is problémák vannak, át kell vinni a regex fix-et:
  ```typescript
  /[üu]zleti\s+[ée]vet\s+z[aá]r[oó]/i.test(linkText)
  ```

## Quick Debug Checklist

Ha magas a "Nincs adat" arány:
1. ☐ Manuálisan ellenőrizd 2-3 céget az e-beszamolo.im.gov.hu-n
2. ☐ Ha VAN adat de a scraper nem találja → Unicode bug vagy selector probléma
3. ☐ Teszteld GPS Marketing (10558982) adószámmal - ennek mindig van 2023/2024 adata
4. ☐ Nézd meg a scraper.ts ~302 sortól a report keresési logikát
