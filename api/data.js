const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1mY9h_NoEW2wmA_axQp43vRXN5qwxeglridsb0umpXss';
const SHEET_NAME = process.env.SHEET_NAME || 'Accounts';

function getAuthClient() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }
  return new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

function categorizeByColor(bgColor) {
  if (!bgColor) return 'other';
  const r = Math.round((bgColor.red ?? 0) * 255);
  const g = Math.round((bgColor.green ?? 0) * 255);
  const b = Math.round((bgColor.blue ?? 0) * 255);

  if (r > 235 && g > 235 && b > 235) return 'other';
  if (g > 150 && g > r + 40 && g > b + 40) return 'cash';
  if (r > 200 && g > 200 && b < 160) return 'assets';
  if (b > 150 && g > 150 && r < b && r < g) return 'cash'; // was joint, now cash
  if (r > 100 && b > 100 && g < Math.min(r, b) - 30) return 'cash';
  if (r > 180 && r > g + 60 && r > b + 60) return 'debt';
  if (b > 150 && b > r + 40 && b > g + 40) return 'math';
  return 'other';
}

module.exports = async function handler(req, res) {
  try {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [SHEET_NAME],
      includeGridData: true,
    });

    const sheetData = response.data.sheets[0].data[0];
    const allRows = sheetData.rowData || [];

    if (allRows.length < 2) {
      return res.json({ error: 'Not enough data in spreadsheet' });
    }

    const headerCells = allRows[0].values || [];
    const columns = [];

    for (let i = 0; i < headerCells.length; i++) {
      const cell = headerCells[i];
      const name = (cell.formattedValue || '').trim();
      if (!name) continue;
      const bgColor = cell.effectiveFormat?.backgroundColor;
      let category = categorizeByColor(bgColor);

      // Override: columns with "Total", "SUMS", "Net Worth", "Real Net Worth" are
      // calculated summary columns — force them to "math" so they're excluded.
      const lowerName = name.toLowerCase();
      if (lowerName.startsWith('total') || lowerName.startsWith('sums') ||
          lowerName.startsWith('net worth') || lowerName.startsWith('real net worth')) {
        category = 'math';
      }

      // Override: Kia debt column should always be debt (but not if it's a "Total" row)
      if (lowerName.includes('kia') && lowerName.includes('debt') && !lowerName.startsWith('total')) {
        category = 'debt';
      }

      // Override: Crypto accounts
      if (lowerName.includes('coinbase') || lowerName.includes('crypto') ||
          lowerName.includes('lmwr') || lowerName.includes('affyn') ||
          lowerName.includes('ovi99') || lowerName.includes('eth') ||
          lowerName.includes('joint safe')) {
        category = 'crypto';
      }

      // Override: Business cash accounts (columns starting with "biz")
      if (lowerName.startsWith('biz') && !lowerName.includes('debt')) {
        category = 'bizcash';
      }

      // Override: Investment accounts (a2z, aiden, jarsy)
      if (lowerName.includes('a2z') || lowerName.includes('aiden') || lowerName.includes('jarsy')) {
        category = 'investments';
      }

      columns.push({ index: i, name, category });
    }

    const dataRows = [];
    for (let r = 1; r < allRows.length; r++) {
      const rowCells = allRows[r].values || [];
      const dateCell = rowCells[0];
      const dateValue = dateCell?.formattedValue || null;
      if (!dateValue) continue;

      const snapshot = { date: dateValue };
      for (const col of columns) {
        if (col.index === 0) continue;
        const cell = rowCells[col.index];
        if (!cell) { snapshot[col.name] = 0; continue; }
        let val = cell.effectiveValue?.numberValue;
        if (val === undefined || val === null) {
          const txt = (cell.formattedValue || '').replace(/[$,]/g, '');
          val = parseFloat(txt);
          if (isNaN(val)) val = 0;
        }
        snapshot[col.name] = val;
      }
      dataRows.push(snapshot);
    }

    const accountColumns = columns.filter(
      c => c.index > 1 && ['cash', 'assets', 'debt', 'math', 'crypto', 'bizcash', 'investments'].includes(c.category)
    );

    res.json({
      columns: accountColumns,
      rows: dataRows,
      spreadsheetId: SPREADSHEET_ID,
    });
  } catch (error) {
    console.error('Error fetching sheet data:', error.message);
    res.status(500).json({ error: error.message });
  }
};
