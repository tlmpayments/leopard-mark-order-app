var SALES_SHEET_NAME = 'Sales';
var REPS_SHEET_NAME = 'Reps';
var CUSTOMERS_SHEET_NAME = 'Customer Accounts';

// ---- Phase 2 (Sheet <-> Postgres sync) column ownership ----
// See /Users/jackbegley/.claude/plans/jazzy-pondering-rivest.md, "Sheet sync
// architecture" -> "Ownership split". Postgres decides DB-owned columns --
// a human edit to one of these in the Sheet is a conflict (logged, never
// applied, corrected back onto the Sheet by the DB). Ops fills in
// Sheet-owned columns after order creation -- Postgres never touches them
// again once the initial appendRow lands. Every Sales-sheet column must be
// in exactly one of these two lists; classifySyncColumn() below is the single
// place that decides which.
var DB_OWNED_COLUMNS = [
  'Customer', 'License Number', 'PO Date', 'Product Name', 'Packaging Format',
  'Product Code', 'Qty', 'Price (ea)', 'Line Total', 'Sales Rep', 'Invoice #',
  'Order ID', 'Inventory Source', 'Payment Method'
];
var SHEET_OWNED_COLUMNS = [
  'Delivery (Invoice) Date', 'Lot #', 'BOL #', 'ACH Invoice REF #',
  'Invoice Status', 'TLM Tap Handle', 'SGB Tap Handle', 'CNT Tap Handle',
  'MicroStar 1/2 Empty', 'MicroStar 1/6 Empty', 'Notes'
];

// Single source of truth for "can this column sync Sheet -> DB". Three
// states, matching lib/sheetColumns.ts's classifyColumn on the Next.js side
// exactly (an earlier version of this function only had two states,
// collapsing 'unknown' into 'db_owned' -- fine for the webhook, which
// treats both as a conflict either way, but wrong for onEditInstallable's
// decision of whether to track an edit AT ALL: a genuinely unrecognized
// column (not part of this sync design) shouldn't be dirty-marked and sent
// anywhere, while a recognized DB-owned column SHOULD be, so it can be
// flagged as a conflict). Callers that only care about "is this safe to
// sync Sheet -> DB" still just check `=== 'sheet_owned'`; callers deciding
// whether to track an edit at all should treat 'sheet_owned' and 'db_owned'
// as "yes, tracked" and only 'unknown' as "no, ignore".
function classifySyncColumn(headerName) {
  if (SHEET_OWNED_COLUMNS.indexOf(headerName) !== -1) return 'sheet_owned';
  if (DB_OWNED_COLUMNS.indexOf(headerName) !== -1) return 'db_owned';
  return 'unknown';
}

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'login') return respond(handleLogin(e.parameter.name, e.parameter.pin));
    if (action === 'reps') return respond(handleReps());
    if (action === 'stats') return respond(handleStats(e.parameter.rep));
    if (action === 'customers') return respond(handleCustomers());
    if (action === 'debugHeaders') return respond(handleDebugHeaders());
    if (action === 'debugSlackTest') return respond(handleDebugSlackTest(e.parameter.inventorySource));
    if (action === 'backfillFirstOrderFlag') return respond(handleBackfillFirstOrderFlag());
    if (action === 'debugSlackTeamInfo') return respond(handleDebugSlackTeamInfo());
    if (action === 'debugSales') return respond(handleDebugSales(e.parameter.rows));
    if (action === 'invoiceDetail') return respond(handleInvoiceDetail(e.parameter.invoiceNumber));
    if (action === 'customerOrders') return respond(handleCustomerOrders(e.parameter.customer));
    if (action === 'allOrders') return respond(handleAllOrders());
    if (action === 'lastOrder') return respond(handleLastOrder(e.parameter.customer));
    if (action === 'allSalesRows') return respond(handleAllSalesRows());
    return respond({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'order') return respond(handleOrder(body));
    if (body.action === 'addCustomer') return respond(handleAddCustomer(body.customer));
    if (body.action === 'updateCustomer') return respond(handleUpdateCustomer(body.customer));
    if (body.action === 'setPin') return respond(handleSetPin(body.name, body.pin));
    if (body.action === 'syncOrder') return respond(handleSyncOrder(body));
    if (body.action === 'writeOrderIds') return respond(handleWriteOrderIds(body));
    return respond({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Never let a Slack outage block an order/customer write -- that data is
// already saved by the time this runs, so any failure here is swallowed.
function notifySlackUrl(url, text) {
  if (!url) return;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true
    });
  } catch (err) {
    // swallow -- Slack notification is best-effort
  }
}

// New-account alerts go to the general order-alerts webhook regardless of region.
function notifySlack(text) {
  notifySlackUrl(PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL'), text);
}

// Order alerts route by region: Bay Area orders to their own channel,
// everything else (LA/SoCal) to theirs -- same Bay-Area classification
// warehouseForRegion already uses for fulfillment.
function notifySlackForOrder(region, text) {
  var props = PropertiesService.getScriptProperties();
  var key = isBayAreaRegion(region) ? 'SLACK_WEBHOOK_URL_BA' : 'SLACK_WEBHOOK_URL_LA';
  notifySlackUrl(props.getProperty(key), text);
}

// packagingFormat arrives as "{label} ({detail})", e.g. "1/2 Barrel Keg
// (15.5 gal)" -- reflow it to size-first with the unit word (Keg/Case) at
// the end, e.g. "1/2 BBL (15.5gal) Keg", and drop the product's region
// suffix (everything after an em dash) for a shorter Slack line.
function formatOrderLineForSlack(line, qty) {
  var shortName = String(line.productName || line.productCode || '').split('—')[0].trim();
  var pkg = String(line.packagingFormat || line.productCode || '');
  var m = pkg.match(/^(.*)\s+(\S+)\s*\(([^)]*)\)\s*$/);
  var formatted;
  if (m) {
    var prefix = m[1].replace(/Barrel/g, 'BBL');
    var unitWord = m[2];
    var detail = m[3];
    if (/^[\d.]+\s*[a-zA-Z]+$/.test(detail)) detail = detail.replace(/\s+/g, '');
    formatted = prefix + ' (' + detail + ') ' + unitWord;
  } else {
    formatted = pkg.replace(/Barrel/g, 'BBL');
  }
  return qty + ' x ' + formatted + ' - ' + shortName;
}

// Google Sheets "Table" objects (the banded/filterable kind) have their own
// range separate from the sheet's data range. sheet.appendRow() only extends
// the sheet, not the Table sitting on top of it, so rows written by this
// script would otherwise land just below the table with none of its
// formatting/filters until someone manually drags the table's resize handle.
// This finds the Table on a given sheet (if any) and grows its range to
// include the row that was just appended. It's a nice-to-have, never a
// requirement — any failure here is swallowed so the actual data write
// (which already happened via appendRow) is never affected.
function extendTableForNewRow(sheet) {
  try {
    extendTableForNewRowUnsafe(sheet);
  } catch (err) {
    console.error('extendTableForNewRow failed (non-fatal): ' + err.message);
  }
}

function extendTableForNewRowUnsafe(sheet) {
  var ss = sheet.getParent();
  var sheetId = sheet.getSheetId();
  var meta = Sheets.Spreadsheets.get(ss.getId(), { fields: 'sheets(properties.sheetId,tables,bandedRanges)' });
  var thisSheet = null;
  for (var i = 0; i < meta.sheets.length; i++) {
    if (meta.sheets[i].properties.sheetId === sheetId) { thisSheet = meta.sheets[i]; break; }
  }
  if (!thisSheet) return { skipped: 'sheet not found in metadata' };
  var table = thisSheet.tables && thisSheet.tables.length ? thisSheet.tables[0] : null; // at most one table per sheet in this project
  if (!table) return { skipped: 'no table on this sheet' };

  var newLastRow = sheet.getLastRow(); // 1-based row index of the row we just appended
  if (table.range.endRowIndex === undefined) return { skipped: 'unbounded, already covers everything' };
  if (table.range.endRowIndex >= newLastRow) return { skipped: 'already covers new row', endRowIndex: table.range.endRowIndex, newLastRow: newLastRow };

  var requests = [];

  // Sheets auto-creates a separate "preview" banded range over rows written
  // just below an existing table (same band colors, different object) before
  // the table officially adopts them. Growing the table's own range over
  // that same area collides with it — "You cannot add alternating background
  // colors to a range that already has alternating background colors." —
  // so any stray banded range covering the rows we're about to pull in has
  // to be deleted first, in the same batch, before the table resize.
  (thisSheet.bandedRanges || []).forEach(function (br) {
    var isTablesOwnBand = String(br.bandedRangeId) === String(table.tableId);
    var overlapsGrowthZone = br.range.startRowIndex < newLastRow && (br.range.endRowIndex === undefined || br.range.endRowIndex > table.range.endRowIndex);
    if (!isTablesOwnBand && overlapsGrowthZone) {
      requests.push({ deleteBanding: { bandedRangeId: br.bandedRangeId } });
    }
  });

  var updatedTable = JSON.parse(JSON.stringify(table));
  updatedTable.range.endRowIndex = newLastRow;
  requests.push({ updateTable: { table: updatedTable, fields: '*' } });

  var res = Sheets.Spreadsheets.batchUpdate({ requests: requests }, ss.getId());
  return { extended: true, newRange: updatedTable.range, removedStrayBands: requests.length - 1, apiResponse: res };
}

// Reps tab columns: Name | PIN | Active | Role. Role is optional -- a blank
// or missing Role column defaults to a plain rep, so this stays backward
// compatible with sheets that don't have the column yet.
function handleLogin(name, pin) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Reps tab not found' };
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var rowName = String(rows[i][0] || '').trim();
    var rowPin = String(rows[i][1] || '').trim();
    var active = rows[i][2];
    if (rowName.toLowerCase() === String(name || '').trim().toLowerCase() &&
        rowPin === String(pin || '').trim() &&
        (active === true || active === 'TRUE' || active === '')) {
      var role = String(rows[i][3] || '').trim();
      return { ok: true, rep: rowName, role: role.toLowerCase() === 'admin' ? 'Admin' : 'Rep' };
    }
  }
  return { ok: false, error: 'Invalid name or PIN' };
}

// Names only (no PINs) so the login screen can show a tap-to-pick list
// instead of making reps type their name every time. Flags reps whose PIN
// cell is still blank so the app can send them through PIN setup instead
// of PIN entry.
function handleReps() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Reps tab not found' };
  var rows = sheet.getDataRange().getValues();
  var reps = [];
  for (var i = 1; i < rows.length; i++) {
    var rowName = String(rows[i][0] || '').trim();
    var active = rows[i][2];
    if (!rowName) continue;
    if (!(active === true || active === 'TRUE' || active === '')) continue;
    var role = String(rows[i][3] || '').trim();
    var hasPin = String(rows[i][1] || '').trim() !== '';
    reps.push({ name: rowName, role: role.toLowerCase() === 'admin' ? 'Admin' : 'Rep', needsPin: !hasPin });
  }
  return { ok: true, reps: reps };
}

