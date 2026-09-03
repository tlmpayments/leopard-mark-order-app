(function () {
  var API = window.LM_CONFIG.APPS_SCRIPT_URL;
  var state = {
    rep: null,
    stats: null,
    selection: {}, // productId -> { formatCode: qty }
    invoiceEdit: null, // working copy of the invoice currently on screen-invoice, see openInvoice()
    customer: null,
    customerPickerReturn: 'screen-order', // which screen screen-customers returns to
    marketing: null, // working state for the marketing materials request, see openMarketingForm()
    customers: loadCachedCustomers() || (window.LM_CUSTOMERS || []).slice()
  };

  var screens = {};
  document.querySelectorAll('.screen').forEach(function (el) { screens[el.id] = el; });

  // Screens that submit something own a sticky footer. Only the active
  // screen's may show, and every other one has to be hidden explicitly --
  // they're position:fixed, so a footer left visible would float over
  // whatever screen comes next.
  var SCREEN_FOOTERS = {
    'screen-order': 'order-footer',
    'screen-marketing': 'marketing-footer'
  };

  function showScreen(id) {
    Object.keys(screens).forEach(function (k) { screens[k].classList.toggle('active', k === id); });
    Object.keys(SCREEN_FOOTERS).forEach(function (screenId) {
      document.getElementById(SCREEN_FOOTERS[screenId]).style.display = screenId === id ? 'flex' : 'none';
    });
    window.scrollTo(0, 0);
  }

  function toast(msg, isError) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  function apiConfigured() {
    return API && API.indexOf('PASTE_YOUR') === -1;
  }

  function apiGet(params) {
    var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    // No credentials: the deployment is public ("Anyone"), which means Apps Script
    // responds with Access-Control-Allow-Origin: * — browsers reject that combined
    // with credentials:'include', which silently breaks the fetch. Leave it out.
    return fetch(API + '?' + qs).then(assertJson);
  }

  function apiPost(body) {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight against Apps Script
      body: JSON.stringify(body)
    }).then(assertJson);
  }

  function assertJson(r) {
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('json') === -1) {
      // Apps Script bounced the request to a Google sign-in page instead of running.
      return r.text().then(function () {
        throw new Error('NOT_SIGNED_IN');
      });
    }
    return r.json();
  }

  // ---------- Session ----------
  function saveSession(rep) {
    localStorage.setItem('lm_rep', rep);
  }
  function loadSession() {
    return localStorage.getItem('lm_rep');
  }
  function clearSession() {
    localStorage.removeItem('lm_rep');
  }

  function loadCachedCustomers() {
    try {
      var raw = localStorage.getItem('lm_customers_cache');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function cacheCustomers(list) {
    try { localStorage.setItem('lm_customers_cache', JSON.stringify(list)); } catch (e) {}
  }

  // Fetches the live account list from the sheet so newly added customers show up
  // for every rep without waiting on a re-export of the bundled customers.js.
  function refreshCustomers() {
    if (!apiConfigured()) return;
    apiGet({ action: 'customers' })
      .then(function (res) {
        if (res.ok && Array.isArray(res.customers) && res.customers.length) {
          state.customers = res.customers;
          cacheCustomers(res.customers);
          if (screens['screen-customers'].classList.contains('active')) {
            renderCustomerList(document.getElementById('customer-search').value);
          }
          updateMyMapButton();
        }
      })
      .catch(function () {
        // Stay on whatever we already have (cache or bundled file) — this is a
        // background refresh, not something that should interrupt the rep.
      });
  }

  // ---------- Login ----------
  function saveRole(role) {
    localStorage.setItem('lm_role', role || 'Rep');
  }
  function loadRole() {
    return localStorage.getItem('lm_role') || 'Rep';
  }

  function completeLogin(rep, role) {
    state.rep = rep;
    state.repRole = role || 'Rep';
    saveSession(rep);
    saveRole(state.repRole);
    enterHome();
  }

  // ---------- PIN login ----------
  // One 4-digit PIN and nothing else. orders.tlmbg.co is rep-only, so the
  // login is as short as it can be: punch four digits and you're in. The PIN
  // identifies the rep by itself -- the Apps Script side (handlePinLogin)
  // looks up whose it is and refuses outright if two active reps share one,
  // rather than guessing and logging someone in as the wrong person.
  //
  // Removed with the name picker: the first-login "choose your own PIN"
  // flow. With no name on screen there is nothing to attach a new PIN to,
  // so PINs are assigned in the Reps tab by whoever manages it. Every
  // active rep already has one; a rep who needs a reset asks for it.
  var PIN_PROMPT = 'Enter your 4-digit PIN';
  var pinState = { digits: '', busy: false };

  function updatePinDots(isError) {
    var dots = document.querySelectorAll('#pin-dots .pin-dot');
    dots.forEach(function (d, i) {
      d.classList.toggle('filled', !isError && i < pinState.digits.length);
      d.classList.toggle('error', !!isError);
    });
  }

  function resetPinPad() {
    pinState.digits = '';
    pinState.busy = false;
    document.getElementById('pin-instructions').textContent = PIN_PROMPT;
    updatePinDots(false);
  }

  function pinDigit(key) {
    // `busy` guards the window between the fourth digit and the server's
    // answer -- without it a double-tap starts a second login attempt, which
    // on a wrong PIN costs the rep two throttle delays instead of one.
    if (pinState.busy) return;
    if (key === 'back') {
      pinState.digits = pinState.digits.slice(0, -1);
      document.getElementById('pin-error').textContent = '';
      updatePinDots(false);
      return;
    }
    if (pinState.digits.length >= 4) return;
    pinState.digits += key;
    updatePinDots(false);
    if (pinState.digits.length === 4) submitPinLogin();
  }

  document.getElementById('pin-pad').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-key]');
    if (!btn) return;
    pinDigit(btn.getAttribute('data-key'));
  });

  // Physical keyboard too -- reps on a laptop shouldn't have to mouse over
  // twelve buttons. Only listens while the login screen is the active one.
  document.addEventListener('keydown', function (e) {
    if (!document.getElementById('screen-login').classList.contains('active')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pinDigit(e.key); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); pinDigit('back'); }
  });

  function submitPinLogin() {
    var errEl = document.getElementById('pin-error');
    var instr = document.getElementById('pin-instructions');
    errEl.textContent = '';
    var pin = pinState.digits;

    if (!apiConfigured()) {
      // Dev fallback so the app is testable before Apps Script is deployed.
      completeLogin('Demo Rep', 'Rep');
      resetPinPad();
      return;
    }

    pinState.busy = true;
    instr.textContent = 'Checking\u2026';

    apiGet({ action: 'pinLogin', pin: pin })
      .then(function (res) {
        if (res && res.ok) {
          completeLogin(res.rep, res.role);
          resetPinPad();
          return;
        }
        errEl.textContent = (res && res.error) || 'Incorrect PIN';
        pinState.busy = false;
        instr.textContent = PIN_PROMPT;
        updatePinDots(true);
        setTimeout(resetPinPad, 500);
      })
      .catch(function (err) {
        errEl.textContent = friendlyApiError(err);
        resetPinPad();
      });
  }

  function friendlyApiError(err) {
    if (err && err.message === 'NOT_SIGNED_IN') {
      return 'Sign in to your Google account first: open the link at the bottom of this page once, sign in, then come back and try again.';
    }
    return 'Could not reach the server. Check your connection.';
  }

  document.getElementById('logout-btn').addEventListener('click', function () {
    clearSession();
    state.rep = null;
    state.repRole = null;
    document.getElementById('pin-error').textContent = '';
    resetPinPad();
    showScreen('screen-login');
  });

  // ---------- Home / stats ----------
  function enterHome() {
    document.getElementById('home-rep-name').textContent = state.rep;
    var regions = window.LM_REP_REGIONS || {};
    document.getElementById('home-rep-region').textContent = regions[state.rep] || (state.repRole === 'Admin' ? 'Admin' : 'Sales Rep');
    document.getElementById('btn-admin-orders').style.display = state.repRole === 'Admin' ? 'flex' : 'none';
    showScreen('screen-home');
    loadStats();
    refreshCustomers();
    updateMyMapButton();
  }

  function loadStats() {
    if (!apiConfigured()) {
      renderStats({ ok: true, totalLineItems: 0, totalQty: 0, recentOrders: [] });
      return;
    }
    apiGet({ action: 'stats', rep: state.rep }).then(renderStats).catch(function () {
      toast('Could not load your stats', true);
    });
  }

  function renderStats(res) {
    if (!res || !res.ok) return;
    state.stats = res;
    document.getElementById('stat-orders').textContent = res.totalLineItems || 0;
    document.getElementById('stat-units').textContent = res.totalQty || 0;

    var host = document.getElementById('order-history');
    var orders = res.recentOrders || [];
    if (!orders.length) {
      host.innerHTML = '<div class="empty-note">No orders yet.</div>';
      return;
    }
    host.innerHTML = orders.map(function (o) {
      var statusClass = String(o.status || 'pending').toLowerCase();
      var lines = o.lines || [];
      var sub = lines.length === 1
        ? escapeHtml(lines[0].product || '') + ' · ' + escapeHtml(lines[0].packaging || '') + ' · Qty ' + lines[0].qty
        : lines.length + ' item' + (lines.length === 1 ? '' : 's') + ' · Qty ' + o.qty;
      var clickable = !!o.invoiceNumber;
      return '<div class="order-row' + (clickable ? ' clickable' : '') + '"' + (clickable ? ' data-invoice="' + escapeHtml(o.invoiceNumber) + '"' : '') + '>' +
        '<div><div class="oname">' + escapeHtml(o.customer || 'Unknown account') + '</div>' +
        '<div class="osub">' + sub + '</div></div>' +
        '<span class="pill ' + statusClass + '">' + escapeHtml(o.status || 'Pending') + '</span>' +
        '</div>';
    }).join('');
  }

  document.getElementById('order-history').addEventListener('click', function (e) {
    var row = e.target.closest('.order-row[data-invoice]');
    if (!row) return;
    openInvoice(row.getAttribute('data-invoice'));
  });

  // ---------- Invoice ----------
  document.getElementById('back-invoice-to-home').addEventListener('click', function () {
    showScreen(state.invoiceReturnTo || 'screen-home');
  });

  function openInvoice(invoiceNumber) {
    var current = Object.keys(screens).filter(function (k) { return screens[k].classList.contains('active'); })[0];
    if (current && current !== 'screen-invoice') state.invoiceReturnTo = current;
    showScreen('screen-invoice');
    document.getElementById('invoice-loading').style.display = 'block';
    document.getElementById('invoice-loading').textContent = 'Loading invoice…';
    document.getElementById('invoice-doc').style.display = 'none';
    document.getElementById('invoice-print-btn').style.display = 'none';

    apiGet({ action: 'invoiceDetail', invoiceNumber: invoiceNumber })
      .then(function (res) {
        if (!res.ok) { document.getElementById('invoice-loading').textContent = res.error || 'Could not load invoice.'; return; }
        state.invoiceEdit = cloneInvoiceForEdit(res);
        renderEditableInvoice();
        document.getElementById('invoice-loading').style.display = 'none';
        document.getElementById('invoice-doc').style.display = 'block';
        document.getElementById('invoice-print-btn').style.display = 'block';
      })
      .catch(function (err) {
        document.getElementById('invoice-loading').textContent = friendlyApiError(err);
      });
  }

  // A bare YYYY-MM-DD (from an editable date field) is parsed locally via
  // parseDateInputValue -- `new Date('2026-08-21')` parses as UTC midnight
  // and would then display a day early in a negative-UTC-offset timezone.
  // Anything else (a sheet's raw ISO timestamp, or a Date instance) goes
  // through the regular constructor, unchanged from before.
  function fmtDate(v) {
    if (!v) return '—';
    var d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? parseDateInputValue(v) : new Date(v);
    if (!d || isNaN(d.getTime())) return String(v);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }

  function fmtMoney(n) {
    return '$' + (Number(n) || 0).toFixed(2);
  }

  // Negative amounts (the keg deposit return credit) render as "-$35.00"
  // rather than fmtMoney's bare "$-35.00".
  function fmtMoneySigned(n) {
    n = Number(n) || 0;
    return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // <input type="date"> wants a plain YYYY-MM-DD. Built from local getters
  // (like fmtDate above) so a sheet timestamp of, say, midnight UTC doesn't
  // read back as the previous day in a negative-UTC-offset timezone.
  function toDateInputValue(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // Parses an <input type="date"> value (YYYY-MM-DD) as a LOCAL date rather
  // than `new Date(str)`, which the spec parses as UTC midnight and which
  // would then shift a day when displayed with fmtDate's local getters.
  function parseDateInputValue(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function termsToDaysClient(terms) {
    var m = /(\d+)/.exec(String(terms || ''));
    return m ? parseInt(m[1], 10) : 30;
  }

  // Mirrors Code.gs' KEG_DEPOSIT_PER_UNIT -- confirmed by Jack Begley
  // 2026-08-24. Keep both in sync by hand; Code.gs can't read this file.
  var KEG_DEPOSIT_PER_UNIT = 35.00;

  // Finds the catalog product+format for a SKU code, across all products.
  function findCatalogFormat(code) {
    for (var i = 0; i < window.LM_PRODUCTS.length; i++) {
      var p = window.LM_PRODUCTS[i];
      for (var j = 0; j < p.formats.length; j++) {
        if (p.formats[j].code === code) return { product: p, format: p.formats[j] };
      }
    }
    return null;
  }

  // Builds an editable line from a catalog SKU -- used both when an existing
  // invoice line matches a known product and when the rep adds a new line.
  function catalogEditLine(code, qty) {
    var match = findCatalogFormat(code);
    if (!match) return null;
    return {
      mode: 'catalog',
      formatCode: code,
      productName: match.product.name,
      packagingFormat: match.format.label + ' (' + match.format.detail + ')',
      productCode: code,
      upc: match.format.upc || '',
      qty: qty,
      unitPrice: match.format.price,
      unit: match.format.unit
    };
  }

  function blankCustomLine() {
    return {
      mode: 'custom',
      formatCode: '',
      productName: '',
      packagingFormat: '',
      productCode: '',
      upc: '',
      qty: 1,
      unitPrice: 0,
      unit: ''
    };
  }

  // Working copy of a loaded invoice -- edits here never write back to the
  // Sales sheet (nothing in Code.gs persists post-hoc invoice edits), they
  // only reshape what gets printed/saved as a PDF from this screen.
  function cloneInvoiceForEdit(inv) {
    return {
      invoiceNumber: inv.invoiceNumber,
      poDate: toDateInputValue(inv.poDate),
      deliveryDate: toDateInputValue(inv.invoiceDate),
      paymentTerms: inv.paymentTerms,
      salesRep: inv.salesRep,
      shipTo: inv.shipTo,
      billTo: inv.billTo,
      // Pre-filled from what the rep flagged at order time (Expected Empty
      // Kegs on the order form) -- still editable here since the actual
      // pickup count won't be confirmed until delivery.
      kegReturnQty: Number(inv.expectedEmptyKegs) || 0,
      lines: (inv.lines || []).map(function (l) {
        var match = l.productCode && findCatalogFormat(l.productCode);
        if (match) return catalogEditLine(l.productCode, l.qty);
        return {
          mode: 'custom',
          formatCode: '',
          productName: l.productName || '',
          packagingFormat: l.packagingFormat || '',
          productCode: l.productCode || '',
          upc: l.upc || '',
          qty: l.qty,
          unitPrice: l.unitPrice,
          unit: l.unit || ''
        };
      })
    };
  }

  // Pure: derives every computed total from state.invoiceEdit without
  // mutating it, so it's safe to call on every keystroke/re-render.
  function computeInvoiceEdit(inv) {
    var subtotal = 0, kegDepositQty = 0;
    inv.lines.forEach(function (l) {
      var qty = Number(l.qty) || 0;
      var price = Number(l.unitPrice) || 0;
      subtotal += qty * price;
      if (l.unit === 'keg') kegDepositQty += qty;
    });
    subtotal = Math.round(subtotal * 100) / 100;
    var kegDepositTotal = Math.round(kegDepositQty * KEG_DEPOSIT_PER_UNIT * 100) / 100;
    var kegReturnQty = Number(inv.kegReturnQty) || 0;
    var kegReturnTotal = Math.round(kegReturnQty * -KEG_DEPOSIT_PER_UNIT * 100) / 100;
    var invoiceTotal = Math.round((subtotal + kegDepositTotal + kegReturnTotal) * 100) / 100;
    var deliveryDate = parseDateInputValue(inv.deliveryDate);
    var dueDate = null;
    if (deliveryDate) {
      dueDate = new Date(deliveryDate.getTime());
      dueDate.setDate(dueDate.getDate() + termsToDaysClient(inv.paymentTerms));
    }
    return {
      subtotal: subtotal,
      kegDepositQty: kegDepositQty,
      kegDepositTotal: kegDepositTotal,
      kegReturnQty: kegReturnQty,
      kegReturnTotal: kegReturnTotal,
      invoiceTotal: invoiceTotal,
      dueDate: dueDate
    };
  }

  // Builds the full inner markup for one invoice. Used both for the
  // single-invoice screen and for batch printing (one call per order).
  function buildInvoiceHtml(inv) {
    var rowsHtml = inv.lines.map(function (l) {
      return '<tr>' +
        '<td data-label="Item">' + escapeHtml(l.productName) + ' ' + escapeHtml(l.packagingFormat) + '</td>' +
        '<td data-label="Item Number">' + escapeHtml(l.productCode) + '</td>' +
        '<td data-label="UPC">' + escapeHtml(l.upc || '—') + '</td>' +
        '<td class="num" data-label="Quantity">' + l.qty.toFixed(2) + '</td>' +
        '<td class="num" data-label="Unit Price">' + fmtMoney(l.unitPrice) + '</td>' +
        '<td class="num" data-label="Total">' + fmtMoney(l.total) + '</td>' +
        '</tr>';
    }).join('');
    if (inv.kegDepositQty > 0) {
      rowsHtml += '<tr>' +
        '<td data-label="Item">Keg Deposit</td>' +
        '<td data-label="Item Number">—</td>' +
        '<td data-label="UPC">—</td>' +
        '<td class="num" data-label="Quantity">' + inv.kegDepositQty.toFixed(2) + '</td>' +
        '<td class="num" data-label="Unit Price">' + fmtMoney(inv.kegDepositTotal / inv.kegDepositQty) + '</td>' +
        '<td class="num" data-label="Total">' + fmtMoney(inv.kegDepositTotal) + '</td>' +
        '</tr>';
    }

    var totalsHtml =
      '<div class="row"><span class="label">SUBTOTAL</span><span class="value">' + fmtMoney(inv.subtotal) + '</span></div>' +
      (inv.kegDepositQty > 0 ? '<div class="row"><span class="label">KEG DEPOSIT</span><span class="value">' + fmtMoney(inv.kegDepositTotal) + '</span></div>' : '') +
      '<div class="row"><span class="label">TAX: Exempt (0.0000%)</span><span class="value">$0.00</span></div>' +
      '<div class="row bold"><span class="label">INVOICE TOTAL</span><span class="value">' + fmtMoney(inv.invoiceTotal) + '</span></div>';

    return (
      '<div class="inv-header">' +
        '<img class="inv-logo" src="assets/icons/brand/logo-alt.svg" alt="The Leopard Mark Brewing Co." />' +
        '<div class="inv-doc-label">Invoice</div>' +
      '</div>' +
      '<div class="inv-info-row">' +
        '<div class="inv-company-block">' +
          'The Leopard Mark Brewing Company<br/>(707) 261-0200<br/>ar@theleopardmark.com<br/>' +
          'Sales Rep : ' + escapeHtml(inv.salesRep || '') +
        '</div>' +
        '<div class="inv-meta-block">' +
          'Invoice: ' + escapeHtml(inv.invoiceNumber || '') + '<br/>' +
          'PO Date: ' + fmtDate(inv.poDate) + '<br/>' +
          'Delivery Date: ' + fmtDate(inv.invoiceDate) + '<br/>' +
          'Payment Terms: ' + escapeHtml(inv.paymentTerms || '') + '<br/>' +
          'Due Date: ' + fmtDate(inv.dueDate) +
        '</div>' +
      '</div>' +
      '<div class="inv-parties">' +
        '<div class="inv-party">' +
          '<div class="inv-heading">Ship To:</div>' +
          '<div>' + escapeHtml(inv.shipTo.name || '') + '</div>' +
          '<div>' + escapeHtml(inv.shipTo.address || '') + '</div>' +
          '<div>' + escapeHtml(inv.shipTo.phone || '') + '</div>' +
          '<div>' + (inv.shipTo.license ? 'License Number: ' + escapeHtml(inv.shipTo.license) : '') + '</div>' +
        '</div>' +
        '<div class="inv-party">' +
          '<div class="inv-heading">Bill To:</div>' +
          '<div>' + escapeHtml(inv.billTo.name || '') + '</div>' +
          '<div>' + escapeHtml(inv.billTo.address || '') + '</div>' +
        '</div>' +
      '</div>' +
      '<table class="inv-items">' +
        '<thead><tr><th>Item</th><th>Item Number</th><th>UPC</th><th class="num">Quantity</th><th class="num">Unit Price</th><th class="num">Total</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
      '<div class="inv-totals-wrap"><div class="inv-totals">' + totalsHtml + '</div></div>' +
      '<div class="inv-signatures">' +
        '<div class="inv-sig"><div class="inv-sig-line"></div><div class="inv-sig-label">The Leopard Mark Brewing Company<br/>Representative</div></div>' +
        '<div class="inv-sig"><div class="inv-sig-line"></div><div class="inv-sig-label">' + escapeHtml(inv.shipTo.name || '') + ' Representative</div></div>' +
      '</div>' +
      '<div class="inv-footer-note">For new purchase orders, please email orders@theleopardmark.com</div>' +
      '<div class="inv-terms-note">' +
        '<b>Keg Deposit:</b> A refundable deposit is assessed on each keg delivered and credited upon return of each empty keg.<br/>' +
        '<b>Terms:</b> Net 30 from delivery (Cal. B&amp;P Code &sect; 25509) unless otherwise stated above, paid via seller-initiated EFT per &sect; 25509.1.' +
      '</div>'
    );
  }

  function catalogOptionsHtml(selectedValue) {
    var html = '';
    window.LM_PRODUCTS.forEach(function (p) {
      html += '<optgroup label="' + escapeHtml(p.name) + '">';
      p.formats.forEach(function (f) {
        html += '<option value="' + f.code + '"' + (f.code === selectedValue ? ' selected' : '') + '>' +
          escapeHtml(f.label + ' (' + f.detail + ')') + '</option>';
      });
      html += '</optgroup>';
    });
    html += '<option value="__custom__"' + (selectedValue === '__custom__' ? ' selected' : '') + '>Custom item…</option>';
    return html;
  }

  function editableLineItemLabel(l) {
    if (l.mode === 'custom') return l.productName || 'Custom item';
    return (l.productName + ' ' + l.packagingFormat).trim();
  }

  // Every editable cell renders both a `.print-only` span (the static text
  // that shows up in the printed/PDF invoice) and a `.no-print` control (the
  // input/select the rep actually edits on screen) -- see the `.print-only`
  // / `.no-print` rules in app.css. Kept as two nodes rather than one live
  // element because Chrome prints a <select>'s chrome/arrows and a date
  // input's calendar icon, which looks wrong on a finished invoice.
  function editableLineRowHtml(l, idx) {
    var qty = Number(l.qty) || 0;
    var price = Number(l.unitPrice) || 0;
    var total = Math.round(qty * price * 100) / 100;
    var isCustom = l.mode === 'custom';
    return '<tr data-line-idx="' + idx + '">' +
      '<td data-label="Item">' +
        '<span class="print-only">' + escapeHtml(editableLineItemLabel(l)) + '</span>' +
        '<span class="no-print">' +
          '<select class="inv-input inv-line-select" data-field="formatCode" data-idx="' + idx + '">' +
            catalogOptionsHtml(isCustom ? '__custom__' : l.formatCode) +
          '</select>' +
          (isCustom ? '<input type="text" class="inv-input inv-line-name" data-field="productName" data-idx="' + idx + '" placeholder="Item description" value="' + escapeHtml(l.productName) + '">' : '') +
        '</span>' +
      '</td>' +
      '<td data-label="Item Number">' + escapeHtml(l.productCode || '—') + '</td>' +
      '<td data-label="UPC">' + escapeHtml(l.upc || '—') + '</td>' +
      '<td class="num" data-label="Quantity">' +
        '<span class="print-only">' + qty.toFixed(2) + '</span>' +
        '<input class="inv-input inv-num no-print" type="number" min="0" step="1" data-field="qty" data-idx="' + idx + '" value="' + qty + '">' +
      '</td>' +
      '<td class="num" data-label="Unit Price">' +
        '<span class="print-only">' + fmtMoney(price) + '</span>' +
        '<input class="inv-input inv-num no-print" type="number" min="0" step="0.01" data-field="unitPrice" data-idx="' + idx + '" value="' + price.toFixed(2) + '">' +
      '</td>' +
      '<td class="num" data-label="Total">' + fmtMoney(total) + '</td>' +
      '<td class="no-print inv-line-remove-cell"><button type="button" class="inv-line-remove" data-idx="' + idx + '" aria-label="Remove line item">×</button></td>' +
      '</tr>';
  }

  function kegDepositRowHtml(kegDepositQty, kegDepositTotal) {
    if (kegDepositQty <= 0) return '';
    return '<tr>' +
      '<td data-label="Item">Keg Deposit</td>' +
      '<td data-label="Item Number">—</td>' +
      '<td data-label="UPC">—</td>' +
      '<td class="num" data-label="Quantity">' + kegDepositQty.toFixed(2) + '</td>' +
      '<td class="num" data-label="Unit Price">' + fmtMoney(KEG_DEPOSIT_PER_UNIT) + '</td>' +
      '<td class="num" data-label="Total">' + fmtMoney(kegDepositTotal) + '</td>' +
      '<td class="no-print"></td>' +
      '</tr>';
  }

  // Credit line for kegs picked up empty on this delivery -- kept as its own
  // row (rather than folded into the Keg Deposit row above) so it's always
  // visible while editing, even at qty 0, and only drops out of the printed
  // invoice (via the row-level no-print class) once it has nothing to show.
  function kegReturnRowHtml(kegReturnQty, kegReturnTotal) {
    var qty = Number(kegReturnQty) || 0;
    return '<tr class="' + (qty > 0 ? '' : 'no-print') + '">' +
      '<td data-label="Item">Keg Deposit Returned<div class="inv-hint no-print">Empty kegs picked up on this delivery</div></td>' +
      '<td data-label="Item Number">—</td>' +
      '<td data-label="UPC">—</td>' +
      '<td class="num" data-label="Quantity">' +
        '<span class="print-only">' + qty.toFixed(2) + '</span>' +
        '<input class="inv-input inv-num no-print" type="number" min="0" step="1" data-field="kegReturnQty" value="' + qty + '">' +
      '</td>' +
      '<td class="num" data-label="Unit Price">' + fmtMoneySigned(-KEG_DEPOSIT_PER_UNIT) + '</td>' +
      '<td class="num" data-label="Total">' + fmtMoneySigned(kegReturnTotal) + '</td>' +
      '<td class="no-print"></td>' +
      '</tr>';
  }

  // Editable counterpart to buildInvoiceHtml above, for the single-invoice
  // screen only (batch printing keeps using the static, server-values-only
  // version). Renders from state.invoiceEdit + its live-computed totals;
  // every add/remove/edit calls renderEditableInvoice() again to rebuild it.
  function buildEditableInvoiceHtml() {
    var inv = state.invoiceEdit;
    var computed = computeInvoiceEdit(inv);

    var rowsHtml = inv.lines.map(function (l, idx) { return editableLineRowHtml(l, idx); }).join('') +
      kegDepositRowHtml(computed.kegDepositQty, computed.kegDepositTotal) +
      kegReturnRowHtml(computed.kegReturnQty, computed.kegReturnTotal);

    var totalsHtml =
      '<div class="row"><span class="label">SUBTOTAL</span><span class="value">' + fmtMoney(computed.subtotal) + '</span></div>' +
      (computed.kegDepositQty > 0 ? '<div class="row"><span class="label">KEG DEPOSIT</span><span class="value">' + fmtMoney(computed.kegDepositTotal) + '</span></div>' : '') +
      (computed.kegReturnQty > 0 ? '<div class="row"><span class="label">KEG DEPOSIT RETURNED</span><span class="value">' + fmtMoneySigned(computed.kegReturnTotal) + '</span></div>' : '') +
      '<div class="row"><span class="label">TAX: Exempt (0.0000%)</span><span class="value">$0.00</span></div>' +
      '<div class="row bold"><span class="label">INVOICE TOTAL</span><span class="value">' + fmtMoney(computed.invoiceTotal) + '</span></div>';

    return (
      '<div class="inv-header">' +
        '<img class="inv-logo" src="assets/icons/brand/logo-alt.svg" alt="The Leopard Mark Brewing Co." />' +
        '<div class="inv-doc-label">Invoice</div>' +
      '</div>' +
      '<div class="inv-info-row">' +
        '<div class="inv-company-block">' +
          'The Leopard Mark Brewing Company<br/>(707) 261-0200<br/>ar@theleopardmark.com<br/>' +
          'Sales Rep : ' + escapeHtml(inv.salesRep || '') +
        '</div>' +
        '<div class="inv-meta-block">' +
          'Invoice: ' + escapeHtml(inv.invoiceNumber || '') + '<br/>' +
          'PO Date: ' +
            '<span class="print-only">' + fmtDate(inv.poDate) + '</span>' +
            '<input type="date" class="inv-input inv-date-input no-print" data-field="poDate" value="' + inv.poDate + '">' +
            '<br/>' +
          'Delivery Date: ' +
            '<span class="print-only">' + fmtDate(inv.deliveryDate) + '</span>' +
            '<input type="date" class="inv-input inv-date-input no-print" data-field="deliveryDate" value="' + inv.deliveryDate + '">' +
            '<br/>' +
          'Payment Terms: ' + escapeHtml(inv.paymentTerms || '') + '<br/>' +
          'Due Date: ' + fmtDate(computed.dueDate) +
        '</div>' +
      '</div>' +
      '<div class="inv-parties">' +
        '<div class="inv-party">' +
          '<div class="inv-heading">Ship To:</div>' +
          '<div>' + escapeHtml(inv.shipTo.name || '') + '</div>' +
          '<div>' + escapeHtml(inv.shipTo.address || '') + '</div>' +
          '<div>' + escapeHtml(inv.shipTo.phone || '') + '</div>' +
          '<div>' + (inv.shipTo.license ? 'License Number: ' + escapeHtml(inv.shipTo.license) : '') + '</div>' +
        '</div>' +
        '<div class="inv-party">' +
          '<div class="inv-heading">Bill To:</div>' +
          '<div>' + escapeHtml(inv.billTo.name || '') + '</div>' +
          '<div>' + escapeHtml(inv.billTo.address || '') + '</div>' +
        '</div>' +
      '</div>' +
      '<table class="inv-items">' +
        '<thead><tr><th>Item</th><th>Item Number</th><th>UPC</th><th class="num">Quantity</th><th class="num">Unit Price</th><th class="num">Total</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
      '<div class="no-print"><button type="button" class="inv-add-line-btn" id="inv-add-line-btn">+ Add Line Item</button></div>' +
      '<div class="inv-totals-wrap"><div class="inv-totals">' + totalsHtml + '</div></div>' +
      '<div class="inv-signatures">' +
        '<div class="inv-sig"><div class="inv-sig-line"></div><div class="inv-sig-label">The Leopard Mark Brewing Company<br/>Representative</div></div>' +
        '<div class="inv-sig"><div class="inv-sig-line"></div><div class="inv-sig-label">' + escapeHtml(inv.shipTo.name || '') + ' Representative</div></div>' +
      '</div>' +
      '<div class="inv-footer-note">For new purchase orders, please email orders@theleopardmark.com</div>' +
      '<div class="inv-terms-note">' +
        '<b>Keg Deposit:</b> A refundable deposit is assessed on each keg delivered and credited upon return of each empty keg.<br/>' +
        '<b>Terms:</b> Net 30 from delivery (Cal. B&amp;P Code &sect; 25509) unless otherwise stated above, paid via seller-initiated EFT per &sect; 25509.1.' +
      '</div>'
    );
  }

  function renderEditableInvoice() {
    document.getElementById('invoice-doc').innerHTML = buildEditableInvoiceHtml();
  }

  // Delegated on the container (rather than bound per-control) because every
  // add/remove/edit fully rebuilds #invoice-doc's innerHTML -- per-node
  // listeners would be destroyed on each rebuild.
  document.getElementById('invoice-doc').addEventListener('click', function (e) {
    if (e.target.closest('#inv-add-line-btn')) {
      state.invoiceEdit.lines.push(catalogEditLine(window.LM_PRODUCTS[0].formats[0].code, 1));
      renderEditableInvoice();
      return;
    }
    var removeBtn = e.target.closest('.inv-line-remove');
    if (removeBtn) {
      state.invoiceEdit.lines.splice(Number(removeBtn.getAttribute('data-idx')), 1);
      renderEditableInvoice();
    }
  });

  // 'change' (fires on blur/Enter, not every keystroke) so totals settle
  // once the rep leaves a field instead of re-rendering -- and stealing
  // focus -- on every character typed.
  document.getElementById('invoice-doc').addEventListener('change', function (e) {
    var field = e.target.getAttribute('data-field');
    if (!field) return;
    var inv = state.invoiceEdit;

    if (field === 'kegReturnQty') {
      inv.kegReturnQty = Math.max(0, Number(e.target.value) || 0);
    } else if (field === 'poDate' || field === 'deliveryDate') {
      inv[field] = e.target.value;
    } else {
      var idx = Number(e.target.getAttribute('data-idx'));
      var line = inv.lines[idx];
      if (!line) return;
      if (field === 'formatCode') {
        inv.lines[idx] = e.target.value === '__custom__' ? blankCustomLine() : catalogEditLine(e.target.value, line.qty || 1);
      } else if (field === 'productName') {
        line.productName = e.target.value;
      } else if (field === 'qty') {
        line.qty = Math.max(0, Number(e.target.value) || 0);
      } else if (field === 'unitPrice') {
        line.unitPrice = Math.max(0, Number(e.target.value) || 0);
      }
    }
    renderEditableInvoice();
  });

  document.getElementById('invoice-print-btn').addEventListener('click', function () {
    window.print();
  });

  // ---------- Accounts map ----------
  // Sales sheet rep names ("Thomas Gilbert") and Customer Accounts rep names
  // ("T. Gilbert") aren't written consistently, so match by last name rather
  // than requiring an exact string match.
  function repLastName(name) {
    var parts = String(name || '').trim().split(/[\s.]+/).filter(Boolean);
    return (parts[parts.length - 1] || '').toLowerCase();
  }

  // Region is suggested from the establishment's CITY (an exact place, not a
  // rep's general territory) -- but per Jack Begley 2026-09-01, after a La
  // Mirada account got silently misfiled under a rep's default (San
  // Francisco) because "la mirada" matched nothing, this is now only ever a
  // pre-fill: the rep confirms or corrects it in the Region dropdown on the
  // new-customer form (see nc-region), never submitted un-reviewed.
  //
  // Matching is against the city field ALONE, and by exact name (not
  // substring-in-the-whole-address) -- that's what makes it safe to list
  // "la mirada", "la mesa", and "la habra" in three different regions
  // without any of them colliding: a bare "la" substring search would have
  // misfired on all of them, which is why the old version avoided it
  // entirely and just left Los Angeles as a single bare city name.
  var REGION_KEYWORDS = [
    { region: 'San Rafael', cities: [
      'san rafael', 'san anselmo', 'fairfax', 'ross', 'kentfield', 'larkspur',
      'corte madera', 'mill valley', 'sausalito', 'tiburon', 'greenbrae'
    ] },
    { region: 'Burlingame', cities: [
      'burlingame', 'san mateo', 'millbrae', 'hillsborough', 'foster city',
      'belmont', 'san bruno'
    ] },
    { region: 'North Bay', cities: [
      'north bay', 'santa rosa', 'napa', 'sonoma', 'petaluma', 'novato',
      'marin', 'rohnert park', 'windsor', 'healdsburg', 'cotati',
      'sebastopol', 'vallejo', 'fairfield', 'american canyon',
      'st. helena', 'saint helena', 'calistoga', 'yountville'
    ] },
    { region: 'San Francisco', cities: [
      'san francisco', 'sf', 'oakland', 'berkeley', 'daly city', 'emeryville',
      'alameda', 'san leandro', 'richmond', 'el cerrito', 'albany',
      'south san francisco', 'brisbane', 'colma', 'pacifica'
    ] },
    { region: 'Arcadia', cities: [
      'arcadia', 'monrovia', 'sierra madre', 'temple city', 'san marino'
    ] },
    { region: 'Long Beach', cities: [
      'long beach', 'signal hill', 'lakewood'
    ] },
    { region: 'Orange County', cities: [
      'orange county', 'anaheim', 'anaheim hills', 'irvine', 'santa ana',
      'huntington beach', 'costa mesa', 'fullerton', 'orange',
      'garden grove', 'westminster', 'fountain valley', 'newport beach',
      'laguna beach', 'laguna niguel', 'laguna hills', 'mission viejo',
      'lake forest', 'tustin', 'buena park', 'la habra', 'yorba linda',
      'placentia', 'brea', 'cypress', 'los alamitos', 'seal beach',
      'san clemente', 'dana point', 'aliso viejo',
      'rancho santa margarita', 'stanton', 'la palma'
    ] },
    { region: 'San Diego', cities: [
      'san diego', 'chula vista', 'oceanside', 'escondido', 'carlsbad',
      'el cajon', 'vista', 'san marcos', 'encinitas', 'national city',
      'la mesa', 'santee', 'poway', 'coronado', 'imperial beach',
      'lemon grove', 'solana beach', 'del mar'
    ] },
    { region: 'Los Angeles', cities: [
      'los angeles', 'la mirada', 'la puente', 'la verne',
      'la canada flintridge', 'la cañada flintridge', 'la crescenta',
      'whittier', 'pico rivera', 'downey', 'norwalk', 'santa fe springs',
      'bellflower', 'paramount', 'south gate', 'lynwood', 'compton',
      'hawthorne', 'gardena', 'torrance', 'carson', 'inglewood',
      'el segundo', 'culver city', 'santa monica', 'west hollywood',
      'beverly hills', 'pasadena', 'glendale', 'burbank',
      'north hollywood', 'van nuys', 'sherman oaks', 'studio city',
      'encino', 'woodland hills', 'northridge', 'reseda', 'canoga park',
      'chatsworth', 'san fernando', 'sylmar', 'sun valley',
      'panorama city', 'granada hills', 'porter ranch', 'west covina',
      'covina', 'baldwin park', 'el monte', 'south el monte', 'rosemead',
      'san gabriel', 'alhambra', 'monterey park', 'montebello', 'pomona',
      'claremont', 'san dimas', 'glendora', 'azusa', 'duarte', 'bell',
      'bell gardens', 'cudahy', 'huntington park', 'vernon', 'maywood',
      'south pasadena', 'walnut', 'diamond bar',
      'rowland heights', 'hacienda heights', 'cerritos', 'artesia',
      'lawndale', 'lomita', 'palos verdes estates', 'rancho palos verdes',
      'rolling hills', 'malibu', 'calabasas', 'agoura hills',
      'westlake village', 'hidden hills'
    ] }
  ];

  // Reps whose territory we know from historical order data -- keyed by last
  // name so "T. Gilbert" and "Thomas Gilbert" both resolve. Reps not listed
  // here have no reliable default yet; for them, region only fills in when
  // the city itself gives a match. Only used as a LAST resort now (see
  // inferRegion) -- it's what put a real La Mirada account under San
  // Francisco before the city list covered it.
  var REP_DEFAULT_REGION = {
    'gilbert': 'San Francisco',
    'williams': 'Los Angeles',
    'krause': 'Orange County',
    'sprague': 'Orange County'
  };

  function inferRegion(rep, city) {
    var normalized = String(city || '').trim().toLowerCase();
    for (var i = 0; i < REGION_KEYWORDS.length; i++) {
      if (REGION_KEYWORDS[i].cities.indexOf(normalized) !== -1) return REGION_KEYWORDS[i].region;
    }
    return REP_DEFAULT_REGION[repLastName(rep)] || '';
  }

  function myMappedAccounts() {
    var mine = repLastName(state.rep);
    if (!mine) return [];
    return state.customers.filter(function (c) {
      return c.lat && c.lng && repLastName(c.salesRep) === mine;
    });
  }

  function updateMyMapButton() {
    var btn = document.getElementById('btn-my-map');
    btn.style.display = myMappedAccounts().length ? 'flex' : 'none';
  }

  document.getElementById('btn-my-map').addEventListener('click', openAccountsMap);
  document.getElementById('back-map-to-home').addEventListener('click', function () { showScreen('screen-home'); });

  var accountsMapInstance = null;

  function openAccountsMap() {
    showScreen('screen-map');
    var accounts = myMappedAccounts();

    document.getElementById('map-account-list').innerHTML = accounts.map(function (c, i) {
      return '<div class="order-row clickable" data-map-idx="' + i + '">' +
        '<div><div class="oname">' + escapeHtml(c.establishmentName) + '</div>' +
        '<div class="osub">' + escapeHtml(c.address || '') + '</div></div>' +
        '<span>→</span>' +
        '</div>';
    }).join('') || '<div class="empty-note">No mapped accounts yet.</div>';

    setTimeout(function () {
      if (!accountsMapInstance) {
        accountsMapInstance = L.map('accounts-map');
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 19,
          subdomains: 'abcd',
          attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors'
        }).addTo(accountsMapInstance);
      } else {
        accountsMapInstance.eachLayer(function (layer) {
          if (layer instanceof L.Marker) accountsMapInstance.removeLayer(layer);
        });
      }

      var pinIcon = function (color) {
        return L.divIcon({
          className: '',
          html: '<div class="lm-pin" style="background:' + color + ';"></div>',
          iconSize: [26, 26],
          iconAnchor: [13, 26],
          popupAnchor: [0, -26]
        });
      };
      var orangeIcon = pinIcon('#ff7a30');
      var pinkIcon = pinIcon('#ff2d78');

      var markers = [];
      accounts.forEach(function (c, i) {
        var marker = L.marker([c.lat, c.lng], { icon: i % 2 === 0 ? orangeIcon : pinkIcon }).addTo(accountsMapInstance);
        marker.bindPopup(
          '<strong>' + escapeHtml(c.establishmentName) + '</strong><br/>' + escapeHtml(c.address || '') +
          '<br/><a href="#" class="popup-view-orders" data-map-idx="' + i + '">View Orders →</a>'
        );
        markers.push(marker);
      });

      if (markers.length) {
        accountsMapInstance.fitBounds(L.featureGroup(markers).getBounds(), { padding: [24, 24] });
      } else {
        accountsMapInstance.setView([37.77, -122.42], 11);
      }

      accountsMapInstance.off('popupopen').on('popupopen', function (e) {
        var link = e.popup._contentNode.querySelector('.popup-view-orders');
        if (!link) return;
        link.addEventListener('click', function (evt) {
          evt.preventDefault();
          openAccountDetail(accounts[parseInt(link.getAttribute('data-map-idx'), 10)]);
        });
      });

      document.getElementById('map-account-list').querySelectorAll('[data-map-idx]').forEach(function (row) {
        row.addEventListener('click', function () {
          var idx = parseInt(row.getAttribute('data-map-idx'), 10);
          openAccountDetail(accounts[idx]);
        });
      });

      accountsMapInstance.invalidateSize();
    }, 50);
  }

  // ---------- Admin: all orders ----------
  var adminOrdersCache = [];

  document.getElementById('btn-admin-orders').addEventListener('click', openAdminOrders);
  document.getElementById('back-admin-to-home').addEventListener('click', function () { showScreen('screen-home'); });

  function openAdminOrders() {
    showScreen('screen-admin-orders');
    document.getElementById('admin-order-search').value = '';
    document.getElementById('admin-order-list').innerHTML = '<div class="empty-note">Loading…</div>';

    apiGet({ action: 'allOrders' })
      .then(function (res) {
        if (!res.ok) {
          document.getElementById('admin-order-list').innerHTML = '<div class="empty-note">' + escapeHtml(res.error || 'Could not load orders.') + '</div>';
          return;
        }
        adminOrdersCache = res.orders || [];
        document.getElementById('admin-stat-orders').textContent = res.totalOrders || 0;
        document.getElementById('admin-stat-value').textContent = '$' + (res.totalLineValue || 0).toFixed(0);
        renderAdminOrders('');
      })
      .catch(function (err) {
        document.getElementById('admin-order-list').innerHTML = '<div class="empty-note">' + escapeHtml(friendlyApiError(err)) + '</div>';
      });
  }

  function renderAdminOrders(query) {
    var host = document.getElementById('admin-order-list');
    var q = (query || '').trim().toLowerCase();
    var list = !q ? adminOrdersCache : adminOrdersCache.filter(function (o) {
      return (String(o.customer || '') + ' ' + String(o.rep || '')).toLowerCase().indexOf(q) !== -1;
    });

    if (!list.length) {
      host.innerHTML = '<div class="empty-note">No orders found.</div>';
      return;
    }

    host.innerHTML = list.map(function (o) {
      var statusClass = String(o.status || 'pending').toLowerCase().replace(/\s+/g, '-');
      var lines = o.lines || [];
      var sub = (lines.length === 1
        ? escapeHtml(lines[0].product || '') + ' · ' + escapeHtml(lines[0].packaging || '') + ' · Qty ' + lines[0].qty
        : lines.length + ' item' + (lines.length === 1 ? '' : 's') + ' · Qty ' + o.qty) + ' · ' + escapeHtml(o.rep || '');
      var clickable = !!o.invoiceNumber;
      return '<div class="order-row' + (clickable ? ' clickable' : '') + '"' + (clickable ? ' data-invoice="' + escapeHtml(o.invoiceNumber) + '"' : '') + '>' +
        '<div><div class="oname">' + escapeHtml(o.customer || 'Unknown account') + '</div>' +
        '<div class="osub">' + sub + '</div></div>' +
        '<span class="pill ' + statusClass + '">' + escapeHtml(o.status || 'Pending') + '</span>' +
        '</div>';
    }).join('');
  }

  document.getElementById('admin-order-search').addEventListener('input', function (e) {
    renderAdminOrders(e.target.value);
  });

  document.getElementById('admin-order-list').addEventListener('click', function (e) {
    var row = e.target.closest('.order-row[data-invoice]');
    if (!row) return;
    openInvoice(row.getAttribute('data-invoice'));
  });

  // ---------- Account detail ----------
  document.getElementById('back-account-to-map').addEventListener('click', function () { showScreen('screen-map'); });

  function openAccountDetail(customer) {
    showScreen('screen-account');
    state.currentAccount = customer;
    state.currentAccountOrders = [];
    document.getElementById('account-edit-form').style.display = 'none';
    document.getElementById('account-name').textContent = customer.establishmentName || '';
    document.getElementById('account-address').textContent = customer.address || '';
    document.getElementById('account-total-orders').textContent = '0';
    document.getElementById('account-total-value').textContent = '$0';
    document.getElementById('account-order-list').innerHTML = '<div class="empty-note">Loading…</div>';

    apiGet({ action: 'customerOrders', customer: customer.establishmentName })
      .then(function (res) {
        if (!res.ok) {
          document.getElementById('account-order-list').innerHTML = '<div class="empty-note">' + escapeHtml(res.error || 'Could not load orders.') + '</div>';
          return;
        }
        state.currentAccountOrders = res.orders;
        document.getElementById('account-total-orders').textContent = res.totalOrders;
        document.getElementById('account-total-value').textContent = '$' + (res.totalLineValue || 0).toFixed(0);

        var host = document.getElementById('account-order-list');
        if (!res.orders.length) {
          host.innerHTML = '<div class="empty-note">No orders yet for this account.</div>';
          return;
        }
        host.innerHTML = res.orders.map(function (o) {
          var statusClass = String(o.status || 'pending').toLowerCase().replace(/\s+/g, '-');
          var lines = o.lines || [];
          var sub = lines.length === 1
            ? escapeHtml(lines[0].product || '') + ' · ' + escapeHtml(lines[0].packaging || '') + ' · Qty ' + lines[0].qty
            : lines.length + ' items · Qty ' + o.qty;
          var clickable = !!o.invoiceNumber;
          return '<div class="order-row' + (clickable ? ' clickable' : '') + '"' + (clickable ? ' data-invoice="' + escapeHtml(o.invoiceNumber) + '"' : '') + '>' +
            '<div><div class="oname">' + fmtDate(o.poDate) + '</div>' +
            '<div class="osub">' + sub + '</div></div>' +
            '<span class="pill ' + statusClass + '">' + escapeHtml(o.status || 'Pending') + '</span>' +
            '</div>';
        }).join('');
      })
      .catch(function (err) {
        document.getElementById('account-order-list').innerHTML = '<div class="empty-note">' + escapeHtml(friendlyApiError(err)) + '</div>';
      });
  }

  document.getElementById('account-order-list').addEventListener('click', function (e) {
    var row = e.target.closest('.order-row[data-invoice]');
    if (!row) return;
    openInvoice(row.getAttribute('data-invoice'));
  });

  // ---------- Account edit ----------
  document.getElementById('btn-edit-account').addEventListener('click', function () {
    var c = state.currentAccount;
    if (!c) return;
    document.getElementById('ea-contact').value = c.orderingContact || '';
    document.getElementById('ea-phone').value = c.phone || '';
    document.getElementById('ea-email').value = c.email || '';
    document.getElementById('ea-address').value = c.address || '';
    document.getElementById('ea-billing-address').value = c.deliveryAddress || '';
    document.getElementById('ea-delivery-instructions').value = c.deliveryInstructions || '';
    document.getElementById('ea-region').value = c.region || '';
    document.getElementById('ea-license').value = c.licenseNumber || '';
    document.getElementById('ea-payment-method').value = c.paymentMethod || '';
    document.getElementById('ea-terms').value = c.terms || '';
    setYnToggle('ea-tap-handle', c.tapHandleRequested === 'Yes' ? 'Yes' : 'No');
    document.getElementById('account-edit-error').textContent = '';
    document.getElementById('account-edit-form').style.display = 'flex';
  });

  document.getElementById('btn-cancel-edit-account').addEventListener('click', function () {
    document.getElementById('account-edit-form').style.display = 'none';
  });

  document.getElementById('account-edit-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var c = state.currentAccount;
    if (!c) return;
    var errEl = document.getElementById('account-edit-error');
    var btn = document.getElementById('btn-save-account');
    var updates = {
      establishmentName: c.establishmentName,
      orderingContact: document.getElementById('ea-contact').value.trim(),
      phone: document.getElementById('ea-phone').value.trim(),
      email: document.getElementById('ea-email').value.trim(),
      address: document.getElementById('ea-address').value.trim(),
      deliveryAddress: document.getElementById('ea-billing-address').value.trim(),
      deliveryInstructions: document.getElementById('ea-delivery-instructions').value.trim(),
      region: document.getElementById('ea-region').value.trim(),
      licenseNumber: document.getElementById('ea-license').value.trim(),
      paymentMethod: document.getElementById('ea-payment-method').value.trim(),
      terms: document.getElementById('ea-terms').value.trim(),
      tapHandleRequested: getYnToggle('ea-tap-handle')
    };

    btn.disabled = true;
    btn.textContent = 'Saving...';

    apiPost({ action: 'updateCustomer', customer: updates })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Save Changes';
        if (!res.ok) { errEl.textContent = res.error || 'Could not save changes.'; return; }
        Object.assign(c, updates);
        var idx = state.customers.findIndex(function (x) { return x.establishmentName === c.establishmentName; });
        if (idx !== -1) Object.assign(state.customers[idx], updates);
        cacheCustomers(state.customers);
        document.getElementById('account-address').textContent = c.address || '';
        document.getElementById('account-edit-form').style.display = 'none';
        toast('Account updated');
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Save Changes';
        errEl.textContent = friendlyApiError(err);
      });
  });

  // ---------- Batch invoice generation ----------
  document.getElementById('btn-generate-all-invoices').addEventListener('click', function () {
    var orders = (state.currentAccountOrders || []).filter(function (o) { return !!o.invoiceNumber; });
    if (!orders.length) { toast('No invoices to generate for this account', true); return; }

    var btn = document.getElementById('btn-generate-all-invoices');
    btn.disabled = true;

    Promise.all(orders.map(function (o) {
      return apiGet({ action: 'invoiceDetail', invoiceNumber: o.invoiceNumber }).catch(function () { return null; });
    }))
      .then(function (results) {
        btn.disabled = false;
        var valid = results.filter(function (r) { return r && r.ok; });
        if (!valid.length) { toast('Could not load any invoices', true); return; }

        var sheet = document.getElementById('batch-print-sheet');
        sheet.innerHTML = valid.map(function (inv) {
          return '<div class="invoice-doc">' + buildInvoiceHtml(inv) + '</div>';
        }).join('');

        sheet.classList.add('printing');
        window.print();
      })
      .catch(function () {
        btn.disabled = false;
        toast('Could not generate invoices', true);
      });
  });

  window.addEventListener('afterprint', function () {
    var sheet = document.getElementById('batch-print-sheet');
    sheet.classList.remove('printing');
    sheet.innerHTML = '';
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- Order screen ----------
  document.getElementById('btn-new-order').addEventListener('click', function () {
    resetOrderForm();
    showScreen('screen-order');
  });

  document.getElementById('back-to-home').addEventListener('click', function () { showScreen('screen-home'); });
  document.getElementById('footer-cancel').addEventListener('click', function () { showScreen('screen-home'); });

  function resetOrderForm() {
    state.selection = {};
    state.customer = null;
    document.getElementById('order-notes').value = '';
    document.getElementById('order-expected-empties').value = '';
    setYnToggle('order-tap-handle', 'No');
    renderProductList();
    renderPickedCustomer();
    updateOrderTotal();
  }

  // ---------- Customer picker ----------
  function setCustomer(c) {
    state.customer = c;
    renderPickedCustomer();
    // Defaults from the account's own "Does this location use tap
    // handles?" setting -- the rep can still flip it for this specific
    // delivery (e.g. this order isn't adding a new tap, or it's a repeat
    // order for a location that just got its first one).
    setYnToggle('order-tap-handle', c && c.tapHandleRequested === 'Yes' ? 'Yes' : 'No');
  }

  function renderPickedCustomer() {
    var label = document.getElementById('picked-customer-label');
    var detail = document.getElementById('picked-customer-detail');
    if (!state.customer) {
      label.textContent = 'Select account →';
      detail.style.display = 'none';
      return;
    }
    label.textContent = state.customer.establishmentName + ' — change';
    detail.style.display = 'block';
    detail.innerHTML =
      '<div class="oline"><span>Address</span><span>' + escapeHtml(state.customer.address || '—') + '</span></div>' +
      '<div class="oline"><span>License #</span><span>' + escapeHtml(state.customer.licenseNumber || 'On file — will auto-fill') + '</span></div>' +
      (state.customer.region ? '<div class="oline"><span>Region</span><span>' + escapeHtml(state.customer.region) + '</span></div>' : '');
  }

  // screen-customers is shared by the beer order screen and the marketing
  // materials request, so it has to remember which one sent the rep here.
  // Without that, picking an account from the marketing form would drop them
  // onto the beer order screen with a customer set that they never chose
  // there -- and their marketing request half-filled behind it.
  function openCustomerPicker(returnScreen) {
    state.customerPickerReturn = returnScreen;
    renderCustomerList('');
    document.getElementById('customer-search').value = '';
    showScreen('screen-customers');
  }

  document.getElementById('btn-pick-customer').addEventListener('click', function () {
    openCustomerPicker('screen-order');
  });
  document.getElementById('back-customers-to-order').addEventListener('click', function () {
    showScreen(state.customerPickerReturn || 'screen-order');
  });

  document.getElementById('customer-search').addEventListener('input', function (e) {
    renderCustomerList(e.target.value);
  });

  function renderCustomerList(query) {
    var host = document.getElementById('customer-list');
    var q = (query || '').trim().toLowerCase();

    if (!q) {
      host.innerHTML = '<div class="empty-note">Start typing to search accounts.</div>';
      return;
    }

    var list = state.customers.filter(function (c) {
      // Search across everything a rep might type to disambiguate near-duplicate
      // accounts (e.g. two "La Nena Cantina" locations) -- name, legal entity,
      // license #, region, and address all count as a match.
      return (
        c.establishmentName + ' ' + (c.legalEntity || '') + ' ' + (c.licenseNumber || '') +
        ' ' + (c.region || '') + ' ' + (c.address || '')
      ).toLowerCase().indexOf(q) !== -1;
    }).slice(0, 60);

    if (!list.length) {
      host.innerHTML = '<div class="empty-note">No matching accounts. Try a different search, or add a new customer.</div>';
      return;
    }

    host.innerHTML = list.map(function (c, i) {
      var subParts = [];
      if (c.address) subParts.push(c.address);
      if (c.licenseNumber) subParts.push('Lic# ' + c.licenseNumber);
      if (c.legalEntity && c.legalEntity !== c.establishmentName) subParts.push(c.legalEntity);
      return '<div class="order-row" style="cursor:pointer;" data-idx="' + state.customers.indexOf(c) + '">' +
        '<div><div class="oname">' + escapeHtml(c.establishmentName) + '</div>' +
        '<div class="osub">' + escapeHtml(subParts.join(' · ') || c.region || '') + '</div></div>' +
        '<span>→</span></div>';
    }).join('');
  }

  document.getElementById('customer-list').addEventListener('click', function (e) {
    var row = e.target.closest('.order-row');
    if (!row) return;
    var idx = parseInt(row.getAttribute('data-idx'), 10);
    var returnScreen = state.customerPickerReturn || 'screen-order';
    if (returnScreen === 'screen-marketing') setMarketingAccount(state.customers[idx]);
    else setCustomer(state.customers[idx]);
    showScreen(returnScreen);
  });

  document.getElementById('btn-add-customer').addEventListener('click', function () {
    openNewCustomerForm('screen-customers');
  });

  // The home screen's "Add Account" button skips straight to this form --
  // no order in progress, so there's no customer to pick it into.
  document.getElementById('btn-add-account').addEventListener('click', function () {
    openNewCustomerForm('screen-home');
  });

  function openNewCustomerForm(returnTo) {
    document.getElementById('new-customer-form').reset();
    document.getElementById('new-customer-error').textContent = '';
    setYnToggle('nc-tap-handle', 'No');
    setYnToggle('nc-billing-same', 'Yes');
    updateBillingFieldsVisibility();
    document.getElementById('new-customer-form').style.display = 'flex';
    document.getElementById('nc-success').style.display = 'none';
    document.getElementById('back-newcustomer-to-customers').style.display = 'block';
    state.newCustomerReturnTo = returnTo;
    showScreen('screen-new-customer');
  }

  document.getElementById('back-newcustomer-to-customers').addEventListener('click', function () {
    showScreen(state.newCustomerReturnTo || 'screen-customers');
  });

  // Suggests a region as soon as the rep leaves the City field, but only
  // while the dropdown is still on its placeholder -- once the rep has
  // picked (or corrected) a region themselves, typing in City again won't
  // silently overwrite that choice.
  document.getElementById('nc-address-city').addEventListener('blur', function (e) {
    var regionSelect = document.getElementById('nc-region');
    if (regionSelect.value) return;
    var suggested = inferRegion(state.rep, e.target.value);
    if (suggested) regionSelect.value = suggested;
  });

  document.getElementById('nc-place-order-btn').addEventListener('click', function () {
    if (!state.lastAddedCustomer) return;
    resetOrderForm();
    setCustomer(state.lastAddedCustomer);
    showScreen('screen-order');
  });

  document.getElementById('nc-success-done-btn').addEventListener('click', function () {
    showScreen('screen-home');
  });

  // ---------- Yes/No toggle fields (e.g. Tap Handle Requested) ----------
  function setYnToggle(id, value) {
    var wrap = document.getElementById(id);
    wrap.setAttribute('data-value', value);
    wrap.querySelectorAll('.yn-btn').forEach(function (b) {
      b.classList.toggle('selected', b.getAttribute('data-value') === value);
    });
  }

  function getYnToggle(id) {
    return document.getElementById(id).getAttribute('data-value') || '';
  }

  document.querySelectorAll('.yn-toggle').forEach(function (wrap) {
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('.yn-btn');
      if (!btn) return;
      setYnToggle(wrap.id, btn.getAttribute('data-value'));
      if (wrap.id === 'nc-billing-same') updateBillingFieldsVisibility();
    });
  });

  // Billing Address fields only need to exist (and be required) when the
  // billing address differs from the business address -- otherwise they'd
  // block submission of a form the rep has no reason to fill in twice.
  function updateBillingFieldsVisibility() {
    var differs = getYnToggle('nc-billing-same') === 'No';
    document.getElementById('nc-billing-fields').style.display = differs ? 'flex' : 'none';
    ['nc-billing-street', 'nc-billing-city', 'nc-billing-state', 'nc-billing-zip'].forEach(function (id) {
      document.getElementById(id).required = differs;
    });
  }

  // Joins street/line2/city/state/zip into the single formatted line the
  // Sheet's address columns have always stored (neither "Delivery Address"
  // nor "Billing Address" is split into parts on that side) -- e.g.
  // "123 Main St, Suite 2, San Francisco, CA 94103". Blank parts (address
  // line 2 is optional) are dropped rather than leaving stray ", ,".
  function formatAddress(street, line2, city, stateCode, zip) {
    var cityStateZip = [city, [stateCode, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return [street, line2, cityStateZip].filter(Boolean).join(', ');
  }

  document.getElementById('new-customer-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var errEl = document.getElementById('new-customer-error');
    var val = function (id) { return document.getElementById(id).value.trim(); };
    var billingDiffers = getYnToggle('nc-billing-same') === 'No';
    var businessAddress = formatAddress(val('nc-address-street'), val('nc-address-2'), val('nc-address-city'), val('nc-address-state'), val('nc-address-zip'));
    var newCustomer = {
      establishmentName: val('nc-name'),
      address: businessAddress,
      orderingContact: [val('nc-contact-first'), val('nc-contact-last')].filter(Boolean).join(' '),
      phone: val('nc-phone'),
      email: val('nc-email'),
      // Confusingly named on the Sheet side (see handleAddCustomer in
      // Code.gs): this actually lands in "Billing Address (If not the same
      // as shipping)", left blank when it matches the business address.
      deliveryAddress: billingDiffers ? formatAddress(val('nc-billing-street'), val('nc-billing-2'), val('nc-billing-city'), val('nc-billing-state'), val('nc-billing-zip')) : '',
      deliveryInstructions: val('nc-delivery-instructions'),
      // Rep-confirmed, not re-inferred here -- see the nc-address-city blur
      // handler below for the pre-fill. Submitting whatever the dropdown
      // actually shows (rather than recomputing) is what makes this a real
      // fix and not just a hidden default with extra steps.
      region: val('nc-region'),
      licenseNumber: val('nc-license'),
      tapHandleRequested: getYnToggle('nc-tap-handle'),
      salesRep: state.rep || '',
      addedBy: state.rep || '',
      // No more Fintech/ACH choice -- every account goes on Stripe now.
      paymentMethod: 'ACH / Stripe ACH'
    };

    var required = ['establishmentName', 'phone', 'email'];
    if (!val('nc-address-street') || !val('nc-address-city') || !val('nc-address-state') || !val('nc-address-zip')) {
      errEl.textContent = 'Please fill in the full business address.';
      return;
    }
    if (!val('nc-contact-first') || !val('nc-contact-last')) {
      errEl.textContent = 'Please fill in the ordering contact’s first and last name.';
      return;
    }
    if (!val('nc-region')) {
      errEl.textContent = 'Please select a region.';
      return;
    }
    if (billingDiffers && (!val('nc-billing-street') || !val('nc-billing-city') || !val('nc-billing-state') || !val('nc-billing-zip'))) {
      errEl.textContent = 'Please fill in the full billing address, or select "Yes" if it matches the business address.';
      return;
    }
    var missing = required.filter(function (k) { return !newCustomer[k]; });
    if (missing.length) { errEl.textContent = 'Please fill in all required fields.'; return; }

    var btn = document.getElementById('nc-submit');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    var addedFromHome = state.newCustomerReturnTo === 'screen-home';

    var finish = function () {
      state.customers.unshift(newCustomer);
      btn.disabled = false;
      btn.textContent = 'Save Customer';
      toast('Account added');
      if (addedFromHome) {
        // Give the rep the option to place an order right away instead of
        // bouncing them back home -- most new accounts get their first
        // order placed on the same visit.
        document.getElementById('nc-success-message').textContent = newCustomer.establishmentName + ' was added.';
        document.getElementById('new-customer-form').style.display = 'none';
        document.getElementById('back-newcustomer-to-customers').style.display = 'none';
        document.getElementById('nc-success').style.display = 'flex';
        state.lastAddedCustomer = newCustomer;
      } else {
        setCustomer(newCustomer);
        showScreen('screen-order');
      }
    };

    if (!apiConfigured()) { finish(); return; }

    apiPost({ action: 'addCustomer', customer: newCustomer })
      .then(function (res) {
        if (res.ok) finish();
        else { errEl.textContent = res.error || 'Could not save customer.'; btn.disabled = false; btn.textContent = 'Save Customer'; }
      })
      .catch(function (err) {
        // Still let the rep keep working offline-ish: customer is usable this session even if the sheet write failed.
        errEl.textContent = friendlyApiError(err) + ' Customer is saved for this session — try again later to sync it to the sheet.';
        finish();
      });
  });

  function renderProductList() {
    var host = document.getElementById('product-list');

    var tiles = window.LM_PRODUCTS.map(function (p) {
      var selected = !!state.selection[p.id];
      return (
        '<button type="button" class="product-tile' + (selected ? ' selected' : '') + '" data-toggle="' + p.id + '" style="--tile-accent:' + p.accent + ';">' +
          '<span class="tile-check">' + (selected ? '✓' : '+') + '</span>' +
          '<span class="tile-logo"><img src="' + p.image + '" alt="' + escapeHtml(p.name) + ' can" /></span>' +
          '<span class="tile-name">' + escapeHtml(p.name) + '</span>' +
          '<span class="tile-sub">' + escapeHtml(p.subtitle) + '</span>' +
        '</button>'
      );
    }).join('');

    var details = window.LM_PRODUCTS.filter(function (p) { return !!state.selection[p.id]; }).map(function (p) {
      return (
        '<div class="product-details-card" data-product="' + p.id + '">' +
          '<div class="details-title">' + escapeHtml(p.name) + '</div>' +
          '<div class="format-list">' +
            p.formats.map(function (f) {
              var qty = (state.selection[p.id] && state.selection[p.id][f.code]) || 0;
              return (
                '<div class="format-row" data-product="' + p.id + '" data-code="' + f.code + '">' +
                  '<div><div class="flabel">' + escapeHtml(f.label) + '</div>' +
                  '<div class="fdetail">' + escapeHtml(f.detail) + ' · $' + f.price.toFixed(2) + ' ea</div>' +
                  '<div class="fcode">' + f.code + '</div></div>' +
                  '<div class="qty-stepper">' +
                    '<button data-step="-1">−</button>' +
                    '<span class="qty-val">' + qty + '</span>' +
                    '<button data-step="1">+</button>' +
                  '</div>' +
                '</div>'
              );
            }).join('') +
          '</div>' +
        '</div>'
      );
    }).join('');

    host.innerHTML = '<div class="product-grid">' + tiles + '</div>' + details;
  }

  document.getElementById('product-list').addEventListener('click', function (e) {
    var toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) {
      var toggleId = toggleBtn.getAttribute('data-toggle');
      if (state.selection[toggleId]) delete state.selection[toggleId];
      else state.selection[toggleId] = {};
      renderProductList();
      updateOrderTotal();
      return;
    }
    var stepBtn = e.target.closest('button[data-step]');
    if (stepBtn) {
      var row = stepBtn.closest('.format-row');
      var productId = row.getAttribute('data-product');
      var code = row.getAttribute('data-code');
      var delta = parseInt(stepBtn.getAttribute('data-step'), 10);
      if (!state.selection[productId]) state.selection[productId] = {};
      var current = state.selection[productId][code] || 0;
      var next = Math.max(0, current + delta);
      if (next === 0) delete state.selection[productId][code];
      else state.selection[productId][code] = next;
      row.querySelector('.qty-val').textContent = next;
      updateOrderTotal();
    }
  });

  function collectLineItems() {
    var lines = [];
    window.LM_PRODUCTS.forEach(function (p) {
      var sel = state.selection[p.id];
      if (!sel) return;
      p.formats.forEach(function (f) {
        var qty = sel[f.code];
        if (qty > 0) {
          lines.push({
            productName: p.name,
            packagingFormat: f.label + ' (' + f.detail + ')',
            productCode: f.code,
            qty: qty,
            price: f.price,
            lineTotal: Math.round(f.price * qty * 100) / 100
          });
        }
      });
    });
    return lines;
  }

  function updateOrderTotal() {
    var lines = collectLineItems();
    var box = document.getElementById('order-total-box');
    var val = document.getElementById('order-total-value');
    if (!lines.length) { box.style.display = 'none'; return; }
    var total = lines.reduce(function (sum, l) { return sum + l.lineTotal; }, 0);
    val.textContent = '$' + total.toFixed(2);
    box.style.display = 'block';
  }

  document.getElementById('footer-submit').addEventListener('click', function () {
    var notes = document.getElementById('order-notes').value.trim();
    var expectedEmptyKegs = Math.max(0, Number(document.getElementById('order-expected-empties').value) || 0);
    var lines = collectLineItems();

    if (!state.customer) { toast('Select a customer account', true); return; }
    if (!lines.length) { toast('Select at least one beer and quantity', true); return; }

    var btn = document.getElementById('footer-submit');
    var label = document.getElementById('footer-submit-label');
    btn.disabled = true;
    label.innerHTML = '<span class="spinner"></span> Submitting...';

    var payload = {
      action: 'order',
      rep: state.rep,
      customer: state.customer.establishmentName,
      licenseNumber: state.customer.licenseNumber || '',
      region: state.customer.region || '',
      paymentMethod: state.customer.paymentMethod || '',
      poDate: new Date().toISOString().slice(0, 10),
      notes: notes,
      expectedEmptyKegs: expectedEmptyKegs,
      tapHandleNeeded: getYnToggle('order-tap-handle'),
      lines: lines
    };

    var finish = function (ok, msg, invoiceNumber) {
      btn.disabled = false;
      label.textContent = 'Submit Order';
      toast(msg, !ok);
      if (ok) {
        loadStats();
        if (invoiceNumber) openInvoice(invoiceNumber);
        else showScreen('screen-home');
      }
    };

    if (!apiConfigured()) {
      setTimeout(function () { finish(true, 'Order captured (demo mode — connect the sheet in config.js)'); }, 500);
      return;
    }

    apiPost(payload)
      .then(function (res) {
        if (res.ok) finish(true, lines.length + ' line item(s) sent to the order sheet', res.invoiceNumber);
        else finish(false, res.error || 'Order failed to submit');
      })
      .catch(function (err) { finish(false, friendlyApiError(err)); });
  });

  // ---------- Marketing materials request ----------
  // The catalog lives in assets/js/marketing-materials.js (transcribed from
  // the Marketing Materials & Merch Master Tracker). This section is the
  // form over it: 78 items in 12 categories, an optional ship-to account,
  // and the free-text request fields carried over from Firestone Walker's
  // form for anything the catalog doesn't cover.
  var MK_MAX_FILES = 5;
  var MK_MAX_FILE_BYTES = 5 * 1024 * 1024;
  var MK_MAX_TOTAL_BYTES = 15 * 1024 * 1024;
  var MK_NO_SIZE = ''; // the size key used for items that aren't ordered by size

  // itemId -> { item, category }. Built once; the catalog is a static bundle,
  // and submit has to resolve a bare id back to its category and brand.
  var mkIndex = (function () {
    var map = {};
    (window.LM_MARKETING_CATEGORIES || []).forEach(function (cat) {
      cat.items.forEach(function (item) { map[item.id] = { item: item, category: cat }; });
    });
    return map;
  })();

  function mkState() {
    if (!state.marketing) resetMarketingForm();
    return state.marketing;
  }

  function resetMarketingForm() {
    state.marketing = {
      account: null,
      selection: {}, // itemId -> { sizeKey: qty }
      openCats: {},  // categoryId -> true when expanded
      brand: 'All',
      query: '',
      files: []      // { file, name, size } -- read to base64 only at submit
    };
    document.getElementById('mk-email').value = '';
    document.getElementById('mk-purpose').value = '';
    document.getElementById('mk-needed-by').value = '';
    document.getElementById('mk-event-name').value = '';
    document.getElementById('mk-ship-address').value = '';
    document.getElementById('mk-custom').value = '';
    document.getElementById('mk-size').value = '';
    document.getElementById('mk-other').value = '';
    document.getElementById('mk-search').value = '';
    document.getElementById('mk-files').value = '';
    document.getElementById('mk-error').textContent = '';
  }

  function openMarketingForm() {
    resetMarketingForm();
    document.getElementById('mk-requestor').value = state.rep || '';

    var sel = document.getElementById('mk-purpose');
    if (sel.options.length <= 1) {
      (window.LM_MARKETING_PURPOSES || []).forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        sel.appendChild(opt);
      });
    }

    // Nothing can be needed in the past, and today is a legitimate answer
    // (a rep standing in an account asking for stickers on the next run).
    document.getElementById('mk-needed-by').min = new Date().toISOString().slice(0, 10);

    var total = Object.keys(mkIndex).length;
    document.getElementById('mk-catalog-hint').textContent =
      'Tap a category, then set quantities. ' + total + ' items across ' +
      (window.LM_MARKETING_CATEGORIES || []).length + ' categories.';

    renderMarketingBrandFilter();
    renderMarketingCatalog();
    renderMarketingAccount();
    renderMarketingFileList();
    renderMarketingSummary();
    showScreen('screen-marketing');
  }

  document.getElementById('btn-marketing-order').addEventListener('click', openMarketingForm);
  document.getElementById('back-marketing-to-home').addEventListener('click', function () { showScreen('screen-home'); });
  document.getElementById('mk-cancel').addEventListener('click', function () {
    resetMarketingForm();
    showScreen('screen-home');
  });

  // ---- Ship-to account (optional throughout) ----
  function setMarketingAccount(c) {
    var mk = mkState();
    mk.account = c || null;
    // Prefilled, not locked: the account is the usual answer for both fields,
    // but a rep sending materials to an offsite event for that account needs
    // to be able to type over them.
    if (c) {
      var nameField = document.getElementById('mk-event-name');
      if (!nameField.value.trim()) nameField.value = c.establishmentName || '';
      var addrField = document.getElementById('mk-ship-address');
      if (!addrField.value.trim() && c.address) addrField.value = c.address;
    }
    renderMarketingAccount();
  }

  function renderMarketingAccount() {
    var mk = mkState();
    var label = document.getElementById('mk-account-label');
    var detail = document.getElementById('mk-account-detail');
    var clear = document.getElementById('mk-clear-account');
    if (!mk.account) {
      label.textContent = 'Select account →';
      detail.style.display = 'none';
      clear.style.display = 'none';
      return;
    }
    label.textContent = mk.account.establishmentName + ' — change';
    detail.style.display = 'block';
    detail.innerHTML =
      '<div class="oline"><span>Address</span><span>' + escapeHtml(mk.account.address || '—') + '</span></div>' +
      (mk.account.region ? '<div class="oline"><span>Region</span><span>' + escapeHtml(mk.account.region) + '</span></div>' : '');
    clear.style.display = 'block';
  }

  document.getElementById('mk-btn-pick-account').addEventListener('click', function () {
    openCustomerPicker('screen-marketing');
  });

  document.getElementById('mk-clear-account').addEventListener('click', function (e) {
    e.preventDefault();
    mkState().account = null;
    renderMarketingAccount();
  });

  // ---- Catalog ----
  function renderMarketingBrandFilter() {
    var brands = ['All'].concat(window.LM_MARKETING_BRANDS || []);
    var mk = mkState();
    document.getElementById('mk-brand-filter').innerHTML = brands.map(function (b) {
      return '<button type="button" class="chip' + (mk.brand === b ? ' selected' : '') +
        '" data-brand="' + escapeHtml(b) + '">' + escapeHtml(b) + '</button>';
    }).join('');
  }

  function mkItemMatches(item, cat, mk) {
    // Multi-Brand items stay visible under a specific brand filter -- they
    // carry all three marks, so a rep filtered to Cantinesca still wants the
    // shared bar mats and stadium cups in front of them.
    if (mk.brand !== 'All' && item.brand !== mk.brand && item.brand !== 'Multi-Brand') return false;
    if (!mk.query) return true;
    var haystack = (item.name + ' ' + item.brand + ' ' + item.id + ' ' + cat.name + ' ' + (item.note || '')).toLowerCase();
    return haystack.indexOf(mk.query) !== -1;
  }

  function mkItemQty(itemId) {
    var sizes = mkState().selection[itemId];
    if (!sizes) return 0;
    return Object.keys(sizes).reduce(function (sum, k) { return sum + sizes[k]; }, 0);
  }

  function mkCategoryQty(cat) {
    return cat.items.reduce(function (sum, item) { return sum + mkItemQty(item.id); }, 0);
  }

  function mkStepperHtml(itemId, sizeKey, qty) {
    return '<div class="qty-stepper" data-item="' + itemId + '" data-size="' + escapeHtml(sizeKey) + '">' +
      '<button type="button" data-step="-1">−</button>' +
      '<span class="qty-val">' + qty + '</span>' +
      '<button type="button" data-step="1">+</button>' +
      '</div>';
  }

  function mkItemHtml(item, cat) {
    var subParts = [item.brand];
    if (item.note) subParts.push(item.note);
    if (item.unit) subParts.push('per ' + item.unit);
    var text =
      '<div class="mk-item-text">' +
        '<div class="mk-item-name">' + escapeHtml(item.name) + '</div>' +
        '<div class="mk-item-sub">' + escapeHtml(subParts.join(' · ')) + '</div>' +
        '<div class="mk-item-id">' + escapeHtml(item.id) + '</div>' +
      '</div>';
    var qty = mkItemQty(item.id);

    if (!item.sizes) {
      return '<div class="mk-item' + (qty ? ' has-qty' : '') + '" data-item="' + item.id + '">' +
        text + mkStepperHtml(item.id, MK_NO_SIZE, qty) + '</div>';
    }

    // Sized items get a header row plus one stepper per size -- a single
    // quantity on a garment isn't actionable for whoever places the order.
    var sizeRows = item.sizes.map(function (sz) {
      var szQty = (mkState().selection[item.id] || {})[sz] || 0;
      return '<div class="mk-size-row">' +
        '<span class="mk-size-label">' + escapeHtml(sz) + '</span>' +
        mkStepperHtml(item.id, sz, szQty) +
        '</div>';
    }).join('');

    return '<div class="mk-sized">' +
      '<div class="mk-item' + (qty ? ' has-qty' : '') + '" data-item="' + item.id + '">' +
        text +
        '<span class="mk-item-sub">' + (qty ? qty + ' total' : 'by size') + '</span>' +
      '</div>' +
      '<div class="mk-size-grid">' + sizeRows + '</div>' +
      '</div>';
  }

  function renderMarketingCatalog() {
    var mk = mkState();
    var host = document.getElementById('mk-catalog');
    // A search or a brand filter force-opens every category that still has a
    // match. Leaving them collapsed would show a rep who typed "sticker" a
    // list of category headers and no stickers.
    var forceOpen = !!mk.query || mk.brand !== 'All';
    var anyShown = false;

    var html = (window.LM_MARKETING_CATEGORIES || []).map(function (cat) {
      var items = cat.items.filter(function (item) { return mkItemMatches(item, cat, mk); });
      if (!items.length) return '';
      anyShown = true;
      var qty = mkCategoryQty(cat);
      // A category holding a quantity always stays open, even if the rep
      // then narrows the search past it -- so nothing they've already picked
      // can end up hidden behind a collapsed header at submit time.
      var open = forceOpen || !!mk.openCats[cat.id] || qty > 0;
      return '<div class="mk-cat' + (qty ? ' has-qty' : '') + '" data-cat="' + cat.id + '">' +
        '<button type="button" class="mk-cat-head" data-toggle-cat="' + cat.id + '">' +
          '<span>' + escapeHtml(cat.name) +
            '<span class="mk-cat-blurb">' + escapeHtml(cat.blurb) + '</span>' +
          '</span>' +
          '<span class="mk-cat-meta">' +
            (qty ? '<span class="mk-cat-badge">' + qty + '</span>' : '') +
            '<span class="mk-cat-count">' + items.length + '</span>' +
            '<span class="mk-cat-caret">' + (open ? '▾' : '▸') + '</span>' +
          '</span>' +
        '</button>' +
        (open ? '<div class="mk-cat-body">' + items.map(function (item) { return mkItemHtml(item, cat); }).join('') + '</div>' : '') +
        '</div>';
    }).join('');

    host.innerHTML = anyShown ? html : '<div class="empty-note">No materials match that search. Try fewer words, or describe what you need under Custom Request below.</div>';
  }

  document.getElementById('mk-search').addEventListener('input', function (e) {
    mkState().query = e.target.value.trim().toLowerCase();
    renderMarketingCatalog();
  });

  document.getElementById('mk-brand-filter').addEventListener('click', function (e) {
    var chip = e.target.closest('[data-brand]');
    if (!chip) return;
    mkState().brand = chip.getAttribute('data-brand');
    renderMarketingBrandFilter();
    renderMarketingCatalog();
  });

  document.getElementById('mk-catalog').addEventListener('click', function (e) {
    var catBtn = e.target.closest('[data-toggle-cat]');
    if (catBtn) {
      var catId = catBtn.getAttribute('data-toggle-cat');
      var mk = mkState();
      mk.openCats[catId] = !mk.openCats[catId];
      renderMarketingCatalog();
      return;
    }

    var stepBtn = e.target.closest('button[data-step]');
    if (!stepBtn) return;
    var stepper = stepBtn.closest('.qty-stepper');
    var itemId = stepper.getAttribute('data-item');
    var sizeKey = stepper.getAttribute('data-size');
    var mkS = mkState();
    if (!mkS.selection[itemId]) mkS.selection[itemId] = {};
    var current = mkS.selection[itemId][sizeKey] || 0;
    var next = Math.max(0, current + parseInt(stepBtn.getAttribute('data-step'), 10));
    if (next === 0) delete mkS.selection[itemId][sizeKey];
    else mkS.selection[itemId][sizeKey] = next;
    if (!Object.keys(mkS.selection[itemId]).length) delete mkS.selection[itemId];

    // Patched in place rather than re-rendered: a full re-render on every tap
    // would collapse the rep's scroll position back to the top of a 78-item
    // list mid-way through setting quantities.
    stepper.querySelector('.qty-val').textContent = next;
    var itemTotal = mkItemQty(itemId);
    var itemRow = document.querySelector('.mk-item[data-item="' + itemId + '"]');
    if (itemRow) {
      itemRow.classList.toggle('has-qty', itemTotal > 0);
      var sizedTotal = itemRow.querySelector('.mk-item-sub:last-child');
      if (sizedTotal && itemRow.parentElement.classList.contains('mk-sized')) {
        sizedTotal.textContent = itemTotal ? itemTotal + ' total' : 'by size';
      }
    }
    var cat = mkIndex[itemId] && mkIndex[itemId].category;
    if (cat) {
      var catEl = document.querySelector('.mk-cat[data-cat="' + cat.id + '"]');
      var catQty = mkCategoryQty(cat);
      if (catEl) {
        catEl.classList.toggle('has-qty', catQty > 0);
        var meta = catEl.querySelector('.mk-cat-meta');
        var badge = meta.querySelector('.mk-cat-badge');
        if (catQty > 0) {
          if (badge) badge.textContent = catQty;
          else meta.insertAdjacentHTML('afterbegin', '<span class="mk-cat-badge">' + catQty + '</span>');
        } else if (badge) {
          badge.remove();
        }
      }
    }
    renderMarketingSummary();
  });

  function collectMarketingLines() {
    var mk = mkState();
    var lines = [];
    (window.LM_MARKETING_CATEGORIES || []).forEach(function (cat) {
      cat.items.forEach(function (item) {
        var sizes = mk.selection[item.id];
        if (!sizes) return;
        var keys = item.sizes ? item.sizes : [MK_NO_SIZE];
        keys.forEach(function (sizeKey) {
          var qty = sizes[sizeKey];
          if (!qty) return;
          lines.push({
            itemId: item.id,
            category: cat.name,
            brand: item.brand,
            item: item.name,
            size: sizeKey,
            qty: qty,
            unit: item.unit || 'ea'
          });
        });
      });
    });
    return lines;
  }

  function renderMarketingSummary() {
    var lines = collectMarketingLines();
    var box = document.getElementById('mk-summary');
    if (!lines.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var units = lines.reduce(function (sum, l) { return sum + l.qty; }, 0);
    box.innerHTML =
      lines.map(function (l) {
        return '<div class="oline"><span>' + escapeHtml(l.item) +
          (l.size ? ' — ' + escapeHtml(l.size) : '') + ' <small style="color:var(--silver-dim);">' + escapeHtml(l.brand) + '</small></span>' +
          '<span>' + l.qty + ' ' + escapeHtml(l.unit) + '</span></div>';
      }).join('') +
      '<div class="oline"><strong>' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + '</strong><strong>' + units + ' units</strong></div>';
    box.style.display = 'block';
  }

  // ---- Attachments ----
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function addMarketingFiles(fileList) {
    var mk = mkState();
    var rejected = [];
    Array.prototype.forEach.call(fileList, function (f) {
      if (mk.files.length >= MK_MAX_FILES) { rejected.push(f.name + ' (max ' + MK_MAX_FILES + ' files)'); return; }
      if (f.size > MK_MAX_FILE_BYTES) { rejected.push(f.name + ' (over ' + fmtBytes(MK_MAX_FILE_BYTES) + ')'); return; }
      var total = mk.files.reduce(function (sum, x) { return sum + x.size; }, 0);
      if (total + f.size > MK_MAX_TOTAL_BYTES) { rejected.push(f.name + ' (over the ' + fmtBytes(MK_MAX_TOTAL_BYTES) + ' total)'); return; }
      mk.files.push({ file: f, name: f.name, size: f.size, type: f.type || 'application/octet-stream' });
    });
    renderMarketingFileList();
    if (rejected.length) toast('Skipped: ' + rejected.join(', '), true);
  }

  function renderMarketingFileList() {
    var mk = mkState();
    document.getElementById('mk-file-list').innerHTML = mk.files.map(function (f, i) {
      return '<div class="file-row">' +
        '<span class="fname">' + escapeHtml(f.name) + '</span>' +
        '<span class="fsize">' + fmtBytes(f.size) + '</span>' +
        '<button type="button" data-remove-file="' + i + '" aria-label="Remove ' + escapeHtml(f.name) + '">×</button>' +
        '</div>';
    }).join('');
  }

  document.getElementById('mk-file-btn').addEventListener('click', function () {
    document.getElementById('mk-files').click();
  });

  document.getElementById('mk-files').addEventListener('change', function (e) {
    addMarketingFiles(e.target.files);
    e.target.value = ''; // so re-picking the same file still fires change
  });

  document.getElementById('mk-file-list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-remove-file]');
    if (!btn) return;
    mkState().files.splice(parseInt(btn.getAttribute('data-remove-file'), 10), 1);
    renderMarketingFileList();
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    document.getElementById('mk-file-drop').addEventListener(evt, function (e) {
      e.preventDefault();
      this.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    document.getElementById('mk-file-drop').addEventListener(evt, function (e) {
      e.preventDefault();
      this.classList.remove('dragover');
      if (evt === 'drop' && e.dataTransfer && e.dataTransfer.files) addMarketingFiles(e.dataTransfer.files);
    });
  });

  // Reads the queued files to base64 for the JSON POST. Done at submit rather
  // than at pick time so a rep who attaches a file and then removes it never
  // pays for the read, and so nothing large sits in memory while they're
  // still filling the form in.
  function readMarketingAttachments() {
    var files = mkState().files;
    if (!files.length) return Promise.resolve([]);
    return Promise.all(files.map(function (f) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var result = String(reader.result || '');
          resolve({ name: f.name, mimeType: f.type, dataBase64: result.slice(result.indexOf(',') + 1) });
        };
        reader.onerror = function () { reject(new Error('Could not read ' + f.name)); };
        reader.readAsDataURL(f.file);
      });
    }));
  }

  // ---- Submit ----
  document.getElementById('mk-submit').addEventListener('click', function () {
    var mk = mkState();
    var errEl = document.getElementById('mk-error');
    errEl.textContent = '';

    var email = document.getElementById('mk-email').value.trim();
    var purpose = document.getElementById('mk-purpose').value;
    var neededBy = document.getElementById('mk-needed-by').value;
    var customRequest = document.getElementById('mk-custom').value.trim();
    var lines = collectMarketingLines();

    if (!purpose) { errEl.textContent = 'Choose what this request is for.'; return; }
    if (!neededBy) { errEl.textContent = 'Enter the date you need this by.'; return; }
    // The account is deliberately optional, so the thing that has to be
    // present is the ask itself -- either picked items or a described one.
    if (!lines.length && !customRequest) {
      errEl.textContent = 'Add at least one material, or describe what you need under Custom Request.';
      return;
    }
    if (email && email.indexOf('@') === -1) { errEl.textContent = 'That email address looks incomplete.'; return; }

    var btn = document.getElementById('mk-submit');
    var label = document.getElementById('mk-submit-label');
    btn.disabled = true;
    label.innerHTML = '<span class="spinner"></span> Submitting...';

    var finish = function (ok, msg) {
      btn.disabled = false;
      label.textContent = 'Submit Request';
      toast(msg, !ok);
      if (ok) {
        resetMarketingForm();
        showScreen('screen-home');
      } else {
        errEl.textContent = msg;
      }
    };

    if (!apiConfigured()) {
      setTimeout(function () { finish(true, 'Request captured (demo mode — connect the sheet in config.js)'); }, 500);
      return;
    }

    readMarketingAttachments()
      .then(function (attachments) {
        return apiPost({
          action: 'marketingOrder',
          rep: state.rep,
          email: email,
          purpose: purpose,
          neededBy: neededBy,
          requestDate: new Date().toISOString().slice(0, 10),
          account: mk.account ? mk.account.establishmentName : '',
          accountRegion: mk.account ? (mk.account.region || '') : '',
          eventName: document.getElementById('mk-event-name').value.trim(),
          shipAddress: document.getElementById('mk-ship-address').value.trim(),
          customRequest: customRequest,
          size: document.getElementById('mk-size').value.trim(),
          otherDetails: document.getElementById('mk-other').value.trim(),
          lines: lines,
          attachments: attachments
        });
      })
      .then(function (res) {
        if (!res.ok) { finish(false, res.error || 'Request failed to submit'); return; }
        var what = lines.length ? lines.length + ' line item(s)' : 'Custom request';
        finish(true, what + ' sent to marketing' + (res.requestNumber ? ' — ' + res.requestNumber : ''));
      })
      .catch(function (err) {
        finish(false, err && err.message === 'NOT_SIGNED_IN' ? friendlyApiError(err) : (err.message || 'Request failed to submit'));
      });
  });

  // ---------- Boot ----------
  var existing = loadSession();
  if (existing) {
    state.rep = existing;
    state.repRole = loadRole();
    enterHome();
  } else {
    // #screen-login already carries .active in the markup, so there is
    // nothing to show -- just make sure the pad starts empty (a reload
    // mid-entry would otherwise leave stale dots filled in).
    resetPinPad();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
