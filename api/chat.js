const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk').default;

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
  if (b > 150 && g > 150 && r < b && r < g) return 'cash';
  if (r > 100 && b > 100 && g < Math.min(r, b) - 30) return 'cash';
  if (r > 180 && r > g + 60 && r > b + 60) return 'debt';
  if (b > 150 && b > r + 40 && b > g + 40) return 'math';
  return 'other';
}

async function fetchFinanceData() {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [SHEET_NAME],
    includeGridData: true,
  });

  const sheetData = response.data.sheets[0].data[0];
  const allRows = sheetData.rowData || [];

  if (allRows.length < 2) return null;

  const headerCells = allRows[0].values || [];
  const columns = [];

  for (let i = 0; i < headerCells.length; i++) {
    const cell = headerCells[i];
    const name = (cell.formattedValue || '').trim();
    if (!name) continue;
    const bgColor = cell.effectiveFormat?.backgroundColor;
    let category = categorizeByColor(bgColor);

    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('total') || lowerName.startsWith('sums') ||
        lowerName.startsWith('net worth') || lowerName.startsWith('real net worth')) {
      category = 'math';
    }
    if (lowerName.includes('kia') && lowerName.includes('debt') && !lowerName.startsWith('total')) {
      category = 'debt';
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

  return { columns, rows: dataRows };
}

function buildFinanceSummary(data) {
  const { columns, rows } = data;
  if (rows.length === 0) return 'No financial data available.';

  const latest = rows[rows.length - 1];
  const previous = rows.length > 1 ? rows[rows.length - 2] : null;

  const cashCols = columns.filter(c => c.category === 'cash');
  const assetCols = columns.filter(c => c.category === 'assets');
  const stockCols = columns.filter(c => c.category === 'stocks');
  const debtCols = columns.filter(c => c.category === 'debt');

  const sum = (row, cols) => cols.reduce((s, c) => s + (parseFloat(row[c.name]) || 0), 0);

  const totalCash = sum(latest, cashCols);
  const totalAssets = sum(latest, assetCols);
  const totalStocks = sum(latest, stockCols);
  const totalDebt = Math.abs(sum(latest, debtCols));
  const netWorth = totalCash + totalAssets + totalStocks - totalDebt;

  let summary = `## CURRENT FINANCIAL SNAPSHOT (as of ${latest.date})\n`;
  summary += `- Net Worth: $${netWorth.toLocaleString()}\n`;
  summary += `- Total Cash: $${totalCash.toLocaleString()}\n`;
  summary += `- Total Assets: $${totalAssets.toLocaleString()}\n`;
  summary += `- Stocks/Retirement: $${totalStocks.toLocaleString()}\n`;
  summary += `- Total Debt: $${totalDebt.toLocaleString()}\n\n`;

  // Individual accounts
  summary += `### Cash Accounts:\n`;
  cashCols.forEach(c => {
    if (c.index > 0) summary += `- ${c.name}: $${(parseFloat(latest[c.name]) || 0).toLocaleString()}\n`;
  });

  summary += `\n### Asset Accounts:\n`;
  assetCols.forEach(c => {
    if (c.index > 0) summary += `- ${c.name}: $${(parseFloat(latest[c.name]) || 0).toLocaleString()}\n`;
  });

  summary += `\n### Stocks/Retirement Accounts:\n`;
  stockCols.forEach(c => {
    if (c.index > 0) summary += `- ${c.name}: $${(parseFloat(latest[c.name]) || 0).toLocaleString()}\n`;
  });

  summary += `\n### Debt Accounts:\n`;
  debtCols.forEach(c => {
    if (c.index > 0) summary += `- ${c.name}: $${Math.abs(parseFloat(latest[c.name]) || 0).toLocaleString()}\n`;
  });

  // Historical trend (last 6 snapshots)
  const recentRows = rows.slice(-6);
  summary += `\n### HISTORICAL TREND (last ${recentRows.length} snapshots):\n`;
  recentRows.forEach(row => {
    const c = sum(row, cashCols);
    const a = sum(row, assetCols);
    const st = sum(row, stockCols);
    const d = Math.abs(sum(row, debtCols));
    const nw = c + a + st - d;
    summary += `- ${row.date}: Net Worth $${nw.toLocaleString()} | Cash $${c.toLocaleString()} | Assets $${a.toLocaleString()} | Stocks/Ret $${st.toLocaleString()} | Debt $${d.toLocaleString()}\n`;
  });

  // Full history for deeper analysis
  if (rows.length > 6) {
    summary += `\n### FULL HISTORY (${rows.length} total snapshots):\n`;
    rows.forEach(row => {
      const c = sum(row, cashCols);
      const a = sum(row, assetCols);
      const st = sum(row, stockCols);
      const d = Math.abs(sum(row, debtCols));
      const nw = c + a + st - d;
      summary += `- ${row.date}: NW $${nw.toLocaleString()} | Cash $${c.toLocaleString()} | Assets $${a.toLocaleString()} | Stocks/Ret $${st.toLocaleString()} | Debt $${d.toLocaleString()}\n`;
    });
  }

  // Month-over-month changes
  if (rows.length >= 2) {
    summary += `\n### RECENT CHANGES:\n`;
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const lastNW = sum(last, cashCols) + sum(last, assetCols) + sum(last, stockCols) - Math.abs(sum(last, debtCols));
    const prevNW = sum(prev, cashCols) + sum(prev, assetCols) + sum(prev, stockCols) - Math.abs(sum(prev, debtCols));
    const change = lastNW - prevNW;
    const pctChange = prevNW !== 0 ? ((change / Math.abs(prevNW)) * 100).toFixed(1) : 0;
    summary += `- Net worth changed by $${change.toLocaleString()} (${pctChange}%) from ${prev.date} to ${last.date}\n`;
    summary += `- Cash changed by $${(sum(last, cashCols) - sum(prev, cashCols)).toLocaleString()}\n`;
    summary += `- Stocks/Retirement changed by $${(sum(last, stockCols) - sum(prev, stockCols)).toLocaleString()}\n`;
    summary += `- Debt changed by $${(Math.abs(sum(last, debtCols)) - Math.abs(sum(prev, debtCols))).toLocaleString()}\n`;
  }

  return summary;
}

module.exports = async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, history } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured. Add it to your Vercel environment variables.' });
  }

  try {
    // Fetch fresh finance data
    const financeData = await fetchFinanceData();
    if (!financeData) {
      return res.status(500).json({ error: 'Could not load finance data from Google Sheets.' });
    }

    const financeSummary = buildFinanceSummary(financeData);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build conversation messages
    const messages = [];

    // Include prior conversation history (last 10 turns max)
    if (history && Array.isArray(history)) {
      const recentHistory = history.slice(-10);
      for (const turn of recentHistory) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }

    // Add the current user message
    messages.push({ role: 'user', content: message });

    // Stream the response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: `You are Ovi's personal AI financial advisor. You have access to Ovi's real financial data from his Google Sheets tracker. Use this data to answer questions accurately and provide actionable insights.

Here is Ovi's current financial data:

${financeSummary}

Guidelines:
- Be specific — use actual numbers from the data, not vague generalities.
- When discussing trends, reference specific dates and amounts.
- For projections, explain your assumptions clearly.
- For debt questions, break down which accounts contribute.
- Keep answers concise but thorough.
- Use dollar amounts and percentages where helpful.
- If asked about something not in the data, say so honestly.
- Be encouraging but realistic about financial goals.
- Format responses with markdown for readability (bold, lists, etc).`,
      messages: messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: [DONE]\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);
    // If we already started streaming, send error as SSE
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};