// Lets a rep choose their own PIN the first time they log in. Only works
// while the sheet's PIN cell for that rep is still blank -- once a PIN is
// set, this endpoint refuses to touch it, so it can't be used to hijack
// someone else's account by overwriting their PIN. Resetting a forgotten
// PIN is a job for whoever manages the Reps sheet directly (clear the cell,
// which re-opens this setup flow for that rep).
function handleSetPin(name, pin) {
  var cleanPin = String(pin || '').trim();
  if (!/^\d{4}$/.test(cleanPin)) return { ok: false, error: 'PIN must be 4 digits' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Reps tab not found' };
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var rowName = String(rows[i][0] || '').trim();
    if (rowName.toLowerCase() !== String(name || '').trim().toLowerCase()) continue;
    var active = rows[i][2];
    if (!(active === true || active === 'TRUE' || active === '')) return { ok: false, error: 'Account is not active' };
    if (String(rows[i][1] || '').trim() !== '') return { ok: false, error: 'PIN already set for this account' };
    sheet.getRange(i + 1, 2).setValue(cleanPin);
    var role = String(rows[i][3] || '').trim();
    return { ok: true, rep: rowName, role: role.toLowerCase() === 'admin' ? 'Admin' : 'Rep' };
  }
  return { ok: false, error: 'Rep not found' };
}

function getSalesHeaderAndCol(sheet) {
  var lastCol = sheet.getLastColumn();
  var scanRows = Math.min(10, sheet.getLastRow());
  var block = sheet.getRange(1, 1, scanRows, lastCol).getValues();
  var headerRowIdx = 0;
  for (var r = 0; r < block.length; r++) {
    var rowText = block[r].join(' ').toLowerCase();
    if (rowText.indexOf('customer') !== -1 && rowText.indexOf('qty') !== -1) {
      headerRowIdx = r;
      break;
    }
  }
  var header = block[headerRowIdx];
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });
  return { header: header, col: col, headerRowNumber: headerRowIdx + 1 };
}

function salesCol(col, header, exactName, fuzzyWords) {
  if (col[exactName] !== undefined) return col[exactName];
  return findColFuzzy(header, fuzzyWords);
}

function handleStats(rep) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found' };
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var dataStartRow = hc.headerRowNumber + 1;
  var data = sheet.getRange(dataStartRow, 1, Math.max(0, sheet.getLastRow() - hc.headerRowNumber), sheet.getLastColumn()).getValues();

  var repIdx = salesCol(col, header, 'Sales Rep', ['sales', 'rep']);
  var qtyIdx = salesCol(col, header, 'Qty', ['qty']);
  var lineTotalIdx = salesCol(col, header, 'Line Total', ['line', 'total']);
  var customerIdx = salesCol(col, header, 'Customer', ['customer']);
  var productIdx = salesCol(col, header, 'Product Name', ['product', 'name']);
  var packagingIdx = salesCol(col, header, 'Packaging Format', ['packaging']);
  var poDateIdx = salesCol(col, header, 'PO Date', ['po', 'date']);
  var statusIdx = salesCol(col, header, 'Invoice Status', ['invoice', 'status']);
  var invoiceIdx = salesCol(col, header, 'Invoice #', ['invoice', '#']);

  var totalQty = 0, totalLine = 0, orderCount = 0;
  var invoiceMap = {};
  var invoiceOrder = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (repIdx === -1) continue;
    if (String(row[repIdx] || '').trim().toLowerCase() !== String(rep || '').trim().toLowerCase()) continue;
    orderCount++;
    var qty = Number(qtyIdx === -1 ? 0 : row[qtyIdx]) || 0;
    var lineTotal = Number(lineTotalIdx === -1 ? 0 : row[lineTotalIdx]) || 0;
    totalQty += qty;
    totalLine += lineTotal;

    var invoiceNumber = invoiceIdx === -1 ? '' : String(row[invoiceIdx] || '');
    var poDate = poDateIdx === -1 ? '' : row[poDateIdx];
    var groupKey = invoiceNumber || ('__noinv_' + i);

    if (!invoiceMap[groupKey]) {
      invoiceMap[groupKey] = {
        invoiceNumber: invoiceNumber,
        customer: customerIdx === -1 ? '' : row[customerIdx],
        poDate: poDate,
        status: statusIdx === -1 ? '' : row[statusIdx],
        qty: 0,
        lineTotal: 0,
        lines: []
      };
      invoiceOrder.push(groupKey);
    }
    var group = invoiceMap[groupKey];
    group.qty += qty;
    group.lineTotal += lineTotal;
    group.lines.push({
      product: productIdx === -1 ? '' : row[productIdx],
      packaging: packagingIdx === -1 ? '' : row[packagingIdx],
      qty: qty
    });
  }

  var recent = invoiceOrder.map(function (k) { return invoiceMap[k]; });
  recent.sort(function (a, b) { return new Date(b.poDate) - new Date(a.poDate); });

  return {
    ok: true,
    rep: rep,
    totalLineItems: orderCount,
    totalQty: totalQty,
    totalLineValue: totalLine,
    recentOrders: recent.slice(0, 15)
  };
}

// All orders (grouped by invoice, most recent first) for one account --
// unlike handleStats this isn't capped, since "see all orders for this
// account" means all of them, not just the last 15.
// Historical/Ekos-imported Sales rows store the customer as
// "Legal Entity / DBA Name" (e.g. "Sutro Syndicate LLC / 540 SF"), while our
// app and the Customer Accounts sheet both use just the plain DBA name
// ("540 SF"). Match either an exact hit or a "/ dba" suffix so account
// lookups find both old and new rows.
function customerMatches(rowValue, targetLower) {
  var row = String(rowValue || '').trim().toLowerCase();
  if (row === targetLower) return true;
  var slashIdx = row.lastIndexOf('/');
  if (slashIdx !== -1 && row.slice(slashIdx + 1).trim() === targetLower) return true;
  return false;
}

function handleCustomerOrders(customerName) {
  if (!customerName) return { ok: false, error: 'Missing customer' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found' };
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var dataStartRow = hc.headerRowNumber + 1;
  var data = sheet.getRange(dataStartRow, 1, Math.max(0, sheet.getLastRow() - hc.headerRowNumber), sheet.getLastColumn()).getValues();

  var customerIdx = salesCol(col, header, 'Customer', ['customer']);
  var qtyIdx = salesCol(col, header, 'Qty', ['qty']);
  var lineTotalIdx = salesCol(col, header, 'Line Total', ['line', 'total']);
  var productIdx = salesCol(col, header, 'Product Name', ['product', 'name']);
  var packagingIdx = salesCol(col, header, 'Packaging Format', ['packaging']);
  var poDateIdx = salesCol(col, header, 'PO Date', ['po', 'date']);
  var statusIdx = salesCol(col, header, 'Invoice Status', ['invoice', 'status']);
  var invoiceIdx = salesCol(col, header, 'Invoice #', ['invoice', '#']);
  var repIdx = salesCol(col, header, 'Sales Rep', ['sales', 'rep']);

  var target = String(customerName).trim().toLowerCase();
  var totalQty = 0, totalLine = 0, orderCount = 0;
  var invoiceMap = {};
  var invoiceOrder = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (customerIdx === -1) continue;
    if (!customerMatches(row[customerIdx], target)) continue;
    orderCount++;
    var qty = Number(qtyIdx === -1 ? 0 : row[qtyIdx]) || 0;
    var lineTotal = Number(lineTotalIdx === -1 ? 0 : row[lineTotalIdx]) || 0;
    totalQty += qty;
    totalLine += lineTotal;

    var invoiceNumber = invoiceIdx === -1 ? '' : String(row[invoiceIdx] || '');
    var poDate = poDateIdx === -1 ? '' : row[poDateIdx];
    var groupKey = invoiceNumber || ('__noinv_' + i);

    if (!invoiceMap[groupKey]) {
      invoiceMap[groupKey] = {
        invoiceNumber: invoiceNumber,
        poDate: poDate,
        status: statusIdx === -1 ? '' : row[statusIdx],
        salesRep: repIdx === -1 ? '' : row[repIdx],
        qty: 0,
        lineTotal: 0,
        lines: []
      };
      invoiceOrder.push(groupKey);
    }
    var group = invoiceMap[groupKey];
    group.qty += qty;
    group.lineTotal += lineTotal;
    group.lines.push({
      product: productIdx === -1 ? '' : row[productIdx],
      packaging: packagingIdx === -1 ? '' : row[packagingIdx],
      qty: qty
    });
  }

  var orders = invoiceOrder.map(function (k) { return invoiceMap[k]; });
  orders.sort(function (a, b) { return new Date(b.poDate) - new Date(a.poDate); });

  return {
    ok: true,
    customer: customerName,
    totalOrders: orders.length,
    totalQty: totalQty,
    totalLineValue: totalLine,
    orders: orders
  };
}

