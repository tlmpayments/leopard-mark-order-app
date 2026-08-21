var SALES_SHEET_NAME = 'Sales';
var REPS_SHEET_NAME = 'Reps';
var CUSTOMERS_SHEET_NAME = 'Customer Accounts';

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'login') return respond(handleLogin(e.parameter.name, e.parameter.pin));
    if (action === 'stats') return respond(handleStats(e.parameter.rep));
    if (action === 'customers') return respond(handleCustomers());
    if (action === 'debugHeaders') return respond(handleDebugHeaders());
    if (action === 'debugSales') return respond(handleDebugSales(e.parameter.rows));
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
    return respond({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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
      return { ok: true, rep: rowName };
    }
  }
  return { ok: false, error: 'Invalid name or PIN' };
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

  var totalQty = 0, totalLine = 0, orderCount = 0;
  var recent = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (repIdx === -1) continue;
    if (String(row[repIdx] || '').trim().toLowerCase() !== String(rep || '').trim().toLowerCase()) continue;
    orderCount++;
    var qty = Number(qtyIdx === -1 ? 0 : row[qtyIdx]) || 0;
    var lineTotal = Number(lineTotalIdx === -1 ? 0 : row[lineTotalIdx]) || 0;
    totalQty += qty;
    totalLine += lineTotal;
    recent.push({
      customer: customerIdx === -1 ? '' : row[customerIdx],
      product: productIdx === -1 ? '' : row[productIdx],
      packaging: packagingIdx === -1 ? '' : row[packagingIdx],
      qty: qty,
      poDate: poDateIdx === -1 ? '' : row[poDateIdx],
      status: statusIdx === -1 ? '' : row[statusIdx]
    });
  }

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

// Derived from 270 historical Sales rows cross-referenced against Customer
// Accounts region: T. Gilbert's Bay Area territory (SF/North Bay/Burlingame/
// San Rafael) fulfills from EWD in 97%+ of orders; everything else (LA, Long
// Beach, Arcadia, Orange County, San Diego) defaults to WLA Warehouse per
// explicit confirmation -- OC/San Diego historical data was too noisy to
// trust on its own (rep names, not warehouse names, were in that column).
var BAY_AREA_REGION_KEYWORDS = ['san francisco', 'north bay', 'burlingame', 'san rafael'];

function warehouseForRegion(region) {
  var r = String(region || '').toLowerCase();
  for (var i = 0; i < BAY_AREA_REGION_KEYWORDS.length; i++) {
    if (r.indexOf(BAY_AREA_REGION_KEYWORDS[i]) !== -1) return 'EWD';
  }
  return 'WLA Warehouse';
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

  var warehouse = warehouseForRegion(body.region);
  // Not populated yet -- the app doesn't collect a delivery date until the
  // clean city/day schedule is wired in. BOL # depends on it (see
  // nextBolNumber), so both stay blank for ops to fill until then.
  var deliveryDate = body.deliveryDate || '';

  lines.forEach(function (line) {
    var row = new Array(header.length).fill('');
    var price = PRICE_MAP[line.productCode];
    var qty = Number(line.qty) || 0;
    var lineTotal = (price !== undefined) ? Math.round(price * qty * 100) / 100 : '';

    if (idx.invoiceNumber !== -1) row[idx.invoiceNumber] = nextInvoiceNumber(sheet, idx.invoiceNumber, hc.headerRowNumber) || '';
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

  return { ok: true, linesAdded: lines.length };
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
      deliveryAddress: get(row, 'Billing Address (If not the same as shipping)'),
      importedToEkos: get(row, 'Imported to Ekos') === true || get(row, 'Imported to Ekos') === 'TRUE'
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
  set(row, col, 'Imported to Ekos', false);
  sheet.appendRow(row);
  extendTableForNewRow(sheet);

  return { ok: true };
}

function set(row, col, name, value) {
  if (col[name] !== undefined) row[col[name]] = value || '';
}
