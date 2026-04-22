require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Google Sheets configuration
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1mY9h_NoEW2wmA_axQp43vRXN5qwxeglridsb0umpXss';
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';

// ─── Auth ────────────────────────────────────────────────────────────────────
async function getAuthClient() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }
  // Local dev: use credentials.json file
  return new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

// ─── Color → Category mapping ───────────────────────────────────────────────
// Reads background colors from the header row to auto-categorize columns.
// Green = cash, Yellow = assets, Skyblue = joint, Purple = biz, Red = debt, Blue = math
function categorizeByColor(bgColor) {
  if (!bgColor) return 'other';
  const r = Math.round((bgColor.red ?? 0) * 255);
  const g = Math.round((bgColor.green ?? 0) * 255);
  const b = Math.round((bgColor.blue ?? 0) * 255);

  // White / very light → skip
  if (r > 235 && g > 235 && b > 235) return 'other';

  // Pure green or green-dominant → cash
  if (g > 150 && g > r + 40 && g > b + 40) return 'cash';

  // Yellow (high R+G, low B) → assets
  if (r > 200 && g > 200 && b < 160) return 'assets';

  // Sky blue / cyan → joint
  if (b > 150 && g > 150 && r < b && r < g) return 'joint';

  // Purple (R+B high, G low) → business
  if (r > 100 && b > 100 && g < Math.min(r, b) - 30) return 'business';

  // Red dominant → debt
  if (r > 180 && r > g + 60 && r > b + 60) return 'debt';

  // Blue dominant → math / calculated
  if (b > 150 && b > r + 40 && b > g + 40) return 'math';

  return 'other';
}

// ─── API endpoint ────────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Fetch spreadsheet with grid data (includes formatting)
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

    // ── Parse header row ──────────────────────────────────────────────────
    const headerCells = allRows[0].values || [];
    const columns = [];

    for (let i = 0; i < headerCells.length; i++) {
      const cell = headerCells[i];
      const name = (cell.formattedValue || '').trim();
      if (!name) continue; // skip empty headers

      const bgColor = cell.effectiveFormat?.backgroundColor;
      const category = categorizeByColor(bgColor);

      columns.push({ index: i, name, category });
    }

    // ── Parse data rows ───────────────────────────────────────────────────
    const dataRows = [];

    for (let r = 1; r < allRows.length; r++) {
      const rowCells = allRows[r].values || [];
      // Column A = date
      const dateCell = rowCells[0];
      const dateValue = dateCell?.formattedValue || null;
      if (!dateValue) continue; // skip rows without a date

      const snapshot = { date: dateValue };

      for (const col of columns) {
        if (col.index === 0) continue; // skip date column (already handled)
        const cell = rowCells[col.index];
        if (!cell) { snapshot[col.name] = 0; continue; }

        // Prefer numeric value, fall back to formatted text → number parse
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

    // ── Build summary ─────────────────────────────────────────────────────
    // Only include account columns (skip date & legend columns)
    const accountColumns = columns.filter(
      c => c.index > 1 && ['cash', 'assets', 'joint', 'business', 'debt', 'math'].includes(c.category)
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
});

// ─── Serve index.html for all other routes ───────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Ovi Finance Dashboard running at http://localhost:${PORT}\n`);
});

module.exports = app;