// Powers the "Reorder Last Order" shortcut: the most recent order for one
// customer, with productCode per line (handleCustomerOrders omits it --
// fine for a history list, not enough to reconstruct a re-orderable
// selection). Same invoice-grouping/sort as handleCustomerOrders, just
// narrowed to the single newest group and one extra field per line.
function handleLastOrder(customerName) {
  if (!customerName) return { ok: false, error: 'Missing customer' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found' };
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var dataStartRow = hc.headerRowNumber + 1;
  var data = sheet.getRange(dataStartRow, 1, Math.max(0, sheet.getLastRow() - hc.headerRowNumber), sheet.getLastColumn()).getValues();

  var customerIdx = salesCol(col, header, 'Customer', ['customer']);
  var qtyIdx = salesCol(col, header, 'Qty', ['qty']);
  var productIdx = salesCol(col, header, 'Product Name', ['product', 'name']);
  var packagingIdx = salesCol(col, header, 'Packaging Format', ['packaging']);
  var productCodeIdx = salesCol(col, header, 'Product Code', ['product', 'code']);
  var poDateIdx = salesCol(col, header, 'PO Date', ['po', 'date']);
  var invoiceIdx = salesCol(col, header, 'Invoice #', ['invoice', '#']);
  var notesIdx = salesCol(col, header, 'Notes', ['notes']);

  var target = String(customerName).trim().toLowerCase();
  var invoiceMap = {};
  var invoiceOrder = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (customerIdx === -1) continue;
    if (!customerMatches(row[customerIdx], target)) continue;

    var invoiceNumber = invoiceIdx === -1 ? '' : String(row[invoiceIdx] || '');
    var poDate = poDateIdx === -1 ? '' : row[poDateIdx];
    var groupKey = invoiceNumber || ('__noinv_' + i);

    if (!invoiceMap[groupKey]) {
      invoiceMap[groupKey] = {
        invoiceNumber: invoiceNumber,
        poDate: poDate,
        notes: notesIdx === -1 ? '' : row[notesIdx],
        lines: []
      };
      invoiceOrder.push(groupKey);
    }
    invoiceMap[groupKey].lines.push({
      product: productIdx === -1 ? '' : row[productIdx],
      packaging: packagingIdx === -1 ? '' : row[packagingIdx],
      productCode: productCodeIdx === -1 ? '' : row[productCodeIdx],
      qty: Number(qtyIdx === -1 ? 0 : row[qtyIdx]) || 0
    });
  }

  if (!invoiceOrder.length) return { ok: true, hasOrder: false };

  var orders = invoiceOrder.map(function (k) { return invoiceMap[k]; });
  orders.sort(function (a, b) { return new Date(b.poDate) - new Date(a.poDate); });
  var last = orders[0];

  return {
    ok: true,
    hasOrder: true,
    poDate: last.poDate,
    notes: last.notes,
    lines: last.lines.filter(function (l) { return l.productCode && l.qty > 0; })
  };
}

// Every order across every rep, most recent first -- powers the admin
// "All Orders" dashboard. Same invoice-grouping logic as handleStats/
// handleCustomerOrders, just with no rep/customer filter.
function handleAllOrders() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found' };
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var dataStartRow = hc.headerRowNumber + 1;
  var data = sheet.getRange(dataStartRow, 1, Math.max(0, sheet.getLastRow() - hc.headerRowNumber), sheet.getLastColumn()).getValues();

  var repIdx = salesCol(col, header, 'Sales Rep', ['sales', 'rep']);
  var qtyIdx = salesCol(col, header, 'Qty', ['qty']);
  var lineTotalIdx = salesCol(col, header, 'Line Total', ['line', 'total']);
  var customerIdx = salesCol(col, header, 'Customer', ['customer']);
  var productIdx = salesCol(col, header, 'Product Name', ['product', 'name']);
  var packagingIdx = salesCol(col, header, 'Packaging Format', ['packaging']);
  var poDateIdx = salesCol(col, header, 'PO Date', ['po', 'date']);
  var statusIdx = salesCol(col, header, 'Invoice Status', ['invoice', 'status']);
  var invoiceIdx = salesCol(col, header, 'Invoice #', ['invoice', '#']);

  var totalQty = 0, totalLine = 0;
  var invoiceMap = {};
  var invoiceOrder = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var qty = Number(qtyIdx === -1 ? 0 : row[qtyIdx]) || 0;
    var lineTotal = Number(lineTotalIdx === -1 ? 0 : row[lineTotalIdx]) || 0;
    var customer = customerIdx === -1 ? '' : row[customerIdx];
    if (!customer && !(invoiceIdx !== -1 && row[invoiceIdx])) continue; // skip fully-blank rows

    totalQty += qty;
    totalLine += lineTotal;

    var invoiceNumber = invoiceIdx === -1 ? '' : String(row[invoiceIdx] || '');
    var poDate = poDateIdx === -1 ? '' : row[poDateIdx];
    var groupKey = invoiceNumber || ('__noinv_' + i);

    if (!invoiceMap[groupKey]) {
      invoiceMap[groupKey] = {
        invoiceNumber: invoiceNumber,
        customer: customer,
        rep: repIdx === -1 ? '' : row[repIdx],
        poDate: poDate,
        status: statusIdx === -1 ? '' : row[statusIdx],
        qty: 0,
        lineTotal: 0,
        lines: []
      };
      invoiceOrder.push(groupKey);
    }
    var group = invoiceMap[groupKey];
    group.qty += qty;
    group.lineTotal += lineTotal;
    group.lines.push({
      product: productIdx === -1 ? '' : row[productIdx],
      packaging: packagingIdx === -1 ? '' : row[packagingIdx],
      qty: qty
    });
  }

  var orders = invoiceOrder.map(function (k) { return invoiceMap[k]; });
  orders.sort(function (a, b) { return new Date(b.poDate) - new Date(a.poDate); });

  return {
    ok: true,
    totalOrders: orders.length,
    totalQty: totalQty,
    totalLineValue: totalLine,
    orders: orders
  };
}

// Canonical prices, sourced from the "Product Information" tab of
// TLM Distribution Master File.xlsx (Price column) -- server is the source of
// truth here, not whatever the client happened to send, so a stale app build
// can never write a wrong price to the sheet.
var PRICE_MAP = {
  'CNT1AKHB01': 192.00,
  'CNT1AKSB01': 96.00,
  'CNT1AC1224': 31.70,
  'SGB1AKHB01': 205.00,
  'SGB1AKSB01': 99.50,
  'SGB1AC1224': 36.25
};

// TODO: fill in the missing UPCs below -- confirmed real values only for the
// two Sunlight Groove kegs (pulled from actual customer invoices); the rest
// are placeholders until we get the full list.
var UPC_MAP = {
  'CNT1AKHB01': '',
  'CNT1AKSB01': '',
  'CNT1AC1224': '',
  'SGB1AKHB01': '850067945086',
  'SGB1AKSB01': '850067945208',
  'SGB1AC1224': ''
};

// Flat per-keg deposit, both sizes -- confirmed by Jack Begley 2026-08-24.
var KEG_DEPOSIT_PER_UNIT = 35.00;

// Derived from 270 historical Sales rows cross-referenced against Customer
// Accounts region: T. Gilbert's Bay Area territory (SF/North Bay/Burlingame/
// San Rafael) fulfills from EWD in 97%+ of orders; everything else (LA, Long
// Beach, Arcadia, Orange County, San Diego) defaults to WLA Warehouse per
// explicit confirmation -- OC/San Diego historical data was too noisy to
// trust on its own (rep names, not warehouse names, were in that column).
var BAY_AREA_REGION_KEYWORDS = ['san francisco', 'north bay', 'burlingame', 'san rafael'];

function isBayAreaRegion(region) {
  var r = String(region || '').toLowerCase();
  for (var i = 0; i < BAY_AREA_REGION_KEYWORDS.length; i++) {
    if (r.indexOf(BAY_AREA_REGION_KEYWORDS[i]) !== -1) return true;
  }
  return false;
}

function warehouseForRegion(region) {
  return isBayAreaRegion(region) ? 'EWD' : 'WLA Warehouse';
}

// Existing invoice numbers look like INV26249, INV26252, etc. Finds the
// highest numeric suffix in the column and returns the next one, padded to
// match the existing digit width.
function nextInvoiceNumber(sheet, invoiceColIdx, headerRowNumber) {
  if (invoiceColIdx === -1) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow <= headerRowNumber) return 'INV00001';
  var values = sheet.getRange(headerRowNumber + 1, invoiceColIdx + 1, lastRow - headerRowNumber, 1).getValues();
  var maxNum = 0, digitWidth = 5;
  values.forEach(function (r) {
    var m = /^INV(\d+)$/i.exec(String(r[0] || '').trim());
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
      digitWidth = m[1].length;
    }
  });
  var next = String(maxNum + 1);
  while (next.length < digitWidth) next = '0' + next;
  return 'INV' + next;
}

// ---- First-order tracking (Customer Accounts tab, not the Sales tab) ----
// Used to scan the Sales tab for "has this customer name ever appeared
// before" -- unreliable, because historical/Ekos-imported rows store the
// customer as "Legal Entity / DBA Name" (see customerMatches) while this
// app always submits just the DBA name, so an account that has clearly
// ordered from us for years could still read as "no prior row found" and
// wrongly fire the :tada: FIRST ORDER Slack message. Tracked explicitly
// instead: every account that already existed before this column was added
// gets backfilled to TRUE one time (handleBackfillFirstOrderFlag) and can
// never trigger it again; a brand-new account created via handleAddCustomer
// starts blank, so its first-ever order through this app is the one and
// only time it fires -- handleOrder then marks it TRUE immediately.
// Fails safe in every ambiguous case (column not set up yet, account not
// found) by treating it as "already sent" -- never claims FIRST ORDER
// without being sure.
var FIRST_ORDER_SENT_HEADER = 'First Order Sent';

function findCustomerAccountRow(sheet, header, businessName) {
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });
  var nameIdx = col['Business Name'];
  if (nameIdx === undefined) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return null;
  var data = sheet.getRange(3, 1, lastRow - 2, sheet.getLastColumn()).getValues();
  var target = String(businessName || '').trim().toLowerCase();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][nameIdx] || '').trim().toLowerCase() === target) {
      return { rowNumber: i + 3, col: col };
    }
  }
  return null;
}

function hasSentFirstOrder(customerName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) return true;
  var header = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var found = findCustomerAccountRow(sheet, header, customerName);
  if (!found) return true; // unknown account -- don't guess, don't claim first order
  var idx = found.col[FIRST_ORDER_SENT_HEADER];
  if (idx === undefined) return true; // column not set up on this sheet yet
  var value = sheet.getRange(found.rowNumber, idx + 1).getValue();
  return value === true || value === 'TRUE' || String(value || '').trim() !== '';
}

function markFirstOrderSent(customerName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) return;
  var header = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var found = findCustomerAccountRow(sheet, header, customerName);
  if (!found) return;
  var idx = found.col[FIRST_ORDER_SENT_HEADER];
  if (idx === undefined) return;
  sheet.getRange(found.rowNumber, idx + 1).setValue(true);
}

// One-time setup: marks every EXISTING Customer Accounts row as having
// already sent its first-order notification, since (per the person who
// asked for this) any account already in the system has already ordered
// from us in the past -- only accounts created AFTER this rollout should
// ever be eligible to fire FIRST ORDER. Only touches rows where the flag is
// currently blank, so it's safe to run more than once, but it should only
// ever be run once in practice -- running it again after real new accounts
// with a genuinely blank flag exist would wrongly silence their first order.
function handleBackfillFirstOrderFlag() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Customer Accounts tab not found' };
  var header = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });
  var nameIdx = col['Business Name'];
  var flagIdx = col[FIRST_ORDER_SENT_HEADER];
  if (nameIdx === undefined) return { ok: false, error: 'Business Name column not found' };
  if (flagIdx === undefined) return { ok: false, error: 'First Order Sent column not found -- add the header cell first' };

  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return { ok: true, updated: 0 };
  var range = sheet.getRange(3, 1, lastRow - 2, sheet.getLastColumn());
  var data = range.getValues();
  var updated = 0;
  for (var i = 0; i < data.length; i++) {
    var name = String(data[i][nameIdx] || '').trim();
    var flag = data[i][flagIdx];
    if (name && String(flag || '').trim() === '') {
      data[i][flagIdx] = true;
      updated++;
    }
  }
  range.setValues(data);
  return { ok: true, updated: updated, totalRows: data.length };
}

