const MASTER = "https://docs.google.com/spreadsheets/d/1AjH3tCpLYbAuSD-yZtZgmGFrejtAm_XXF0-GQXJ2cNc/edit";
// Verified against the live workbook. A range alone opens the first tab in Sheets.
const TAB_IDS: Record<string,string> = {"Customer Accounts":"937735162",Sales:"690017703",Production:"725716161","Inventory Ledger":"1495301759"};
export function sheetLink(tab: string, row?: number | null): string {
  const gid=TAB_IDS[tab];
  const range=row && row>0 ? `A${row}:AN${row}` : 'A1';
  return gid ? `${MASTER}?gid=${gid}#gid=${gid}&range=${encodeURIComponent(range)}` : MASTER;
}
