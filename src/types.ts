export interface IncomeStatementRow {
  rowNumber: string;
  itemCode: string;
  itemName: string;
  previousYearData: number | string;
  amendments: number | string;
  targetYearData: number | string;
}

export interface BalanceSheetRow {
  rowNumber: string;
  itemCode: string;
  itemName: string;
  previousYearData: number | string;
  amendments: number | string;
  targetYearData: number | string;
}

export interface CompanyFinancialReport {
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