function handleOrder(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found' };
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;

  var idx = {
    invoiceNumber: salesCol(col, header, 'Invoice #', ['invoice', '#']),
    customer: salesCol(col, header, 'Customer', ['customer']),
    license: salesCol(col, header, 'License Number', ['license']),
    poDate: salesCol(col, header, 'PO Date', ['po', 'date']),
    deliveryDate: salesCol(col, header, 'Delivery (Invoice) Date', ['delivery', 'date']),
    productName: salesCol(col, header, 'Product Name', ['product', 'name']),
    packagingFormat: salesCol(col, header, 'Packaging Format', ['packaging']),
    productCode: salesCol(col, header, 'Product Code', ['product', 'code']),
    qty: salesCol(col, header, 'Qty', ['qty']),
    price: salesCol(col, header, 'Price (ea)', ['price']),
    lineTotal: salesCol(col, header, 'Line Total', ['line', 'total']),
    inventorySource: salesCol(col, header, 'Inventory Source', ['inventory', 'source']),
    bol: salesCol(col, header, 'BOL #', ['bol']),
    createdByOrderForm: salesCol(col, header, 'Created by Order Form', ['created', 'by', 'order', 'form']),
    salesRep: salesCol(col, header, 'Sales Rep', ['sales', 'rep']),
    paymentMethod: salesCol(col, header, 'Payment Method', ['payment', 'method']),
    invoiceStatus: salesCol(col, header, 'Invoice Status', ['invoice', 'status']),
    notes: salesCol(col, header, 'Notes', ['notes']),
    expectedEmptyKegs: salesCol(col, header, 'Expected Empty Kegs', ['expected', 'empty'])
  };

  var lines = body.lines || [];
  if (!lines.length) return { ok: false, error: 'No line items in order' };

  var isFirstOrder = !hasSentFirstOrder(body.customer);
  if (isFirstOrder) markFirstOrderSent(body.customer);

  var warehouse = warehouseForRegion(body.region);
  // Not populated yet -- the app doesn't collect a delivery date until the
  // clean city/day schedule is wired in. BOL # depends on it (see
  // nextBolNumber), so both stay blank for ops to fill until then.
  var deliveryDate = body.deliveryDate || '';

  var orderTotal = 0;
  var lineSummaries = [];
  // One invoice number per order, not per line -- compute it once up front so
  // every line in this submission shares it (nextInvoiceNumber re-scans the
  // sheet each call, so computing it per-line would hand out a fresh number
  // to every additional line item in a multi-product order).
  var invoiceNumber = idx.invoiceNumber !== -1 ? (nextInvoiceNumber(sheet, idx.invoiceNumber, hc.headerRowNumber) || '') : '';

  lines.forEach(function (line) {
    var row = new Array(header.length).fill('');
    var price = PRICE_MAP[line.productCode];
    var qty = Number(line.qty) || 0;
    var lineTotal = (price !== undefined) ? Math.round(price * qty * 100) / 100 : '';
    if (lineTotal) orderTotal += lineTotal;
    lineSummaries.push('• ' + formatOrderLineForSlack(line, qty));

    if (idx.invoiceNumber !== -1) row[idx.invoiceNumber] = invoiceNumber;
    if (idx.customer !== -1) row[idx.customer] = body.customer || '';
    if (idx.license !== -1) row[idx.license] = body.licenseNumber || '';
    if (idx.poDate !== -1) row[idx.poDate] = body.poDate || '';
    if (idx.deliveryDate !== -1) row[idx.deliveryDate] = deliveryDate;
    if (idx.productName !== -1) row[idx.productName] = line.productName || '';
    if (idx.packagingFormat !== -1) row[idx.packagingFormat] = line.packagingFormat || '';
    if (idx.productCode !== -1) row[idx.productCode] = line.productCode || '';
    if (idx.qty !== -1) row[idx.qty] = qty || '';
    if (idx.price !== -1) row[idx.price] = price !== undefined ? price : '';
    if (idx.lineTotal !== -1) row[idx.lineTotal] = lineTotal;
    if (idx.inventorySource !== -1) row[idx.inventorySource] = warehouse;
    if (idx.bol !== -1) row[idx.bol] = deliveryDate ? nextBolNumber(sheet, idx.bol, hc.headerRowNumber, warehouse, deliveryDate) : '';
    if (idx.createdByOrderForm !== -1) row[idx.createdByOrderForm] = true;
    if (idx.salesRep !== -1) row[idx.salesRep] = body.rep || '';
    if (idx.paymentMethod !== -1) row[idx.paymentMethod] = body.paymentMethod || '';
    if (idx.invoiceStatus !== -1) row[idx.invoiceStatus] = 'Not Created';
    if (idx.notes !== -1) row[idx.notes] = body.notes || '';
    if (idx.expectedEmptyKegs !== -1) row[idx.expectedEmptyKegs] = body.expectedEmptyKegs || '';
    sheet.appendRow(row);
    extendTableForNewRow(sheet);
  });

  // Uses chat.postMessage (not the plain notifySlackForOrder webhook) so the
  // response carries {channel, ts} -- the rep app's confirmation screen
  // needs that message reference to deep-link straight to this order's
  // thread. Falls back to the old webhook only if the bot token/channel
  // aren't configured, so a Slack misconfiguration still notifies ops even
  // though the app won't have a thread link to offer that rep.
  var slackText =
    (isFirstOrder ? ':tada: *FIRST ORDER* ' : ':beer: *NEW ORDER* ') + 'from ' + (body.rep || 'a rep') + ' for *' + (body.customer || 'unknown account') + '*\n' +
    lineSummaries.join('\n') +
    (orderTotal ? '\n*Total:* $' + orderTotal.toFixed(2) : '') +
    (body.expectedEmptyKegs ? '\n:package: Expected empties to pick up: ' + body.expectedEmptyKegs : '') +
    (body.tapHandleNeeded === 'Yes' ? '\n:beers: *Tap handle needed* -- bring one on this delivery.' : '') +
    (isFirstOrder ? '\n:point_right: First order for this account — confirm draft lines are clean.' : '');
  var slackResult = postSlackMessage(channelForInventorySource(warehouse), slackText);
  if (!slackResult.ok) {
    notifySlackForOrder(body.region, slackText);
  } else {
    // Best-effort -- a failure here never affects the order or the main
    // notification, which have already both succeeded by this point.
    postSlackThreadReply(slackResult.channel, slackResult.ts, ':clipboard: Reply here with fulfillment notes, lot numbers, or delivery updates for this order.');
  }

  return {
    ok: true,
    linesAdded: lines.length,
    invoiceNumber: invoiceNumber,
    slackChannel: slackResult.ok ? slackResult.channel : undefined,
    slackTs: slackResult.ok ? slackResult.ts : undefined
  };
}

// Mirrors assets/js/products.js formats[].unit -- server-side copy because
// Code.gs can't read the client's products.js. Keg deposit only applies to
// keg lines, so this is how handleInvoiceDetail tells keg from case.
var PRODUCT_UNIT_MAP = {
  'CNT1AKHB01': 'keg',
  'CNT1AKSB01': 'keg',
  'CNT1AC1224': 'case',
  'SGB1AKHB01': 'keg',
  'SGB1AKSB01': 'keg',
  'SGB1AC1224': 'case'
};

function termsToDays(terms) {
  var m = /(\d+)/.exec(String(terms || ''));
  return m ? parseInt(m[1], 10) : 30;
}

function addDays(dateVal, days) {
  if (!dateVal) return '';
  var d = new Date(dateVal);
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return d;
}

function handleInvoiceDetail(invoiceNumber) {
  if (!invoiceNumber) return { ok: false, error: 'Missing invoiceNumber' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found' };
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var dataStartRow = hc.headerRowNumber + 1;
  var data = sheet.getRange(dataStartRow, 1, Math.max(0, sheet.getLastRow() - hc.headerRowNumber), sheet.getLastColumn()).getValues();

  var idx = {
    invoiceNumber: salesCol(col, header, 'Invoice #', ['invoice', '#']),
    customer: salesCol(col, header, 'Customer', ['customer']),
    license: salesCol(col, header, 'License Number', ['license']),
    poDate: salesCol(col, header, 'PO Date', ['po', 'date']),
    deliveryDate: salesCol(col, header, 'Delivery (Invoice) Date', ['delivery', 'date']),
    productName: salesCol(col, header, 'Product Name', ['product', 'name']),
    packagingFormat: salesCol(col, header, 'Packaging Format', ['packaging']),
    productCode: salesCol(col, header, 'Product Code', ['product', 'code']),
    qty: salesCol(col, header, 'Qty', ['qty']),
    price: salesCol(col, header, 'Price (ea)', ['price']),
    lineTotal: salesCol(col, header, 'Line Total', ['line', 'total']),
    salesRep: salesCol(col, header, 'Sales Rep', ['sales', 'rep']),
    paymentMethod: salesCol(col, header, 'Payment Method', ['payment', 'method']),
    expectedEmptyKegs: salesCol(col, header, 'Expected Empty Kegs', ['expected', 'empty'])
  };

  var lines = [];
  var shared = null;
  var subtotal = 0;
  var kegQty = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var rowInvoice = idx.invoiceNumber === -1 ? '' : String(row[idx.invoiceNumber] || '');
    if (rowInvoice !== String(invoiceNumber)) continue;

    if (!shared) {
      shared = {
        customer: idx.customer === -1 ? '' : row[idx.customer],
        license: idx.license === -1 ? '' : row[idx.license],
        poDate: idx.poDate === -1 ? '' : row[idx.poDate],
        deliveryDate: idx.deliveryDate === -1 ? '' : row[idx.deliveryDate],
        salesRep: idx.salesRep === -1 ? '' : row[idx.salesRep],
        paymentMethod: idx.paymentMethod === -1 ? '' : row[idx.paymentMethod],
        expectedEmptyKegs: idx.expectedEmptyKegs === -1 ? '' : row[idx.expectedEmptyKegs]
      };
    }

    var productCode = idx.productCode === -1 ? '' : row[idx.productCode];
    var qty = Number(idx.qty === -1 ? 0 : row[idx.qty]) || 0;
    var price = Number(idx.price === -1 ? 0 : row[idx.price]) || 0;
    var lineTotal = Number(idx.lineTotal === -1 ? 0 : row[idx.lineTotal]) || 0;
    var unit = PRODUCT_UNIT_MAP[productCode] || '';
    if (unit === 'keg') kegQty += qty;
    subtotal += lineTotal;

    lines.push({
      productName: idx.productName === -1 ? '' : row[idx.productName],
      packagingFormat: idx.packagingFormat === -1 ? '' : row[idx.packagingFormat],
      productCode: productCode,
      upc: UPC_MAP[productCode] || '',
      qty: qty,
      unitPrice: price,
      total: lineTotal,
      unit: unit
    });
  }

  if (!shared) return { ok: false, error: 'No lines found for invoice ' + invoiceNumber };

  // Cross-reference Customer Accounts for the fields the Sales sheet
  // doesn't carry per-line (phone, addresses, terms, legal entity).
  var customerRecord = findCustomerRecord(shared.customer);

  var kegDepositTotal = Math.round(kegQty * KEG_DEPOSIT_PER_UNIT * 100) / 100;
  var invoiceTotal = Math.round((subtotal + kegDepositTotal) * 100) / 100;
  var paymentTerms = (customerRecord && customerRecord.terms) || 'Net 30';
  var dueDate = addDays(shared.deliveryDate, termsToDays(paymentTerms));

  return {
    ok: true,
    invoiceNumber: invoiceNumber,
    invoiceDate: shared.deliveryDate,
    poDate: shared.poDate,
    dueDate: dueDate,
    paymentTerms: paymentTerms,
    salesRep: shared.salesRep,
    paymentMethod: shared.paymentMethod,
    expectedEmptyKegs: Number(shared.expectedEmptyKegs) || 0,
    shipTo: {
      name: shared.customer,
      address: (customerRecord && customerRecord.address) || '',
      phone: (customerRecord && customerRecord.phone) || '',
      license: shared.license || (customerRecord && customerRecord.licenseNumber) || ''
    },
    billTo: {
      name: shared.customer,
      address: (customerRecord && customerRecord.deliveryAddress) || (customerRecord && customerRecord.address) || ''
    },
    lines: lines,
    subtotal: Math.round(subtotal * 100) / 100,
    kegDepositQty: kegQty,
    kegDepositTotal: kegDepositTotal,
    invoiceTotal: invoiceTotal
  };
}

