/**
 * Hungarian company form suffixes to remove from company names
 */
const COMPANY_SUFFIXES = [
  'Nyrt.',
  'Nyrt',
  'Zrt.',
  'Zrt',
  'Kft.',
  'Kft',
  'Bt.',
  'Bt',
  'Kkt.',
  'Kkt',
  'Rt.',
  'Rt',
  'Szövetkezet',
  'Egyesülés',
  'Alapítvány',
  'Egyesület',
];

/**
 * Removes Hungarian company form suffixes from a company name
 * @param companyName - The original company name
 * @returns The company name without the suffix
 */
export function normalizeCompanyName(companyName: string): string {
  let normalized = companyName.trim();

  for (const suffix of COMPANY_SUFFIXES) {
    const regex = new RegExp(`\\s*${escapeRegex(suffix)}\\s*$`, 'i');
    normalized = normalized.replace(regex, '');
  }

  return normalized.trim();
}

/**
 * Escapes special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a timestamp string for file naming (Budapest timezone with hours, minutes, and seconds)
 */
export function getTimestamp(): string {
  const now = new Date();
  const budapestTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);
  // Format: "2025-12-02 15:30:45" -> "2025-12-02_15-30-45"
  return budapestTime.replace(' ', '_').replace(/:/g, '-');
}

/**
 * Sanitizes a filename by removing/replacing invalid characters
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}
