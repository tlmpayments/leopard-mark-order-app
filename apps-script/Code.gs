var SALES_SHEET_NAME = 'Sales';
var REPS_SHEET_NAME = 'Reps';
var CUSTOMERS_SHEET_NAME = 'Customer Accounts';

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'login') return respond(handleLogin(e.parameter.name, e.parameter.pin));
    if (action === 'reps') return respond(handleReps());
    if (action === 'stats') return respond(handleStats(e.parameter.rep));
    if (action === 'customers') return respond(handleCustomers());
    if (action === 'debugHeaders') return respond(handleDebugHeaders());
    if (action === 'debugSales') return respond(handleDebugSales(e.parameter.rows));
    if (action === 'invoiceDetail') return respond(handleInvoiceDetail(e.parameter.invoiceNumber));
    if (action === 'customerOrders') return respond(handleCustomerOrders(e.parameter.customer));
    if (action === 'allOrders') return respond(handleAllOrders());
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

function customerHasPriorOrder(sheet, customerColIdx, headerRowNumber, customerName) {
  if (!customerName) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow <= headerRowNumber) return false;
  var values = sheet.getRange(headerRowNumber + 1, customerColIdx + 1, lastRow - headerRowNumber, 1).getValues();
  return values.some(function (r) { return String(r[0] || '').trim() === customerName.trim(); });
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
    notes: salesCol(col, header, 'Notes', ['notes'])
  };

  var lines = body.lines || [];
  if (!lines.length) return { ok: false, error: 'No line items in order' };

  var isFirstOrder = idx.customer !== -1 && !customerHasPriorOrder(sheet, idx.customer, hc.headerRowNumber, body.customer);

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
    sheet.appendRow(row);
    extendTableForNewRow(sheet);
  });

  notifySlackForOrder(
    body.region,
    (isFirstOrder ? ':tada: *FIRST ORDER* ' : ':beer: *NEW ORDER* ') + 'from ' + (body.rep || 'a rep') + ' for *' + (body.customer || 'unknown account') + '*\n' +
    lineSummaries.join('\n') +
    (orderTotal ? '\n*Total:* $' + orderTotal.toFixed(2) : '') +
    (isFirstOrder ? '\n:point_right: First order for this account — get tap handles out and confirm draft lines are clean.' : '')
  );

  return { ok: true, linesAdded: lines.length, invoiceNumber: invoiceNumber };
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
    paymentMethod: salesCol(col, header, 'Payment Method', ['payment', 'method'])
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
        paymentMethod: idx.paymentMethod === -1 ? '' : row[idx.paymentMethod]
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
      tapHandleRequested: get(row, 'Tap Handle Requested') === true || get(row, 'Tap Handle Requested') === 'TRUE' || get(row, 'Tap Handle Requested') === 'Yes' ? 'Yes' : 'No',
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
  set(row, col, 'Tap Handle Requested', customer.tapHandleRequested || 'No');
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
  setCell('Tap Handle Requested', customer.tapHandleRequested);
  if (customer.licenseNumber !== undefined && licenseIdx !== -1) {
    sheet.getRange(rowNum, licenseIdx + 1).setValue(customer.licenseNumber);
  }

  return { ok: true };
}