function findCustomerRecord(customerName) {
  if (!customerName) return null;
  var res = handleCustomers();
  if (!res.ok) return null;
  for (var i = 0; i < res.customers.length; i++) {
    var establishmentName = String(res.customers[i].establishmentName || '').trim().toLowerCase();
    if (customerMatches(customerName, establishmentName)) return res.customers[i];
  }
  return null;
}

// BOL # pattern found in 196 historical rows: {Warehouse}-D-{YYMMDD of the
// delivery date}-{sequence, 2-digit, resets per warehouse per day}. e.g.
// "EWD-D-260821-02" is EWD's 2nd delivery-day BOL for Aug 21, 2026.
function nextBolNumber(sheet, bolColIdx, headerRowNumber, warehouse, deliveryDate) {
  if (bolColIdx === -1 || !deliveryDate) return '';
  var d = new Date(deliveryDate);
  var yymmdd = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyMMdd');
  var prefix = warehouse + '-D-' + yymmdd + '-';
  var lastRow = sheet.getLastRow();
  if (lastRow <= headerRowNumber) return prefix + '01';
  var values = sheet.getRange(headerRowNumber + 1, bolColIdx + 1, lastRow - headerRowNumber, 1).getValues();
  var maxSeq = 0;
  values.forEach(function (r) {
    var v = String(r[0] || '').trim();
    if (v.indexOf(prefix) === 0) {
      var seq = parseInt(v.slice(prefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  var next = String(maxSeq + 1);
  while (next.length < 2) next = '0' + next;
  return prefix + next;
}

function handleCustomers() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Customer Accounts tab not found' };
  var data = sheet.getDataRange().getValues();
  if (data.length < 3) return { ok: true, customers: [] };
  var header = data[1];
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });

  var get = function (row, name) { return col[name] !== undefined ? row[col[name]] : ''; };

  var licenseIdx = findColFuzzy(header, ['license']);
  var getLicense = function (row) { return licenseIdx === -1 ? '' : row[licenseIdx]; };

  var customers = [];
  for (var i = 2; i < data.length; i++) {
    var row = data[i];
    var name = String(get(row, 'Business Name') || '').trim();
    if (!name) continue;
    customers.push({
      establishmentName: name,
      salesRep: get(row, 'Sales Person'),
      region: get(row, 'Region'),
      licenseNumber: String(get(row, 'Alc. License #') || getLicense(row) || ''),
      legalEntity: get(row, 'Legal Name'),
      orderingContact: get(row, 'Ordering Contact'),
      phone: get(row, 'Phone Number'),
      email: get(row, 'Ordering Contact Email'),
      address: get(row, 'Delivery Address'),
      deliveryInstructions: get(row, 'Delivery Instructions'),
      paymentMethod: get(row, 'Payment Method'),
      terms: get(row, 'Terms'),
      priority: get(row, 'Priority'),
      tapHandleRequested: get(row, 'Tap Handles?') === true || get(row, 'Tap Handles?') === 'TRUE' || get(row, 'Tap Handles?') === 'Yes' ? 'Yes' : 'No',
      deliveryAddress: get(row, 'Billing Address (If not the same as shipping)'),
      importedToEkos: get(row, 'Imported to Ekos') === true || get(row, 'Imported to Ekos') === 'TRUE',
      lat: get(row, 'Latitude') !== '' && get(row, 'Latitude') != null ? Number(get(row, 'Latitude')) : null,
      lng: get(row, 'Longitude') !== '' && get(row, 'Longitude') != null ? Number(get(row, 'Longitude')) : null
    });
  }
  return { ok: true, customers: customers };
}

function findColFuzzy(header, mustContainAll) {
  for (var i = 0; i < header.length; i++) {
    var h = String(header[i] || '').toLowerCase();
    var matchesAll = mustContainAll.every(function (k) { return h.indexOf(k) !== -1; });
    if (matchesAll) return i;
  }
  return -1;
}

// Dev-only diagnostic: calls postSlackMessage directly (not through
// handleOrder, which silently swallows a failure into the old webhook
// fallback) so a missing Script Property vs. a real Slack API error are
// distinguishable from outside. Reports presence/absence of the two Script
// Properties as booleans only -- never echoes the actual token/channel
// values back over HTTP.
function handleDebugSlackTest(inventorySource) {
  var props = PropertiesService.getScriptProperties();
  var hasToken = !!props.getProperty('SLACK_BOT_TOKEN');
  var hasChannelBA = !!props.getProperty('SLACK_CHANNEL_BA');
  var hasChannelLA = !!props.getProperty('SLACK_CHANNEL_LA');
  var channel = channelForInventorySource(inventorySource || 'EWD');
  var result = postSlackMessage(channel, ':mag: Diagnostic ping from handleDebugSlackTest -- safe to ignore.');
  return {
    ok: true,
    hasToken: hasToken,
    hasChannelBA: hasChannelBA,
    hasChannelLA: hasChannelLA,
    resolvedChannel: channel || null,
    postResult: result
  };
}

// One-time lookup: the workspace's Slack subdomain (e.g. "theleopardmark"
// for theleopardmark.slack.com) isn't a secret -- it's visible in the
// address bar to anyone using Slack in a browser -- but nothing in this
// codebase had a copy of it until the confirmation screen's Slack link
// needed to build a proper thread-reply permalink (the slack:// app-scheme
// deep link has no equivalent of the web permalink's thread_ts parameter).
// auth.test (not team.info) on purpose -- it's scope-exempt, works with
// whatever token this bot already has, and its response includes the
// workspace's own url, so this needs no new scope/reinstall round trip.
function handleDebugSlackTeamInfo() {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'SLACK_BOT_TOKEN not configured' };
  try {
    var resp = UrlFetchApp.fetch('https://slack.com/api/auth.test', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    var json = JSON.parse(resp.getContentText());
    if (!json.ok) return { ok: false, error: json.error || 'Slack API reported failure' };
    return { ok: true, url: json.url, team: json.team };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function handleDebugHeaders() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Customer Accounts tab not found' };
  var header = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  return { ok: true, headers: header.map(function (h, i) { return { index: i, raw: h, json: JSON.stringify(h) }; }) };
}

function handleDebugSales(rows) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found', sheetName: SALES_SHEET_NAME };
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var hc = getSalesHeaderAndCol(sheet);
  var n = parseInt(rows, 10) || 5;
  var tailStart = Math.max(1, lastRow - n + 1);
  var tail = sheet.getRange(tailStart, 1, lastRow - tailStart + 1, lastCol).getValues();
  return {
    ok: true,
    lastRow: lastRow,
    lastCol: lastCol,
    detectedHeaderRowNumber: hc.headerRowNumber,
    detectedHeader: hc.header,
    tailStartRow: tailStart,
    tailRows: tail
  };
}

function handleAddCustomer(customer) {
  if (!customer || !customer.establishmentName) return { ok: false, error: 'Missing customer data' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Customer Accounts tab not found' };
  var header = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });

  var row = new Array(header.length).fill('');
  set(row, col, 'Business Name', customer.establishmentName);
  set(row, col, 'Sales Person', customer.salesRep);
  set(row, col, 'Region', customer.region);
  if (col['Alc. License #'] !== undefined) row[col['Alc. License #']] = customer.licenseNumber || '';
  else { var licIdx = findColFuzzy(header, ['license']); if (licIdx !== -1) row[licIdx] = customer.licenseNumber || ''; }
  set(row, col, 'Ordering Contact', customer.orderingContact);
  set(row, col, 'Phone Number', customer.phone);
  set(row, col, 'Ordering Contact Email', customer.email);
  set(row, col, 'Delivery Address', customer.address);
  set(row, col, 'Delivery Instructions', customer.deliveryInstructions);
  set(row, col, 'Billing Address (If not the same as shipping)', customer.deliveryAddress);
  set(row, col, 'Payment Method', customer.paymentMethod || 'Not Set Up');
  // The actual header is "Tap Handles?" -- this used to say 'Tap Handle
  // Requested', which never matched, so this value was silently dropped on
  // every new account until now.
  set(row, col, 'Tap Handles?', customer.tapHandleRequested || 'No');
  set(row, col, 'Imported to Ekos', false);
  sheet.appendRow(row);
  extendTableForNewRow(sheet);

  notifySlack(
    ':new: *NEW ACCOUNT* added by ' + (customer.salesRep || 'a rep') + ': *' + customer.establishmentName + '*' +
    (customer.region ? ' (' + customer.region + ')' : '')
  );

  return { ok: true };
}

function set(row, col, name, value) {
  if (col[name] !== undefined) row[col[name]] = value || '';
}

// Edits an existing Customer Accounts row in place (contact + billing/address
// fields only -- salesRep, legalEntity, and Imported to Ekos are left alone).
// Looked up by Business Name, same matching rule as everywhere else.
function handleUpdateCustomer(customer) {
  if (!customer || !customer.establishmentName) return { ok: false, error: 'Missing establishmentName' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Customer Accounts tab not found' };
  var data = sheet.getDataRange().getValues();
  if (data.length < 3) return { ok: false, error: 'No customers found' };
  var header = data[1];
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });
  var licenseIdx = col['Alc. License #'] !== undefined ? col['Alc. License #'] : findColFuzzy(header, ['license']);

  var target = String(customer.establishmentName).trim().toLowerCase();
  var rowIndex = -1;
  for (var i = 2; i < data.length; i++) {
    var name = String(data[i][col['Business Name']] || '').trim().toLowerCase();
    if (name === target) { rowIndex = i; break; }
  }
  if (rowIndex === -1) return { ok: false, error: 'Account not found: ' + customer.establishmentName };

  var rowNum = rowIndex + 1;
  var setCell = function (colName, value) {
    if (value === undefined) return;
    var idx = col[colName];
    if (idx === undefined) return;
    sheet.getRange(rowNum, idx + 1).setValue(value);
  };

  setCell('Ordering Contact', customer.orderingContact);
  setCell('Phone Number', customer.phone);
  setCell('Ordering Contact Email', customer.email);
  setCell('Delivery Address', customer.address);
  setCell('Delivery Instructions', customer.deliveryInstructions);
  setCell('Billing Address (If not the same as shipping)', customer.deliveryAddress);
  setCell('Region', customer.region);
  setCell('Payment Method', customer.paymentMethod);
  setCell('Terms', customer.terms);
  setCell('Tap Handles?', customer.tapHandleRequested);
  if (customer.licenseNumber !== undefined && licenseIdx !== -1) {
    sheet.getRange(rowNum, licenseIdx + 1).setValue(customer.licenseNumber);
  }

  return { ok: true };
}

// =====================================================================
// Phase 2 -- Sheet <-> Postgres sync
// See /Users/jackbegley/.claude/plans/jazzy-pondering-rivest.md ("Sheet sync
// architecture") for the full design. Two directions:
//   DB -> Sheet:  Next.js POSTs action:'syncOrder'   -> handleSyncOrder
//   Sheet -> DB:  this project POSTs to a Next.js webhook, driven by
//                 onEditInstallable (near-real-time) and
//                 hourlyReconcileSyncRows (backstop), via drainDirtySyncRows.
// Script Properties this section depends on (set once via the Apps Script
// editor's Project Settings, never hardcoded here):
//   SYNC_SHARED_SECRET  -- shared secret, both directions
//   NEXTJS_WEBHOOK_URL  -- POST target for the Sheet -> DB direction
// =====================================================================

// notifySlackForOrder buckets purely by isBayAreaRegion(region) doing a
// keyword search on a region label -- this endpoint doesn't get a region,
// but warehouseForRegion already pairs EWD with the Bay Area and everything
// else with WLA Warehouse, so inventorySource is a fair proxy for the same
// bucket without asking the wire protocol to carry a redundant region field.
function regionHintForInventorySource(inventorySource) {
  return inventorySource === 'EWD' ? 'san francisco' : '';
}

// Same Bay-Area/LA bucketing as notifySlackForOrder, but returns a channel
// ID (for chat.postMessage) instead of picking a webhook URL -- webhooks
// can't return a message reference (channel+ts) to build a link back to,
// which is what the rep app's post-submission "Open in Slack" button needs.
// New Script Properties: SLACK_BOT_TOKEN, SLACK_CHANNEL_BA, SLACK_CHANNEL_LA.
function channelForInventorySource(inventorySource) {
  var props = PropertiesService.getScriptProperties();
  var key = inventorySource === 'EWD' ? 'SLACK_CHANNEL_BA' : 'SLACK_CHANNEL_LA';
  return props.getProperty(key);
}

// Posts via the Slack Web API (chat.postMessage), not an Incoming Webhook --
// the only way to get back a {channel, ts} reference to the message just
// posted, which is what a deep link to "open this exact thread" requires.
// Returns {ok:true, channel, ts} on success, {ok:false, error} otherwise;
// never throws (mirrors notifySlackUrl's swallow-on-failure philosophy --
// the order/sync already succeeded by the time this runs, a Slack outage
// must not turn into a caller-visible error here, it just means no deep
// link on the confirmation screen this time).
function postSlackMessage(channelId, text) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token || !channelId) return { ok: false, error: 'Slack bot token or channel not configured' };
  try {
    var resp = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ channel: channelId, text: text }),
      muteHttpExceptions: true
    });
    var json = JSON.parse(resp.getContentText());
    if (!json.ok) return { ok: false, error: json.error || 'Slack API reported failure' };
    return { ok: true, channel: json.channel, ts: json.ts };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Posts a threaded reply under an existing message. Used to seed a real
// thread on every order notification the moment it's posted -- a message
// with zero replies has no persistent "N replies" affordance in Slack's UI,
// so a rep opening the parent message (e.g. via a client/platform that
// doesn't honor the thread_ts/cid permalink params -- confirmed Slack's own
// desktop app doesn't, though mobile does) would otherwise land on a plain
// message with nothing marking it as a thread at all. Seeding one guarantees
// "N replies" is always visible and one click away, on every platform,
// regardless of how the confirmation screen's link itself got opened.
function postSlackThreadReply(channelId, threadTs, text) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token || !channelId || !threadTs) return { ok: false, error: 'Slack bot token, channel, or threadTs missing' };
  try {
    var resp = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ channel: channelId, thread_ts: threadTs, text: text }),
      muteHttpExceptions: true
    });
    var json = JSON.parse(resp.getContentText());
    if (!json.ok) return { ok: false, error: json.error || 'Slack API reported failure' };
    return { ok: true, channel: json.channel, ts: json.ts };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Same shape as customerHasPriorOrder -- scans the Order ID column directly
// (not sync_log) so a retry self-heals even if Postgres crashed between
// "Sheet write succeeded" and "sync_log write succeeded".
function orderIdAlreadySynced(sheet, orderIdColIdx, headerRowNumber, orderId) {
  if (orderIdColIdx === -1 || !orderId) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow <= headerRowNumber) return false;
  var values = sheet.getRange(headerRowNumber + 1, orderIdColIdx + 1, lastRow - headerRowNumber, 1).getValues();
  return values.some(function (r) { return String(r[0] || '').trim() === orderId; });
}

// DB -> Sheet. Wired into doPost as action:'syncOrder'. Appends one row per
// order line, all DB-owned columns filled from the request (never derived
// here -- Postgres already decided invoice number/pricing/warehouse/payment
// method by the time this runs). Idempotent: replaying the same orderId is
// a no-op, not a duplicate append.
function handleSyncOrder(body) {
  var secret = PropertiesService.getScriptProperties().getProperty('SYNC_SHARED_SECRET');
  if (!secret || body.secret !== secret) return { ok: false, error: 'Unauthorized' };
  if (!body.orderId) return { ok: false, error: 'Missing orderId' };

  var lines = body.lines || [];
  if (!lines.length) return { ok: false, error: 'No line items in order' };

  var outcome = handleSyncOrderLocked(body, lines);

  // Best-effort Slack ping, deliberately outside the lock -- a Slack POST
  // has no business holding up other concurrent syncOrder requests waiting
  // on the same script lock (see notifySlackUrl's own swallow-on-failure
  // comment for why this never affects the response either way). Rich
  // message (line items, total, first-order detection) matching what
  // handleOrder's rep-app path has always sent -- an earlier version of
  // this notification was a bare ":link: Synced order..." line, a real
  // regression once this became the only path new rep-app orders take.
  // isFirstOrder comes from the caller (Postgres knows an account's order
  // history; this Apps Script project doesn't) rather than being
  // recomputed here from the Sheet.
  if (outcome.ok && !outcome.alreadySynced) {
    var orderTotal = 0;
    var lineSummaries = lines.map(function (line) {
      var qty = Number(line.qty) || 0;
      if (line.lineTotal) orderTotal += Number(line.lineTotal);
      return '• ' + formatOrderLineForSlack(line, qty);
    });
    var text =
      (body.isFirstOrder ? ':tada: *FIRST ORDER* ' : ':beer: *NEW ORDER* ') +
      'from ' + (body.salesRep || 'a rep') + ' for *' + (body.customer || 'unknown account') + '*\n' +
      lineSummaries.join('\n') +
      (orderTotal ? '\n*Total:* $' + orderTotal.toFixed(2) : '') +
      (body.isFirstOrder ? '\n:point_right: First order for this account — get tap handles out and confirm draft lines are clean.' : '');

    var slackResult = postSlackMessage(channelForInventorySource(body.inventorySource), text);
    if (slackResult.ok) {
      outcome.slackChannel = slackResult.channel;
      outcome.slackTs = slackResult.ts;
    }
  }
  return outcome;
}

// The LockService-guarded critical section of handleSyncOrder, split out so
// the lock (and the try/finally that releases it) covers only the
// idempotency-check + append, not the Slack notify above.
function handleSyncOrderLocked(body, lines) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return { ok: false, error: 'Could not acquire sync lock: ' + err.message };
  }

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
    if (!sheet) return { ok: false, error: 'Sales tab not found' };
    var hc = getSalesHeaderAndCol(sheet);
    var header = hc.header, col = hc.col;

    var idx = {
      orderId: salesCol(col, header, 'Order ID', ['order', 'id']),
      invoiceNumber: salesCol(col, header, 'Invoice #', ['invoice', '#']),
      customer: salesCol(col, header, 'Customer', ['customer']),
      license: salesCol(col, header, 'License Number', ['license']),
      poDate: salesCol(col, header, 'PO Date', ['po', 'date']),
      productName: salesCol(col, header, 'Product Name', ['product', 'name']),
      packagingFormat: salesCol(col, header, 'Packaging Format', ['packaging']),
      productCode: salesCol(col, header, 'Product Code', ['product', 'code']),
      qty: salesCol(col, header, 'Qty', ['qty']),
      price: salesCol(col, header, 'Price (ea)', ['price']),
      lineTotal: salesCol(col, header, 'Line Total', ['line', 'total']),
      salesRep: salesCol(col, header, 'Sales Rep', ['sales', 'rep']),
      paymentMethod: salesCol(col, header, 'Payment Method', ['payment', 'method']),
      inventorySource: salesCol(col, header, 'Inventory Source', ['inventory', 'source']),
      invoiceStatus: salesCol(col, header, 'Invoice Status', ['invoice', 'status']),
      notes: salesCol(col, header, 'Notes', ['notes'])
    };

    // Order ID is the idempotency key for this whole endpoint. If the
    // column doesn't exist yet there's nothing to dedupe against -- fail
    // loudly instead of silently risking a duplicate append on retry.
    if (idx.orderId === -1) return { ok: false, error: 'Order ID column not found -- add it before syncing' };

    if (orderIdAlreadySynced(sheet, idx.orderId, hc.headerRowNumber, body.orderId)) {
      return { ok: true, alreadySynced: true };
    }

    // Build every line's row array BEFORE writing anything, then write them
    // all in ONE setValues() call. This replaced an earlier version that
    // called sheet.appendRow() once per line in a loop -- adversarial review
    // found that a mid-loop failure (a transient Sheets API/quota error on,
    // say, line 3 of 5) would leave lines 1-2 permanently in the Sheet
    // *with the orderId already stamped*, so orderIdAlreadySynced would then
    // treat any retry as a no-op replay and never append the missing lines
    // -- silent, permanent data loss that looked like success. A single
    // setValues() over a contiguous range is one atomic Sheets operation:
    // either every line lands, or (on failure) none do, and the orderId
    // scan above still correctly sees nothing for a clean retry.
    var startRow = sheet.getLastRow() + 1;
    var rowsToWrite = lines.map(function (line) {
      var row = new Array(header.length).fill('');
      if (idx.orderId !== -1) row[idx.orderId] = body.orderId;
      if (idx.invoiceNumber !== -1) row[idx.invoiceNumber] = body.invoiceNumber || '';
      if (idx.customer !== -1) row[idx.customer] = body.customer || '';
      if (idx.license !== -1) row[idx.license] = body.licenseNumber || '';
      if (idx.poDate !== -1) row[idx.poDate] = body.poDate || '';
      if (idx.productName !== -1) row[idx.productName] = line.productName || '';
      if (idx.packagingFormat !== -1) row[idx.packagingFormat] = line.packagingFormat || '';
      if (idx.productCode !== -1) row[idx.productCode] = line.productCode || '';
      if (idx.qty !== -1) row[idx.qty] = line.qty || '';
      if (idx.price !== -1) row[idx.price] = line.price !== undefined ? line.price : '';
      if (idx.lineTotal !== -1) row[idx.lineTotal] = line.lineTotal !== undefined ? line.lineTotal : '';
      if (idx.salesRep !== -1) row[idx.salesRep] = body.salesRep || '';
      if (idx.paymentMethod !== -1) row[idx.paymentMethod] = body.paymentMethod || '';
      if (idx.inventorySource !== -1) row[idx.inventorySource] = body.inventorySource || '';
      if (idx.invoiceStatus !== -1) row[idx.invoiceStatus] = body.invoiceStatus || '';
      if (idx.notes !== -1) row[idx.notes] = body.notes || '';
      return row;
    });
    sheet.getRange(startRow, 1, rowsToWrite.length, header.length).setValues(rowsToWrite);

    // One batched Table-range extension for the whole order, not once per
    // line like handleOrder does -- that's fine for rep-app volume (usually
    // 1-3 lines) but wasteful here.
    extendTableForNewRow(sheet);

    // The exact row each line landed on, same order as the request's
    // `lines` array -- lib/sheetSync.ts persists these onto each
    // OrderLine.sheetRowNumber so the Sheet->DB webhook can later target
    // Lot # at the one line a given Sheet row actually represents.
    var lineRows = rowsToWrite.map(function (_, i) { return startRow + i; });

    return { ok: true, alreadySynced: false, rowsAppended: lines.length, lineRows: lineRows };
  } finally {
    lock.releaseLock();
  }
}

// Every Sales row, fully parsed by column name, unfiltered/ungrouped --
// powers the one-time backfill script (which needs to write an Order ID
// back into a specific rowNumber for every historical row, not a
// per-invoice summary the way handleStats/handleAllOrders group things).
function handleAllSalesRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found' };
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var dataStartRow = hc.headerRowNumber + 1;
  var data = sheet.getRange(dataStartRow, 1, Math.max(0, sheet.getLastRow() - hc.headerRowNumber), sheet.getLastColumn()).getValues();

  var idx = {
    invoiceNumber: salesCol(col, header, 'Invoice #', ['invoice', '#']),
    customer: salesCol(col, header, 'Customer', ['customer']),
    license: salesCol(col, header, 'License Number', ['license']),
    poDate: salesCol(col, header, 'PO Date', ['po', 'date']),
    productName: salesCol(col, header, 'Product Name', ['product', 'name']),
    packagingFormat: salesCol(col, header, 'Packaging Format', ['packaging']),
    productCode: salesCol(col, header, 'Product Code', ['product', 'code']),
    qty: salesCol(col, header, 'Qty', ['qty']),
    price: salesCol(col, header, 'Price (ea)', ['price']),
    lineTotal: salesCol(col, header, 'Line Total', ['line', 'total']),
    salesRep: salesCol(col, header, 'Sales Rep', ['sales', 'rep']),
    paymentMethod: salesCol(col, header, 'Payment Method', ['payment', 'method']),
    inventorySource: salesCol(col, header, 'Inventory Source', ['inventory', 'source']),
    invoiceStatus: salesCol(col, header, 'Invoice Status', ['invoice', 'status']),
    notes: salesCol(col, header, 'Notes', ['notes']),
    orderId: salesCol(col, header, 'Order ID', ['order', 'id'])
  };

  var get = function (row, i) { return i === -1 ? '' : row[i]; };

  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var rowNumber = dataStartRow + i; // actual 1-based sheet row -- what the backfill script writes Order IDs back into
    var customer = get(row, idx.customer);
    var invoiceNumber = idx.invoiceNumber === -1 ? '' : String(row[idx.invoiceNumber] || '');
    if (!customer && !invoiceNumber) continue; // skip fully-blank rows, same rule handleAllOrders uses

    rows.push({
      rowNumber: rowNumber,
      invoiceNumber: invoiceNumber,
      customer: customer,
      licenseNumber: get(row, idx.license),
      poDate: get(row, idx.poDate),
      productName: get(row, idx.productName),
      packagingFormat: get(row, idx.packagingFormat),
      productCode: get(row, idx.productCode),
      qty: get(row, idx.qty),
      price: get(row, idx.price),
      lineTotal: get(row, idx.lineTotal),
      salesRep: get(row, idx.salesRep),
      paymentMethod: get(row, idx.paymentMethod),
      inventorySource: get(row, idx.inventorySource),
      invoiceStatus: get(row, idx.invoiceStatus),
      notes: get(row, idx.notes),
      orderId: idx.orderId === -1 ? '' : String(row[idx.orderId] || '')
    });
  }

  return { ok: true, rows: rows };
}

// Wired into doPost as action:'writeOrderIds'. Takes the whole body (not
// just entries) because, like handleSyncOrder, it has to validate
// body.secret before touching anything. Purely additive: powers the
// one-time backfill script writing ULIDs into a previously-blank Order ID
// column, so a cell that's already non-blank (a rerun, or a row that synced
// live in the interim) is skipped rather than clobbered.
function handleWriteOrderIds(body) {
  var secret = PropertiesService.getScriptProperties().getProperty('SYNC_SHARED_SECRET');
  if (!secret || body.secret !== secret) return { ok: false, error: 'Unauthorized' };
  var entries = body.entries || [];
  if (!entries.length) return { ok: false, error: 'No entries provided' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'Sales tab not found' };
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var orderIdColIdx = salesCol(col, header, 'Order ID', ['order', 'id']);
  if (orderIdColIdx === -1) return { ok: false, error: 'Order ID column not found' };

  var written = 0, skipped = 0;
  entries.forEach(function (entry) {
    var rowNumber = Number(entry.rowNumber);
    if (!rowNumber || rowNumber <= hc.headerRowNumber) { skipped++; return; }
    var cell = sheet.getRange(rowNumber, orderIdColIdx + 1);
    var existing = String(cell.getValue() || '').trim();
    if (existing !== '') { skipped++; return; } // never clobber a non-blank Order ID
    cell.setValue(entry.orderId);
    written++;
  });

  return { ok: true, written: written, skipped: skipped };
}

// ---- Sheet -> DB: onEdit dirty-marking + drain + hourly reconcile ----

// Installable trigger (see setupSyncTriggers) -- simple onEdit(e) can't call
// UrlFetchApp, which is why this has to be installed rather than defined as
// a bare `function onEdit(e)`. Only marks rows dirty; never posts anything
// itself (that's drainDirtySyncRows's job) so a burst of edits collapses
// into one batched webhook call instead of one per keystroke.
function onEditInstallable(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== SALES_SHEET_NAME) return;

    var hc = getSalesHeaderAndCol(sheet);
    var startCol = e.range.getColumn();
    var numCols = e.range.getNumColumns();
    var startRow = e.range.getRow();
    var numRows = e.range.getNumRows();

    // A single onEdit event can cover more than one cell (a normal paste, a
    // drag-fill) -- walk every column actually touched, not just the first,
    // so a paste spanning a tracked column isn't silently missed. (Some
    // bulk/paste-special operations don't fire onEdit at all -- that's what
    // hourlyReconcileSyncRows is the backstop for, not this.)
    //
    // Marks dirty for EITHER Sheet-owned OR DB-owned columns, not just
    // Sheet-owned -- an earlier version only tracked Sheet-owned edits,
    // which meant an edit to a DB-owned column (Customer, Price, Order ID,
    // ...) was invisible to this whole pipeline forever, never even reaching
    // the webhook to be flagged as a conflict. That contradicted the design
    // itself, which says a DB-owned Sheet edit must be "flagged as a
    // conflict... per the DB-wins-on-content rule" -- adversarial review
    // caught this. classifySyncColumn still decides what to DO with a
    // tracked edit later (apply vs. conflict); this check only decides
    // whether to notice it at all.
    var touchesTrackedColumn = false;
    for (var c = startCol; c < startCol + numCols; c++) {
      var headerName = String(hc.header[c - 1] || '').trim();
      var ownership = classifySyncColumn(headerName);
      if (ownership === 'sheet_owned' || ownership === 'db_owned') { touchesTrackedColumn = true; break; }
    }
    if (!touchesTrackedColumn) return;

    for (var r = startRow; r < startRow + numRows; r++) {
      addDirtySyncRow(r);
    }
  } catch (err) {
    console.error('onEditInstallable failed (non-fatal): ' + err.message);
  }
}

// Read-modify-write on a single Script Property, guarded by the same script
// lock handleSyncOrder uses -- cheap insurance against two near-simultaneous
// edits racing each other and one dirty row getting dropped. A missed lock
// (5s timeout) just skips this dirty-mark rather than throwing out of
// onEdit and breaking the user's actual edit; worst case that row waits for
// the next hourly reconciliation instead of the 5-minute drain.
function addDirtySyncRow(rowNumber) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (err) {
    console.error('addDirtySyncRow: could not acquire lock: ' + err.message);
    return;
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty('DIRTY_SYNC_ROWS');
    var rows = raw ? JSON.parse(raw) : [];
    if (rows.indexOf(rowNumber) === -1) rows.push(rowNumber);
    props.setProperty('DIRTY_SYNC_ROWS', JSON.stringify(rows));
  } finally {
    lock.releaseLock();
  }
}

// Reads every TRACKED column's current value for one row -- both
// Sheet-owned and DB-owned, not just Sheet-owned. Uses the exact-name
// column map directly (not salesCol's fuzzy fallback) because these are all
// specific, unambiguous header strings -- if one of them isn't on the sheet
// yet, it's just omitted from `fields` rather than fuzzy-matched onto the
// wrong column.
//
// Sending DB-owned columns' current values too (not just Sheet-owned) is
// deliberate, not an oversight: it's what lets the webhook's classifyColumn
// actually flag a conflict when ops edits a DB-owned cell directly (e.g.
// Customer, Order ID). An earlier version of this function only read
// Sheet-owned columns, which meant a DB-owned edit was invisible end-to-end
// -- never even reaching the point where it could be flagged -- despite the
// design explicitly calling for exactly that. Adversarial review caught
// this. The extra columns cost one more cell read per row; at this
// business's order volume that's noise, not a real overhead concern.
function readTrackedFields(header, col, row) {
  var fields = {};
  DB_OWNED_COLUMNS.concat(SHEET_OWNED_COLUMNS).forEach(function (name) {
    if (col[name] === undefined) return;
    fields[name] = row[col[name]];
  });
  return fields;
}

// POSTs one batched payload to the Next.js webhook. Returns true only on an
// HTTP 200 with {ok:true} in the body -- anything else (network failure,
// non-200, malformed JSON) is treated as "didn't land," which both callers
// use to decide whether it's safe to clear their dirty state.
function postSyncWebhook(payload) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('NEXTJS_WEBHOOK_URL');
  var secret = props.getProperty('SYNC_SHARED_SECRET');
  if (!url || !secret) {
    console.error('postSyncWebhook: NEXTJS_WEBHOOK_URL or SYNC_SHARED_SECRET not configured');
    return false;
  }
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Sync-Secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return false;
    var json = JSON.parse(resp.getContentText());
    return !!(json && json.ok === true);
  } catch (err) {
    console.error('postSyncWebhook failed: ' + err.message);
    return false;
  }
}

// Time-driven, every 5 minutes (see setupSyncTriggers). Drains the dirty-row
// set built by onEditInstallable into one batched POST. Rows with no Order
// ID yet (an ops edit landing before the platform-side sync creates the
// row) are kept dirty rather than dropped -- nothing to sync back to until
// an Order ID exists, but the edit shouldn't be lost either.
//
// Two-phase claim/merge, not one long lock: an earlier version read
// DIRTY_SYNC_ROWS, did all its (slow -- one getRange per dirty row, plus a
// network POST) processing, and only THEN wrote the property back --
// entirely without a lock. Adversarial review found this was a real,
// repeatable lost-update bug: any addDirtySyncRow() call landing between
// that read and that write (a real onEdit firing on some other row while
// the drain was mid-flight, which the drain's own multi-second runtime
// makes a live, not just theoretical, hazard) gets silently erased when the
// drain's stale snapshot overwrites the property -- non-deterministically
// losing a genuinely new dirty row until the next hourly reconcile catches
// it. Fix: claim the whole dirty set under a lock (swap it for []), release
// the lock before doing any slow work, then re-acquire the lock only to
// merge whatever accumulated during processing back in -- correct without
// holding the lock for the duration of a network call.
function drainDirtySyncRows() {
  var props = PropertiesService.getScriptProperties();
  var claimLock = LockService.getScriptLock();
  var rows;
  try {
    claimLock.waitLock(10000);
  } catch (err) {
    console.error('drainDirtySyncRows: could not acquire claim lock: ' + err.message);
    return;
  }
  try {
    var raw = props.getProperty('DIRTY_SYNC_ROWS');
    rows = raw ? JSON.parse(raw) : [];
    if (!rows.length) return;
    props.setProperty('DIRTY_SYNC_ROWS', JSON.stringify([])); // claim them all
  } finally {
    claimLock.releaseLock();
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) { mergeDirtyRowsBack(rows); return; } // couldn't process -- give the whole claim back

  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var orderIdColIdx = salesCol(col, header, 'Order ID', ['order', 'id']);
  var invoiceColIdx = salesCol(col, header, 'Invoice #', ['invoice', '#']);
  var lastRow = sheet.getLastRow();

  var edits = [];
  var stillDirty = [];
  rows.forEach(function (rowNumber) {
    if (rowNumber <= hc.headerRowNumber || rowNumber > lastRow) return; // stale entry (e.g. a deleted row) -- drop it
    var orderId = orderIdColIdx === -1 ? '' : String(sheet.getRange(rowNumber, orderIdColIdx + 1).getValue() || '').trim();
    if (!orderId) { stillDirty.push(rowNumber); return; }
    var invoiceNumber = invoiceColIdx === -1 ? '' : String(sheet.getRange(rowNumber, invoiceColIdx + 1).getValue() || '').trim();
    var rowValues = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
    edits.push({
      orderId: orderId,
      invoiceNumber: invoiceNumber,
      rowNumber: rowNumber,
      fields: readTrackedFields(header, col, rowValues)
    });
  });

  if (!edits.length) {
    // Nothing had an Order ID yet -- give stillDirty back for the next
    // drain (stale rows dropped above are simply not re-added).
    mergeDirtyRowsBack(stillDirty);
    return;
  }

  var delivered = postSyncWebhook({ source: 'onedit', edits: edits });
  // Whatever needs to go back: on success, just stillDirty (no Order ID
  // yet); on failure, stillDirty PLUS every row we tried to send, so the
  // next 5-minute run retries all of it, not just the no-Order-ID subset.
  var toReturn = delivered ? stillDirty : stillDirty.concat(edits.map(function (e) { return e.rowNumber; }));
  mergeDirtyRowsBack(toReturn);
}

// Merge-back phase of drainDirtySyncRows: re-acquires the lock only to
// combine `rowsToReturn` with whatever addDirtySyncRow() added to
// DIRTY_SYNC_ROWS while this drain was busy reading the sheet / calling the
// webhook (unlocked, deliberately, so a slow network call never holds up
// other operations waiting on the same script-wide lock).
function mergeDirtyRowsBack(rowsToReturn) {
  if (!rowsToReturn.length) return;
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    console.error('drainDirtySyncRows: could not acquire merge-back lock, dirty rows may be delayed to next hourly reconcile: ' + err.message);
    return;
  }
  try {
    var raw = props.getProperty('DIRTY_SYNC_ROWS');
    var current = raw ? JSON.parse(raw) : [];
    var merged = current.slice();
    rowsToReturn.forEach(function (r) {
      if (merged.indexOf(r) === -1) merged.push(r);
    });
    props.setProperty('DIRTY_SYNC_ROWS', JSON.stringify(merged));
  } finally {
    lock.releaseLock();
  }
}

// Time-driven, hourly (see setupSyncTriggers). Reconciliation backstop: an
// unconditional full refresh of every Sheet-owned field for every
// Order-ID'd row, sent regardless of whether anything changed. This is what
// catches missed webhooks and the known Apps Script gotcha where
// bulk/paste-special edits don't reliably fire onEdit per cell -- simpler
// than this project maintaining its own diff state to detect that.
function hourlyReconcileSyncRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) return;
  var hc = getSalesHeaderAndCol(sheet);
  var header = hc.header, col = hc.col;
  var orderIdColIdx = salesCol(col, header, 'Order ID', ['order', 'id']);
  if (orderIdColIdx === -1) return; // no Order ID column yet -- nothing to reconcile
  var invoiceColIdx = salesCol(col, header, 'Invoice #', ['invoice', '#']);

  var dataStartRow = hc.headerRowNumber + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < dataStartRow) return;
  var data = sheet.getRange(dataStartRow, 1, lastRow - hc.headerRowNumber, sheet.getLastColumn()).getValues();

  var edits = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var orderId = String(row[orderIdColIdx] || '').trim();
    if (!orderId) continue; // not synced from Postgres yet -- nothing to reconcile for this row
    var rowNumber = dataStartRow + i;
    var invoiceNumber = invoiceColIdx === -1 ? '' : String(row[invoiceColIdx] || '');
    edits.push({
      orderId: orderId,
      invoiceNumber: invoiceNumber,
      rowNumber: rowNumber,
      fields: readTrackedFields(header, col, row)
    });
  }

  if (!edits.length) return;
  postSyncWebhook({ source: 'reconcile', edits: edits });
  // Unconditional full refresh -- no local dirty-state to update either way,
  // success or failure. A failed POST just gets fully resent next hour;
  // there's no per-row "still dirty" concept here the way
  // drainDirtySyncRows has one.
}

// ---- One-time manual setup -- NOT auto-invoked ----
// Run this exactly once from the Apps Script editor's Run menu (select
// setupSyncTriggers, click Run) after deploying this file and setting the
// SYNC_SHARED_SECRET / NEXTJS_WEBHOOK_URL Script Properties. It is
// deliberately never called from doGet/doPost or any trigger.
// Re-running it creates a SECOND, duplicate set of triggers -- Apps Script
// happily lets the same function have multiple identical triggers attached,
// which would fire onEditInstallable/drainDirtySyncRows/
// hourlyReconcileSyncRows multiple times per event. If that happens, clean
// up from the Apps Script editor: ScriptApp.getProjectTriggers() lists every
// trigger on the project, ScriptApp.deleteTrigger(trigger) removes one --
// delete the duplicates, leave one of each, don't re-run this function
// afterward.
function setupSyncTriggers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger('onEditInstallable').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('drainDirtySyncRows').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('hourlyReconcileSyncRows').timeBased().everyHours(1).create();
}
