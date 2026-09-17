(function () {
  var API = window.LM_CONFIG.APPS_SCRIPT_URL;
  var state = {
    rep: null,
    stats: null,
    selection: {}, // productId -> { formatCode: qty }
    invoiceEdit: null, // working copy of the invoice currently on screen-invoice, see openInvoice()
    customer: null,
    customerPickerReturn: 'screen-order', // which screen screen-customers returns to
    accountReturn: 'screen-map', // which screen screen-account returns to, see openAccountDetail
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
    if (id === 'screen-home') {
      window.setTimeout(renderHomeTerritoryMap, 0);
    }
  }

  function toast(msg, isError) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  // A small confirmation moment is more useful than decorative motion: it
  // makes a completed order feel unambiguous before the app moves on. It only
  // appears after a successful write and respects the user's motion setting.
  function celebrate(title, detail) {
    var layer = document.getElementById('celebration-layer');
    if (!layer) return;
    layer.innerHTML = '';
    var card = document.createElement('div');
    card.className = 'success-burst';
    card.innerHTML = '<strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(detail) + '</span>';
    layer.appendChild(card);

    if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      var colors = ['#ffbd28', '#ed633f', '#8bd7bd', '#fffdf8'];
      for (var i = 0; i < 15; i++) {
        var piece = document.createElement('i');
        piece.className = 'confetti-dot';
        piece.style.left = (8 + Math.random() * 84) + '%';
        piece.style.background = colors[i % colors.length];
        piece.style.setProperty('--x', (Math.random() * 36 - 18) + 'px');
        piece.style.setProperty('--drift', (Math.random() * 110 - 55) + 'px');
        piece.style.animationDelay = (Math.random() * .18) + 's';
        layer.appendChild(piece);
      }
    }
    setTimeout(function () { layer.innerHTML = ''; }, 3000);
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
          // Same reason as the picker above: this refresh lands a beat after
          // the screen paints from cache, and a rep who just added an account
          // should see it appear rather than have to navigate away and back.
          if (screens['screen-my-accounts'].classList.contains('active')) {
            renderMyAccounts(document.getElementById('my-accounts-search').value);
          }
          updateMyMapButton();
          renderHomeTerritoryMap();
          renderAccountMetric();
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
    renderAccountMetric();

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

  // The accounts linked to the logged-in rep. Matched by LAST NAME because
  // Customer Accounts writes "J. Williams" while the Reps tab writes "James
  // Williams" -- the same mismatch repLastName() exists for everywhere else
  // in this file. `addedBy` wins over `salesRep` when present, so an account
  // handed to a different rep still counts for whoever put it in.
  //
  // Deliberately NOT filtered on lat/lng the way myMappedAccounts() is: a
  // rep's list is every account of theirs, not just the ones that happen to
  // be geocoded onto the LA map.
  function myAccounts() {
    var mine = repLastName(state.rep);
    if (!mine) return [];
    return state.customers.filter(function (customer) {
      return repLastName(customer.addedBy || customer.salesRep) === mine;
    });
  }

  function renderAccountMetric() {
    document.getElementById('stat-accounts').textContent = myAccounts().length;
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
    document.getElementById('invoice-slack-btn').style.display = 'none';

    apiGet({ action: 'invoiceDetail', invoiceNumber: invoiceNumber })
      .then(function (res) {
        if (!res.ok) { document.getElementById('invoice-loading').textContent = res.error || 'Could not load invoice.'; return; }
        state.invoiceEdit = cloneInvoiceForEdit(res);
        renderEditableInvoice();
        document.getElementById('invoice-loading').style.display = 'none';
        document.getElementById('invoice-doc').style.display = 'block';
        document.getElementById('invoice-print-btn').style.display = 'block';
        // Hidden rather than disabled when there's no thread: an order from
        // before the Slack reference was stored has nothing to link to, and
        // a dead button is worse than no button. Both the account history
        // and this screen offer the jump, so a rep who came here via
        // "View invoice" doesn't have to go back for it.
        var slackBtn = document.getElementById('invoice-slack-btn');
        if (res.slackThreadUrl) {
          slackBtn.href = res.slackThreadUrl;
          slackBtn.style.display = 'flex';
        }
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

  // Pin colour is keyed to the rep who added the account, matched by LAST
  // NAME -- Customer Accounts writes "J. Williams" while the Reps tab writes
  // "James Williams", so territoryRep has to resolve both to one person.
  // That's the same mismatch repLastName() already exists for above.
  //
  // Deliberately NOT limited to the two reps who work LA most. An account
  // added by anyone -- someone covering the area for a week, a new hire not
  // listed here yet -- still belongs on the map, so an unrecognised rep
  // falls through to UNKNOWN_TERRITORY_REP instead of being dropped. The
  // previous ricardo/james lookup matched on first name and so silently
  // matched nothing at all: "R. Villanueva" contains no "ricardo".
  var LA_TERRITORY_REPS = {
    villanueva: { name: 'Ricardo', color: '#efb11d' },
    williams:   { name: 'James', color: '#e85d86' },
    krause:     { name: 'D. Krause', color: '#4bb3a5' },
    sprague:    { name: 'S. Sprague', color: '#8a6fd4' },
    gilbert:    { name: 'T. Gilbert', color: '#3f7fd4' }
  };
  var UNKNOWN_TERRITORY_REP = { name: 'Unassigned', color: '#9aa3b2' };

  // `region` is the rep-confirmed field (see inferRegion), so it -- not a
  // raw city string -- decides what counts as "in Los Angeles". Long Beach
  // and Arcadia are separate DELIVERY regions but the same LA County map;
  // Orange County and San Diego are their own runs and stay off it.
  var LA_MAP_REGIONS = ['los angeles', 'long beach', 'arcadia'];
  var LA_CITY_COORDINATES = {
    'los angeles': [34.0522, -118.2437],
    'hollywood': [34.0928, -118.3287],
    'west hollywood': [34.0900, -118.3617],
    'santa monica': [34.0195, -118.4912],
    'culver city': [34.0211, -118.3965],
    'pasadena': [34.1478, -118.1445],
    'burbank': [34.1808, -118.3090],
    'glendale': [34.1425, -118.2551],
    'long beach': [33.7701, -118.1937],
    'inglewood': [33.9617, -118.3531],
    'torrance': [33.8358, -118.3406],
    'el segundo': [33.9192, -118.4165],
    'downey': [33.9401, -118.1332],
    'northridge': [34.2283, -118.5368],
    'redondo beach': [33.8492, -118.3884],
    'malibu': [34.0259, -118.7798],
    'arcadia': [34.1397, -118.0353],
    'whittier': [33.9792, -118.0328],
    'la mirada': [33.9172, -118.0120]
  };

  // Addresses are hand-typed and inconsistent: "8 Mission St., San Francisco,
  // CA, 94105" puts the city in its own comma field, "201 E Broadway Long
  // Beach, CA 90802" does not. So take everything before the state token and
  // match the LONGEST known city name that ends it. Longest-first is what
  // makes "long beach" win over a trailing "beach", and it's why five Long
  // Beach accounts aren't stranded by a plain split(',').
  var CITY_ALIASES = { 'rendondo beach': 'redondo beach' };

  function cityFromAddress(address) {
    var head = String(address || '').split(/,?\s*\b(?:CA|California)\b/i)[0];
    var words = head.toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
    for (var take = Math.min(3, words.length); take >= 1; take--) {
      var candidate = words.slice(words.length - take).join(' ');
      candidate = CITY_ALIASES[candidate] || candidate;
      if (LA_CITY_COORDINATES[candidate]) return candidate;
    }
    return '';
  }

  function territoryRep(customer) {
    var last = repLastName(customer && customer.salesRep);
    if (!last || last === 'n/a') return UNKNOWN_TERRITORY_REP;
    return LA_TERRITORY_REPS[last] || UNKNOWN_TERRITORY_REP;
  }

  // A newly added account gets a stable, city-level point immediately. That
  // keeps the route useful while the full address is awaiting geocoding.
  //
  // The scatter around the city centre is a positional hash, not jitter: the
  // same account must land on the same spot every render. A plain sum of
  // char codes collided (BiergartenLA and Birds Bar & Cafe drew identical
  // offsets, so one pin sat invisibly under the other), so this uses djb2
  // and takes the two axes from separate halves of the hash.
  // `attempt` is the collision probe (see spreadApproximatePins): 0 is the
  // account's natural cell, and each retry re-hashes to a different one.
  function accountCoordinates(city, accountName, attempt) {
    var normalizedCity = String(city || '').trim().toLowerCase();
    var base = LA_CITY_COORDINATES[normalizedCity] || LA_CITY_COORDINATES['los angeles'];
    var text = String(accountName || normalizedCity) + (attempt ? '#' + attempt : '');
    var hash = 5381;
    for (var i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    hash = Math.abs(hash);
    var STEPS = 13;      // odd, so the grid has a true centre
    var SPACING = 0.0022; // ~0.24 km -- inside the city, clear of its neighbours
    var latOffset = ((hash % STEPS) - (STEPS - 1) / 2) * SPACING;
    var lngOffset = ((Math.floor(hash / STEPS) % STEPS) - (STEPS - 1) / 2) * SPACING;
    return { lat: +(base[0] + latOffset).toFixed(6), lng: +(base[1] + lngOffset).toFixed(6) };
  }

  // Membership is by region, not by rep -- every LA County account is on the
  // map regardless of who owns it, and the rep only decides the colour.
  //
  // The lat/lng fallback is load-bearing rather than defensive: not one of
  // the LA accounts in the sheet has been geocoded yet, so requiring real
  // coordinates (as this did before) rendered an empty map. A city-level
  // point is flagged `approximate` so the UI can say so instead of implying
  // a precision it doesn't have.
  function territoryEntries() {
    var entries = state.customers.map(function (customer) {
      var region = String((customer && customer.region) || '').trim().toLowerCase();
      if (LA_MAP_REGIONS.indexOf(region) === -1) return null;
      var lat = Number(customer.lat);
      var lng = Number(customer.lng);
      var approximate = false;
      if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
        var point = accountCoordinates(cityFromAddress(customer.address), customer.establishmentName);
        lat = point.lat;
        lng = point.lng;
        approximate = true;
      }
      return {
        customer: customer,
        rep: territoryRep(customer),
        lat: lat,
        lng: lng,
        approximate: approximate,
        city: approximate ? cityFromAddress(customer.address) : ''
      };
    }).filter(Boolean);
    return spreadApproximatePins(entries);
  }

  // Two city-level pins landing in the same grid cell hides one account
  // under the other. The hash alone can't prevent that -- four accounts
  // share El Segundo, and a finite grid will collide eventually -- so
  // duplicates re-hash to the next free cell instead.
  //
  // Real geocoded coordinates are never moved: they're the truth, and two
  // businesses genuinely can share an address. Only approximate pins probe.
  // Sorting by name first keeps the outcome stable no matter what order the
  // sheet returns rows in.
  function spreadApproximatePins(entries) {
    var taken = {};
    entries.forEach(function (entry) {
      if (!entry.approximate) taken[entry.lat + ',' + entry.lng] = true;
    });
    entries.slice().sort(function (a, b) {
      return String(a.customer.establishmentName).localeCompare(String(b.customer.establishmentName));
    }).forEach(function (entry) {
      if (!entry.approximate) return;
      var attempt = 0;
      while (taken[entry.lat + ',' + entry.lng] && attempt < 50) {
        attempt++;
        var point = accountCoordinates(entry.city, entry.customer.establishmentName, attempt);
        entry.lat = point.lat;
        entry.lng = point.lng;
      }
      taken[entry.lat + ',' + entry.lng] = true;
    });
    return entries;
  }

  // Built from the accounts actually on the map, so a rep who isn't in
  // LA_TERRITORY_REPS still gets a swatch the moment they add a stop.
  // Currently unused -- the home map's rep-name legend is hidden for now
  // (see the parked call in renderHomeTerritoryMap). Kept intact, along with
  // its markup and CSS, because turning it back on is meant to be a
  // one-line change rather than a rewrite.
  function renderTerritoryLegend(entries) {
    var legend = document.getElementById('territory-legend');
    if (!legend) return;
    var order = [];
    var counts = {};
    entries.forEach(function (entry) {
      var name = entry.rep.name;
      if (!counts[name]) { counts[name] = { rep: entry.rep, count: 0 }; order.push(name); }
      counts[name].count++;
    });
    legend.innerHTML = order.map(function (name) { return counts[name]; })
      .sort(function (a, b) { return b.count - a.count; })
      .map(function (row) {
        return '<span><i class="territory-dot" style="background:' + row.rep.color +
          ';" aria-hidden="true"></i>' + escapeHtml(row.rep.name) + ' <b>' + row.count + '</b></span>';
      }).join('');
  }

  function territoryPin(rep) {
    return L.divIcon({
      className: '',
      html: '<div class="lm-pin" style="background:' + rep.color + ';"></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -26]
    });
  }

  var homeTerritoryMapInstance = null;

  function renderHomeTerritoryMap() {
    var mapEl = document.getElementById('home-territory-map');
    if (!mapEl || !window.L) return;
    var entries = territoryEntries();
    var status = document.getElementById('territory-status');
    var approximate = entries.filter(function (e) { return e.approximate; }).length;
    status.textContent = entries.length
      ? entries.length + ' LA ' + (entries.length === 1 ? 'account' : 'accounts') + ' on the map' +
        (approximate ? ' \u00b7 ' + approximate + ' placed by city, awaiting geocoding' : '') + '.'
      : 'Accounts in Los Angeles will appear here.';
    // Rep names are off the home map for now, so the legend stays empty --
    // .territory-legend:empty collapses the row, which is why nothing here
    // has to hide the container itself. Restore by uncommenting.
    // renderTerritoryLegend(entries);
    document.getElementById('territory-legend').innerHTML = '';

    if (!homeTerritoryMapInstance) {
      homeTerritoryMapInstance = L.map('home-territory-map', { zoomControl: false, attributionControl: false, scrollWheelZoom: false });
      L.control.zoom({ position: 'bottomright' }).addTo(homeTerritoryMapInstance);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd'
      }).addTo(homeTerritoryMapInstance);
    } else {
      homeTerritoryMapInstance.eachLayer(function (layer) {
        if (layer instanceof L.Marker) homeTerritoryMapInstance.removeLayer(layer);
      });
    }

    var markers = entries.map(function (entry) {
      var marker = L.marker([entry.lat, entry.lng], { icon: territoryPin(entry.rep) }).addTo(homeTerritoryMapInstance);
      marker.bindPopup(
        '<strong>' + escapeHtml(entry.customer.establishmentName) + '</strong><br/>' +
        escapeHtml(entry.customer.address || '') + '<br/>' + escapeHtml(entry.rep.name) +
        (entry.approximate ? '<br/><em>Approximate \u2014 city-level pin</em>' : '')
      );
      return marker;
    });

    if (markers.length) homeTerritoryMapInstance.fitBounds(L.featureGroup(markers).getBounds(), { padding: [30, 30], maxZoom: 10 });
    else homeTerritoryMapInstance.setView([34.0522, -118.2437], 9);
    homeTerritoryMapInstance.invalidateSize();
  }

  function updateMyMapButton() {
    var btn = document.getElementById('btn-my-map');
    btn.style.display = 'inline-flex';
  }

  document.getElementById('btn-my-map').addEventListener('click', openAccountsMap);
  document.getElementById('back-map-to-home').addEventListener('click', function () { showScreen('screen-home'); });

  var accountsMapInstance = null;

  function openAccountsMap() {
    showScreen('screen-map');
    var entries = territoryEntries();
    var accounts = entries.map(function (entry) { return entry.customer; });

    document.getElementById('map-account-list').innerHTML = entries.map(function (entry, i) {
      var c = entry.customer;
      return '<div class="order-row clickable" data-map-idx="' + i + '">' +
        '<div><div class="oname">' + escapeHtml(c.establishmentName) + '</div>' +
        '<div class="osub">' + escapeHtml(c.address || '') + ' \u00b7 ' + escapeHtml(entry.rep.name) +
        (entry.approximate ? ' \u00b7 approx.' : '') + '</div></div>' +
        '<span>→</span>' +
        '</div>';
    }).join('') || '<div class="empty-note">Los Angeles accounts will appear here.</div>';

    setTimeout(function () {
      if (!accountsMapInstance) {
        accountsMapInstance = L.map('accounts-map');
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 19,
          subdomains: 'abcd',
          attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors'
        }).addTo(accountsMapInstance);
      } else {
        accountsMapInstance.eachLayer(function (layer) {
          if (layer instanceof L.Marker) accountsMapInstance.removeLayer(layer);
        });
      }

      var markers = [];
      entries.forEach(function (entry, i) {
        var c = entry.customer;
        var marker = L.marker([entry.lat, entry.lng], { icon: territoryPin(entry.rep) }).addTo(accountsMapInstance);
        marker.bindPopup(
          '<strong>' + escapeHtml(c.establishmentName) + '</strong><br/>' + escapeHtml(c.address || '') +
          '<br/>' + escapeHtml(entry.rep.name) +
          (entry.approximate ? ' \u00b7 <em>approximate</em>' : '') +
          '<br/><a href="#" class="popup-view-orders" data-map-idx="' + i + '">View Orders \u2192</a>'
        );
        markers.push(marker);
      });

      if (markers.length) {
        accountsMapInstance.fitBounds(L.featureGroup(markers).getBounds(), { padding: [24, 24] });
      } else {
        accountsMapInstance.setView([34.0522, -118.2437], 9);
      }

      accountsMapInstance.off('popupopen').on('popupopen', function (e) {
        var link = e.popup._contentNode.querySelector('.popup-view-orders');
        if (!link) return;
        link.addEventListener('click', function (evt) {
          evt.preventDefault();
          openAccountDetail(accounts[parseInt(link.getAttribute('data-map-idx'), 10)], 'screen-map');
        });
      });

      document.getElementById('map-account-list').querySelectorAll('[data-map-idx]').forEach(function (row) {
        row.addEventListener('click', function () {
          var idx = parseInt(row.getAttribute('data-map-idx'), 10);
          openAccountDetail(accounts[idx], 'screen-map');
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

  // ---------- My accounts ----------
  // "Manage My Accounts" on the home screen. screen-map already existed and
  // already handed off to screen-account, but it only ever showed accounts
  // that geocode into LA County -- a rep in the Bay Area or Orange County
  // had no way to reach their own account list at all. This is that list:
  // every account linked to the rep, searchable, each one a door into its
  // full order history.

  document.getElementById('btn-my-accounts').addEventListener('click', openMyAccounts);
  document.getElementById('back-myaccounts-to-home').addEventListener('click', function () { showScreen('screen-home'); });

  // Rendered from state.customers, which is served out of localStorage on a
  // cold start and refreshed in the background by refreshCustomers(). So the
  // list paints instantly (offline included) and re-renders when the fetch
  // lands -- see the renderMyAccounts() call inside refreshCustomers().
  function openMyAccounts() {
    showScreen('screen-my-accounts');
    document.getElementById('my-accounts-search').value = '';
    renderMyAccounts('');
  }

  // Alphabetical, and derived the same way in both the render and the click
  // handler -- the row's data-account-idx indexes into THIS array, so the two
  // have to agree on the order or a tap opens the wrong account.
  function sortedMyAccounts() {
    return myAccounts().slice().sort(function (a, b) {
      return String(a.establishmentName || '').localeCompare(String(b.establishmentName || ''));
    });
  }

  function myAccountsMatches(customer, q) {
    if (!q) return true;
    var haystack = [
      customer.establishmentName,
      customer.region,
      customer.address,
      customer.orderingContact,
      customer.legalEntity
    ].join(' ').toLowerCase();
    return haystack.indexOf(q) !== -1;
  }

  // Region plus city, except when they name the same place -- "Los Angeles ·
  // los angeles" is what a naive join produces for most of this book, since
  // the delivery REGION and the establishment's city are frequently the same
  // word. cityFromAddress works in lowercase (it matches against a lowercase
  // city table), so anything it returns has to be re-cased before display.
  function titleCaseCity(city) {
    return String(city || '').replace(/\b[a-z]/g, function (ch) { return ch.toUpperCase(); });
  }

  function accountSubtitle(customer) {
    var region = String(customer.region || '').trim();
    var city = titleCaseCity(cityFromAddress(customer.address));
    var meta = [region];
    if (city && city.toLowerCase() !== region.toLowerCase()) meta.push(city);
    meta = meta.filter(Boolean);
    return meta.length ? meta.join(' · ') : (customer.address || 'No address on file');
  }

  function renderMyAccounts(query) {
    var host = document.getElementById('my-accounts-list');
    var mine = sortedMyAccounts();

    // The two counters describe the rep's whole book, not the current
    // search -- a filtered "1 linked account" would read as data loss.
    document.getElementById('my-accounts-count').textContent = mine.length;
    var regions = {};
    mine.forEach(function (c) {
      var r = String(c.region || '').trim();
      if (r) regions[r] = true;
    });
    document.getElementById('my-accounts-regions').textContent = Object.keys(regions).length;

    if (!mine.length) {
      host.innerHTML = '<div class="empty-note">No accounts are linked to you yet. Anything you add with <strong>Add New Account</strong> shows up here.</div>';
      return;
    }

    // Each surviving row keeps the index it had in the UNFILTERED list, so
    // data-account-idx still resolves once the rep types in the search box
    // (the click handler re-derives the same unfiltered array).
    var q = String(query || '').trim().toLowerCase();
    var list = mine
      .map(function (c, i) { return { customer: c, index: i }; })
      .filter(function (entry) { return myAccountsMatches(entry.customer, q); });

    if (!list.length) {
      host.innerHTML = '<div class="empty-note">No accounts match “' + escapeHtml(query) + '”.</div>';
      return;
    }

    host.innerHTML = list.map(function (entry) {
      var c = entry.customer;
      return '<div class="order-row clickable" data-account-idx="' + entry.index + '">' +
        '<div><div class="oname">' + escapeHtml(c.establishmentName || 'Unnamed account') + '</div>' +
        '<div class="osub">' + escapeHtml(accountSubtitle(c)) + '</div></div>' +
        '<span>→</span>' +
        '</div>';
    }).join('');
  }

  document.getElementById('my-accounts-search').addEventListener('input', function (e) {
    renderMyAccounts(e.target.value);
  });

  document.getElementById('my-accounts-list').addEventListener('click', function (e) {
    var row = e.target.closest('.order-row[data-account-idx]');
    if (!row) return;
    var account = sortedMyAccounts()[parseInt(row.getAttribute('data-account-idx'), 10)];
    if (account) openAccountDetail(account, 'screen-my-accounts');
  });

  // ---------- Account detail ----------
  // Reached from two places now (the LA map and My Accounts), so the back
  // link goes wherever the rep actually came from instead of the
  // hardwired screen-map it used to always return to.
  document.getElementById('back-account').addEventListener('click', function () {
    showScreen(state.accountReturn || 'screen-map');
  });

  function openAccountDetail(customer, returnScreen) {
    showScreen('screen-account');
    state.accountReturn = returnScreen || 'screen-map';
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
          return accountOrderRowHtml(o, customer, res.slackTeamDomain || '');
        }).join('');
      })
      .catch(function (err) {
        document.getElementById('account-order-list').innerHTML = '<div class="empty-note">' + escapeHtml(friendlyApiError(err)) + '</div>';
      });
  }

  // One past order, as a card with its own explicit actions rather than a
  // whole-row tap. The row now carries two destinations (the invoice and the
  // Slack thread), and a single tap target can't offer both -- guessing
  // which one a rep meant is exactly the ambiguity these buttons remove.
  function accountOrderRowHtml(o, customer, teamDomain) {
    var statusClass = String(o.status || 'pending').toLowerCase().replace(/\s+/g, '-');
    var lines = o.lines || [];
    var sub = lines.length === 1
      ? escapeHtml(lines[0].product || '') + ' · ' + escapeHtml(lines[0].packaging || '') + ' · Qty ' + lines[0].qty
      : lines.length + ' items · Qty ' + o.qty;
    if (o.lineTotal) sub += ' · ' + fmtMoney(o.lineTotal);

    var actions = [];
    if (o.invoiceNumber) {
      actions.push('<button type="button" class="order-action" data-invoice="' + escapeHtml(o.invoiceNumber) + '">' +
        'View invoice <span class="order-action-note">' + escapeHtml(o.invoiceNumber) + '</span></button>');
    }

    // Direct thread permalink when the order was placed after the Slack
    // reference started being stored on the row (see SLACK_CHANNEL_HEADER in
    // Code.gs). Everything older gets a Slack SEARCH link instead, labelled
    // differently on purpose -- it's a genuinely useful way to find the
    // conversation, but it is not the same promise as "this exact thread",
    // and pretending otherwise would be the more annoying failure.
    if (o.slackThreadUrl) {
      actions.push('<a class="order-action order-action--slack" target="_blank" rel="noopener" href="' + escapeHtml(o.slackThreadUrl) + '">' +
        '<span class="slack-mark" aria-hidden="true"></span>Slack thread</a>');
    } else if (teamDomain) {
      var query = [customer.establishmentName, o.invoiceNumber].filter(Boolean).join(' ');
      actions.push('<a class="order-action order-action--slack-search" target="_blank" rel="noopener" ' +
        'title="This order predates thread tracking — this searches Slack for it instead." ' +
        'href="https://' + escapeHtml(teamDomain) + '.slack.com/search/' + encodeURIComponent(query) + '">' +
        '<span class="slack-mark" aria-hidden="true"></span>Find in Slack</a>');
    }

    return '<div class="order-row order-row--stacked">' +
      '<div class="order-row-head">' +
        '<div><div class="oname">' + fmtDate(o.poDate) + '</div>' +
        '<div class="osub">' + sub + '</div></div>' +
        '<span class="pill ' + statusClass + '">' + escapeHtml(o.status || 'Pending') + '</span>' +
      '</div>' +
      (actions.length ? '<div class="order-actions">' + actions.join('') + '</div>' : '') +
      '</div>';
  }

  document.getElementById('account-order-list').addEventListener('click', function (e) {
    // Only the invoice button is handled here -- the Slack action is a real
    // <a href>, so letting the browser open it beats intercepting it.
    var btn = e.target.closest('.order-action[data-invoice]');
    if (!btn) return;
    openInvoice(btn.getAttribute('data-invoice'));
  });

  // ---------- Account edit ----------
  document.getElementById('btn-edit-account').addEventListener('click', function () {
    var c = state.currentAccount;
    if (!c) return;
    document.getElementById('ea-contact').value = c.orderingContact || '';
    document.getElementById('ea-phone').value = c.phone || '';
    document.getElementById('ea-email').value = c.email || '';
    document.getElementById('ea-address').value = c.address || '';
    document.getElementById('ea-billing-email').value = c.billingEmail || '';
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

    // Send billingEmail only when we can tell "the rep cleared it" apart from
    // "this client never had it". state.customers is cached in localStorage,
    // so a rep still holding a list fetched before billingEmail was returned
    // would render a blank field and, on any unrelated edit, write that blank
    // over a real Billing Contact Email. Omitting the key entirely makes
    // setCell in Code.gs skip the cell (its `value === undefined` guard).
    var billingEmailInput = document.getElementById('ea-billing-email').value.trim();
    if (billingEmailInput || Object.prototype.hasOwnProperty.call(c, 'billingEmail')) {
      updates.billingEmail = billingEmailInput;
    }

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
      // Separate from the ordering contact's email on purpose: invoices go
      // to accounts payable, orders go to whoever runs the bar. Optional,
      // because the billing-email resolution is billingEmail -> ordering
      // contact email -> none, and a missing one blocks the INVOICE, never
      // the order (prisma Account.billingContactEmail, lib/ops/checklist).
      // Requiring it here would reject accounts the pipeline handles fine.
      billingEmail: val('nc-billing-email'),
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
    var mapPoint = accountCoordinates(val('nc-address-city'), newCustomer.establishmentName);
    newCustomer.lat = mapPoint.lat;
    newCustomer.lng = mapPoint.lng;

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
      cacheCustomers(state.customers);
      updateMyMapButton();
      renderAccountMetric();
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
        celebrate('Order sent', 'Nice work — the team has it.');
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
    var stocked = (window.LM_MARKETING_CATEGORIES || []).filter(function (c) { return c.items.length; });
    document.getElementById('mk-catalog-hint').textContent =
      'Tap a category, then set quantities. ' + total + ' items across ' +
      stocked.length + ' categories.';

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
    var haystack = (item.name + ' ' + item.brand + ' ' + item.id + ' ' +
      cat.section + ' ' + cat.name + ' ' + (item.note || '')).toLowerCase();
    return haystack.indexOf(mk.query) !== -1;
  }

  // The full classification path, for the summary and the order row. Sections
  // whose only node is themselves (Packaging, Trade Support) would otherwise
  // read "Trade Support > Trade Support".
  function mkCategoryPath(cat) {
    return cat.section === cat.name ? cat.name : cat.section + ' › ' + cat.name;
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
    var lastSection = null;

    // Emitted once per top-level bucket, the first time one of its groups
    // survives the filter -- so "Point-of-Sales" can't head an empty run.
    function sectionHeadHtml(cat) {
      if (cat.section === lastSection) return '';
      lastSection = cat.section;
      return '<div class="mk-section">' + escapeHtml(cat.section) + '</div>';
    }

    var html = (window.LM_MARKETING_CATEGORIES || []).map(function (cat) {
      // Leaf-less branches used to render here as "Coming soon". They are no
      // longer in the catalog at all, so a category with no items is now just
      // a category whose every item was filtered out -- fall through and let
      // the `!items.length` check below drop it.
      var items = cat.items.filter(function (item) { return mkItemMatches(item, cat, mk); });
      if (!items.length) return '';
      anyShown = true;
      var head = sectionHeadHtml(cat);
      var qty = mkCategoryQty(cat);
      // A category holding a quantity stays open, so a rep scrolling an
      // 18-group tree can always see what they've already put in it without
      // re-tapping. (A search that excludes the category still hides it --
      // the filter runs above. Nothing is lost by that: the summary panel
      // below lists every picked line, and submit reads from state, not
      // from what happens to be on screen.)
      var open = forceOpen || !!mk.openCats[cat.id] || qty > 0;
      return head +
        '<div class="mk-cat' + (qty ? ' has-qty' : '') + '" data-cat="' + cat.id + '">' +
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
            category: mkCategoryPath(cat),
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
        celebrate('Request sent', 'Marketing has your request.');
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

  // ================= Prospecting: doors nobody has walked into yet =========
  //
  // The data (assets/js/prospects.js) is the CA ABC on-premise license export
  // for LA ZIP group 01 with the Cantinesca visit plan applied: 551 rows, 414
  // of them visitable, each carrying the route and stop number it was assigned
  // in the plan. `id` is column A of that sheet and is permanent -- a rep's
  // statuses are stored against it, so reclassifying an account in the sheet
  // must never renumber it or every rep's history would point at the wrong
  // door.
  //
  // Statuses are local to the device, by deliberate choice: a rep marking a
  // door standing on the sidewalk should never be waiting on a network, and
  // nothing here writes to Apps Script. The trade is that the office cannot
  // see this, which the screen says in plain words rather than leaving a rep
  // to assume otherwise.

  var PROSPECT_STATUSES = [
    { key: 'new',        label: 'Not visited', color: '#2f5fc0', blurb: 'Nobody has walked in yet.' },
    { key: 'visited',    label: 'Visited',     color: '#f2a33c', blurb: 'Walked in. No decision on the table yet.' },
    { key: 'interested', label: 'Interested',  color: '#d6187e', blurb: 'They want to talk. Follow up with product.' },
    { key: 'comeback',   label: 'Come back',   color: '#ed633f', blurb: 'Decision-maker was out. Try another day or hour.' },
    { key: 'signed',     label: 'Signed',      color: '#7a2fb5', blurb: 'It is an account. Add it and place the first order.' },
    { key: 'nofit',      label: 'Not a fit',   color: '#8b97a3', blurb: 'Closed out. Kept on the map so it is not re-walked.' }
  ];
  var PROSPECT_STATUS_BY_KEY = {};
  PROSPECT_STATUSES.forEach(function (s) { PROSPECT_STATUS_BY_KEY[s.key] = s; });

  // The tracks that sit outside the routes and their tails. They were chips;
  // they are now the last group in the region dropdown, because they answer
  // the same question a route does -- which part of the map am I working --
  // and a rep should not have to read two rows of chips to find that out.
  var PROSPECT_OUTSIDE_TRACKS = [
    { value: 'wave:arts',   label: 'Arts District (separate track)' },
    { value: 'wave:chains', label: 'Chains to decide' },
    { value: 'wave:tierc',  label: 'Tier C (evidence-gated)' },
    { value: 'wave:all',    label: 'Everything, including excluded' }
  ];

  // The chain doors flagged in the sheet for a team determination: SEGMENT
  // says Chain (HQ decision), but the license sits with a local operator or
  // franchisee rather than the brand's corporate parent -- the tell is a
  // different license holder per door in column C -- so the beer decision may
  // be local after all. Each one is either worked as Local multi-unit
  // (owner-level) with a single owner meeting, or the exclusion is confirmed.
  //
  // Held as an explicit id list rather than read off the sheet's orange row
  // fill, because the fill and the plan's prose disagree: the fill marks nine
  // rows, the prose names these ten (415 Acapulco is filled yellow, not
  // orange) and says "eleven". The likely eleventh is 424 Bob's Big Boy --
  // filled yellow while ACTIVE, so it is not a "license not active" row
  // either, and a franchised brand with a local license holder fits this
  // pattern exactly. It is deliberately NOT in this list: nobody has said so.
  // Add 424 here if the team confirms it.
  var PROSPECT_CHAIN_REVIEW_IDS = [415, 442, 443, 448, 449, 450, 451, 455, 456, 460];
  var PROSPECT_CHAIN_REVIEW = {};
  PROSPECT_CHAIN_REVIEW_IDS.forEach(function (id) { PROSPECT_CHAIN_REVIEW[id] = true; });

  // Column J: concept fit for Cantinesca, inferred from the name. The wording
  // is the plan's own, because a rep tapping a tier chip is asking exactly
  // what the plan means by it -- and the last line matters most: this is a
  // prior, not a verdict. The rep standing at the door overrides it.
  var PROSPECT_TIERS = [
    {
      key: 'A',
      label: 'Tier A',
      swatch: '#8a5a06',
      chip: '#ffe9c2',
      what: 'Mexican or Central American concept: cantina, sports bar, nightclub, mariscos, birrieria, taqueria, pupuseria.',
      how: 'The Cantinesca fit. These are the doors the routes were built around \u2014 work them first.'
    },
    {
      key: 'B',
      label: 'Tier B',
      swatch: '#2f4d8c',
      chip: '#e2eaf7',
      what: 'Other independent with a beer-forward occasion: pizza, wings, crab boil, bowling, craft beer bar, diner with bar, steakhouse.',
      how: 'On a sweep, visit only if it sits on the same block as the A doors. No detours for it.'
    },
    {
      key: 'C',
      label: 'Tier C',
      swatch: '#66727d',
      chip: '#eceef0',
      what: 'Low fit on a first pass: sushi, Thai, Chinese, Indian, cafe, unknown.',
      how: 'Not a list to work. These come in only if tier B converts in the first push at a rate that pays for a cold visit; otherwise they belong to the distributor\u2019s general reps.'
    }
  ];
  var PROSPECT_TIER_PRIOR = 'A prior, not a verdict \u2014 what you find at the door beats what the name suggested.';

  var PROSPECT_DOORS_PER_DAY = 12;

  // Step 3: the split is by territory, not by rows. Each rep owns a
  // contiguous block of routes and works them in priority order, and each
  // second-pass group goes to whoever ran the route it extends -- so a tail
  // is the same streets, worked by the same person, after the parent route.
  //
  // Keyed on the rep's LAST NAME, the way LA_TERRITORY_REPS above already
  // keys them, so whatever exact form the Apps Script login returns
  // ("James Williams", "J. Williams") still resolves. The two names and
  // colours come from that same map, so a rep is one colour everywhere in
  // this app.
  //
  // WHICH REP TAKES WHICH HALF IS AN ASSUMPTION, not something the plan
  // states: the plan defines the two territories and names the two reps, and
  // leaves the pairing to the team. Swap the two `rep` values below to swap
  // territories; nothing else needs to change.
  var PROSPECT_TERRITORIES = [
    {
      key: 'ne',
      rep: 'williams',
      label: 'North & East',
      routes: [
        'R3B East Los Angeles + Commerce',
        'R5 Downey core',
        'R3A Boyle Heights',
        'R6 Montebello + Pico Rivera Whittier'
      ],
      groups: ['S1', 'S2', 'S4'] // Downey outer, Pico Rivera, Commerce
    },
    {
      key: 'ws',
      rep: 'villanueva',
      label: 'West & South',
      routes: [
        'R1 Huntington Park',
        'R2A Maywood + Bell',
        'R4A South Gate',
        'R2B Bell Gardens + Cudahy',
        'R4B Lynwood + South Gate south'
      ],
      groups: ['S3'] // South LA
    }
  ];

  // The plan's three-rep split, held here so that adding the third person is
  // an edit rather than a rebuild: North (R3B, R3A, R6 + S2, S4), Centre
  // (R1, R2A, R2B + S3), South & East (R4A, R4B, R5 + S1). Counted against
  // the data it comes to 89, 78 and 94 first-push doors -- the plan's "78 to
  // 94 each". Deliberately not wired up: only two reps have been named.
  //
  // var PROSPECT_TERRITORIES_THREE = [
  //   { key: 'n',  rep: '?', label: 'North',        routes: ['R3B East Los Angeles + Commerce', 'R3A Boyle Heights', 'R6 Montebello + Pico Rivera Whittier'], groups: ['S2', 'S4'] },
  //   { key: 'c',  rep: '?', label: 'Centre',       routes: ['R1 Huntington Park', 'R2A Maywood + Bell', 'R2B Bell Gardens + Cudahy'], groups: ['S3'] },
  //   { key: 'se', rep: '?', label: 'South & East', routes: ['R4A South Gate', 'R4B Lynwood + South Gate south', 'R5 Downey core'], groups: ['S1'] }
  // ];

  /** The territory a door falls in, or null for the tracks that stay outside
   *  the split. Route and group only: the Arts District track has neither and
   *  is one buyer's job, and tier C and the exclusions are not dispatched to
   *  anyone yet.
   *
   *  A multi-unit door DOES belong to a territory -- step 6 keeps its stop
   *  number "so reps know where they fall" even though the owner meeting
   *  comes first. It is the owner meeting that sits outside the split, not
   *  the door. */
  function prospectTerritory(p) {
    for (var i = 0; i < PROSPECT_TERRITORIES.length; i++) {
      var t = PROSPECT_TERRITORIES[i];
      if (p.route && t.routes.indexOf(p.route) !== -1) return t;
      if (p.group && t.groups.some(function (g) { return p.group.indexOf(g) === 0; })) return t;
    }
    return null;
  }

  function prospectTerritoryRep(t) {
    return t ? (LA_TERRITORY_REPS[t.rep] || UNKNOWN_TERRITORY_REP) : UNKNOWN_TERRITORY_REP;
  }

  /** Which day of that route or group a stop falls on, cut along the sweep. */
  function prospectDay(p) {
    return p.stop ? Math.ceil(p.stop / PROSPECT_DOORS_PER_DAY) : null;
  }

  var PROSPECT_PAGE = 40; // rows rendered before "show more" -- 414 <li> at once is a scroll no thumb wants

  var prospectState = {
    rep: 'mine',    // 'mine' | a territory key | 'all'
    // One control for both questions the wave chips and the route dropdown
    // used to ask separately. '' is the whole plan; 'route:'/'group:' narrow
    // to one piece of it; 'wave:' selects a track that sits outside the
    // routes entirely.
    region: '',
    tier: 'all',
    status: 'all',
    sort: 'plan',
    q: '',
    limit: PROSPECT_PAGE,
    here: null,       // {lat,lng} once the rep allows geolocation, for sort:'near'
    marks: {},        // id -> { status, note, at }
    map: null,
    markers: {},      // id -> L.Marker, so a status change repaints one pin not 414
    current: null     // the prospect open on screen-prospect
  };

  /** One store per rep on a shared phone; the key survives logout on purpose,
   *  so a rep who signs back in still has the doors they marked this morning. */
  function prospectStoreKey() {
    return 'lm_prospect_marks_' + (state.rep || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  }

  function loadProspectMarks() {
    try {
      var raw = localStorage.getItem(prospectStoreKey());
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function saveProspectMarks() {
    try { localStorage.setItem(prospectStoreKey(), JSON.stringify(prospectState.marks)); }
    catch (e) { toast('Could not save on this device', true); }
  }

  function prospectMark(id) { return prospectState.marks[id] || null; }
  function prospectStatusKey(p) {
    var m = prospectMark(p.id);
    return (m && m.status) || 'new';
  }
  function prospectStatus(p) { return PROSPECT_STATUS_BY_KEY[prospectStatusKey(p)] || PROSPECT_STATUSES[0]; }

  function allProspects() { return window.LM_PROSPECTS || []; }
  function prospectSweep(p) {
    var list = window.LM_PROSPECT_SWEEPS || [];
    return p.sweep === null || p.sweep === undefined ? '' : (list[p.sweep] || '');
  }
  /** The line under a name: what the plan calls this door. */
  function prospectPlanLine(p) {
    var day = prospectDay(p);
    var suffix = day ? ' · day ' + day : '';
    if (p.route) return p.route + ' · stop ' + p.stop + suffix;
    if (p.group) return p.group.split(' (')[0] + ' · stop ' + p.stop + suffix;
    if (p.wave.indexOf('Separate track') === 0) return 'Arts District · stop ' + p.stop;
    if (p.wave.indexOf('Excluded') === 0) return p.wave.replace('Excluded: ', 'Excluded — ');
    return p.wave;
  }
  function prospectTitle(p) { return p.name || p.owner || ('License #' + p.id); }

  function haversineMiles(a, b) {
    var R = 3958.8, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /** Routes and second-pass groups, in the plan's own working order, for the
   *  Route dropdown. Built from the data so adding a route to the sheet needs
   *  no change here. */
  function prospectRouteOptions() {
    var routes = [], seenR = {}, groups = [], seenG = {};
    allProspects().forEach(function (p) {
      if (p.route && !seenR[p.route]) { seenR[p.route] = true; routes.push({ value: 'route:' + p.route, label: p.route, order: p.routePriority || 99 }); }
      if (p.group && !seenG[p.group]) { seenG[p.group] = true; groups.push({ value: 'group:' + p.group, label: p.group.split(' (')[0] }); }
    });
    routes.sort(function (a, b) { return a.order - b.order; });
    groups.sort(function (a, b) { return a.label.localeCompare(b.label); });
    return routes.concat(groups);
  }

  /** The one filter that used to be two. '' means the whole plan minus the
   *  exclusions -- the doors there are actually to work. */
  function prospectMatchesRegion(p) {
    var sel = prospectState.region;
    if (!sel) return p.wave.indexOf('Excluded') !== 0;
    if (sel.indexOf('route:') === 0) return p.route === sel.slice(6);
    if (sel.indexOf('group:') === 0) return p.group === sel.slice(6);
    if (sel === 'wave:arts') return p.wave.indexOf('Separate track') === 0;
    if (sel === 'wave:tierc') return p.wave.indexOf('Second pass: low concept fit') === 0;
    if (sel === 'wave:chains') return !!PROSPECT_CHAIN_REVIEW[p.id];
    if (sel === 'wave:all') return true;
    return true;
  }


  /** The hub view versus the field view. An admin is looking at the whole
   *  board and needs to compare the two halves; James and Ricardo are looking
   *  at their own streets on their own phone, where another rep's doors are
   *  not context, they are noise. So the rep chips exist for one and not the
   *  other, and a rep's screen is locked to his own territory. */
  function prospectIsAdmin() {
    return (state.repRole || '') === 'Admin';
  }

  /** The logged-in rep's own territory, if they have one. A rep who is not in
   *  the split (Steve guiding, or anyone else signing in) has none, and the
   *  "Mine" chip then shows everything rather than an empty screen. */
  function myTerritory() {
    var last = repLastName(state.rep);
    return PROSPECT_TERRITORIES.filter(function (t) { return t.rep === last; })[0] || null;
  }

  function prospectMatchesRep(p) {
    var sel = prospectState.rep;
    if (sel === 'all') return true;
    var t = prospectTerritory(p);
    if (sel === 'outside') return !t;
    if (sel === 'mine') {
      var mine = myTerritory();
      return mine ? t === mine : true;
    }
    return t && t.key === sel;
  }

  function filteredProspects() {
    var q = prospectState.q.trim().toLowerCase();
    var list = allProspects().filter(function (p) {
      if (!prospectMatchesRegion(p)) return false;
      if (!prospectMatchesRep(p)) return false;
      if (prospectState.tier !== 'all' && p.tier !== prospectState.tier) return false;
      if (prospectState.status !== 'all' && prospectStatusKey(p) !== prospectState.status) return false;
      if (!q) return true;
      return (p.name + ' ' + p.owner + ' ' + p.address + ' ' + p.city + ' ' + p.zip).toLowerCase().indexOf(q) !== -1;
    });

    var here = prospectState.here;
    if (prospectState.sort === 'near' && here) {
      list.forEach(function (p) { p._miles = haversineMiles(here, p); });
      list.sort(function (a, b) { return a._miles - b._miles; });
    } else if (prospectState.sort === 'name') {
      list.sort(function (a, b) { return prospectTitle(a).localeCompare(prospectTitle(b)); });
    } else {
      // Plan order: column A already encodes it (route by route, stop by
      // stop, then the second-pass groups, then everything excluded), which
      // is exactly what "give it to them in an order that makes sense" means
      // on this sheet. Sorting by id reproduces the printed plan.
      list.sort(function (a, b) { return a.id - b.id; });

      // ...and then, if asked, walked in the shortest order within each day.
      // The sheet's stop order is a one-way sweep by house number, set before
      // anyone had coordinates for these addresses; now that every door is
      // geocoded, the same doors can be put in the order that actually walks
      // shortest. Days stay as the plan cut them.
      if (prospectState.sort === 'walk' && /^(route|group):/.test(prospectState.region)) {
        var walked = [];
        prospectGroupByDay(list).forEach(function (d) {
          // Nearest-neighbour is a heuristic: it is usually better than the
          // house-number sweep and occasionally worse. Measure both and keep
          // the shorter one, so turning this on can never lengthen a day.
          var optimised = prospectOptimiseDay(d.doors, prospectState.here);
          walked = walked.concat(
            prospectPathMiles(optimised) < prospectPathMiles(d.doors) ? optimised : d.doors
          );
        });
        list = walked;
      }
    }
    return list;
  }

  // ---- a day's driving ----------------------------------------------------
  //
  // Google's Maps URL API takes at most nine intermediate waypoints. Leaving
  // `origin` out entirely makes Maps start from wherever the rep actually is,
  // which is what he wants and also buys a slot back: nine waypoints plus a
  // destination is ten doors per link. A twelve-door day therefore needs two
  // links, and they are split evenly (6 and 6) rather than 10 and 2 -- an
  // orphan link with one stop on it reads like a bug.
  var PROSPECT_MAPS_MAX_STOPS = 10;

  function prospectMapsChunks(doors) {
    if (doors.length <= PROSPECT_MAPS_MAX_STOPS) return [doors];
    var parts = Math.ceil(doors.length / PROSPECT_MAPS_MAX_STOPS);
    var size = Math.ceil(doors.length / parts);
    var chunks = [];
    for (var i = 0; i < doors.length; i += size) chunks.push(doors.slice(i, i + size));
    return chunks;
  }

  function prospectMapsUrl(doors) {
    var pt = function (p) { return p.lat + ',' + p.lng; };
    var destination = doors[doors.length - 1];
    var waypoints = doors.slice(0, -1).map(pt).join('|');
    return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
      encodeURIComponent(pt(destination)) +
      (waypoints ? '&waypoints=' + encodeURIComponent(waypoints) : '');
  }

  /** Straight-line length of a run of doors, in miles. Not driving distance --
   *  it is a comparison between two orders of the same stops, and for that
   *  the crow's flight is honest enough. */
  function prospectPathMiles(doors) {
    var total = 0;
    for (var i = 1; i < doors.length; i++) total += haversineMiles(doors[i - 1], doors[i]);
    return total;
  }

  /** Nearest-neighbour over one day's doors. It never crosses a day boundary,
   *  so the corridor logic the plan built survives: this reorders the walk
   *  inside a day-sized piece of one sweep, it does not re-cut the sweep.
   *
   *  Starts from the rep's own position when he has shared it -- the first
   *  stop of the day should be the one nearest him, not whichever door the
   *  house numbers happened to put first -- and otherwise from the day's
   *  first stop in plan order. */
  function prospectOptimiseDay(doors, from) {
    if (doors.length < 3) return doors.slice();
    var remaining = doors.slice();
    var route = [];
    var cursor = from;
    if (!cursor) { cursor = remaining.shift(); route.push(cursor); }
    while (remaining.length) {
      var best = 0;
      for (var i = 1; i < remaining.length; i++) {
        if (haversineMiles(cursor, remaining[i]) < haversineMiles(cursor, remaining[best])) best = i;
      }
      cursor = remaining.splice(best, 1)[0];
      route.push(cursor);
    }
    return route;
  }

  /** The doors, grouped into the day-sized pieces the dividers describe. */
  function prospectGroupByDay(list) {
    var days = [], byDay = {};
    list.forEach(function (p) {
      var day = prospectDay(p) || 1;
      if (!byDay[day]) { byDay[day] = { day: day, doors: [] }; days.push(byDay[day]); }
      byDay[day].doors.push(p);
    });
    days.sort(function (a, b) { return a.day - b.day; });
    return days;
  }

  /** Is the list currently arranged as days of one route? Both the dividers
   *  and the optimiser need the same answer. */
  function prospectShowsDays() {
    return /^(route|group):/.test(prospectState.region) &&
      (prospectState.sort === 'plan' || prospectState.sort === 'walk');
  }

  // ---- pins ---------------------------------------------------------------
  function prospectPin(p) {
    var s = prospectStatus(p);
    var touched = prospectStatusKey(p) !== 'new';
    return L.divIcon({
      className: '',
      html: '<div class="lm-pin' + (touched ? ' lm-pin--touched' : '') + '" style="background:' + s.color + ';"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 24],
      popupAnchor: [0, -24]
    });
  }

  function prospectPopupHtml(p) {
    var s = prospectStatus(p);
    return '<div class="prospect-popup"><strong>' + escapeHtml(prospectTitle(p)) + '</strong>' +
      escapeHtml(p.address) +
      '<span class="pp-status" style="color:' + s.color + ';">' +
      '<i class="prospect-dot" style="background:' + s.color + ';"></i>' + escapeHtml(s.label) + '</span>' +
      '<br/><a href="#" class="popup-open-prospect" data-prospect-id="' + p.id + '">Open this door →</a></div>';
  }

  // ---- territories, drawn -------------------------------------------------
  // A rep asked where his half of the map is; the honest answer is a shape,
  // not a word in a chip. Each territory is the convex hull of the doors
  // assigned to it -- computed here rather than stored, so it follows the
  // split: reassign a route in PROSPECT_TERRITORIES and the outline moves
  // with it.
  //
  // The two hulls overlap a little, and that is the truth of the geography
  // rather than a defect: Bell Gardens and Cudahy (West & South) sit between
  // Downey and East LA (North & East). They are drawn with a light fill and a
  // dashed edge so the overlap reads as two claims on the same ground rather
  // than a solid block hiding the pins underneath.
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var cross = function (o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    var lower = [];
    pts.forEach(function (pt) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
      lower.push(pt);
    });
    var upper = [];
    pts.slice().reverse().forEach(function (pt) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
      upper.push(pt);
    });
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  var PROSPECT_TERRITORY_PANE = 'lmTerritories';
  var prospectTerritoryShapes = [];

  function renderTerritoryShapes() {
    prospectTerritoryShapes.forEach(function (layer) { prospectState.map.removeLayer(layer); });
    prospectTerritoryShapes = [];
    if (!prospectState.map) return;

    // Drawn for the territories in view, and only when the map is showing
    // doors that belong to one: a tier C or Arts District view has no
    // territory to outline.
    if (prospectState.region.indexOf('wave:') === 0) return;

    prospectVisibleTerritories().forEach(function (t) {
      var pts = allProspects()
        .filter(function (p) { return prospectTerritory(p) === t; })
        .map(function (p) { return [p.lat, p.lng]; });
      var hullPts = convexHull(pts);
      if (hullPts.length < 3) return;

      var color = prospectTerritoryRep(t).color;
      // Drawn into a pane of its own rather than added and then sent to the
      // back. bringToBack() reaches for the path's parentNode, which does not
      // exist until the map has a view -- and on this screen the shapes are
      // drawn before the first fitBounds, so it threw, aborted the render and
      // left the map blank with no pins and no tiles. A pane fixes the
      // stacking order declaratively and cannot fail this way.
      var shape = L.polygon(hullPts, {
        pane: PROSPECT_TERRITORY_PANE,
        color: color,
        weight: 2,
        opacity: 0.85,
        dashArray: '7 6',
        fillColor: color,
        fillOpacity: 0.08,
        interactive: false
      }).addTo(prospectState.map);
      prospectTerritoryShapes.push(shape);

      // The name sits at the top of the shape rather than its centre, where
      // it would land on top of the densest cluster of pins.
      var lats = hullPts.map(function (q) { return q[0]; });
      var lngs = hullPts.map(function (q) { return q[1]; });
      var label = L.marker([Math.max.apply(null, lats), (Math.min.apply(null, lngs) + Math.max.apply(null, lngs)) / 2], {
        pane: PROSPECT_TERRITORY_PANE,
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: '<span class="territory-tag" style="background:' + color + ';">' +
            escapeHtml(prospectTerritoryRep(t).name + ' \u00b7 ' + t.label) + '</span>',
          iconSize: [0, 0]
        })
      }).addTo(prospectState.map);
      prospectTerritoryShapes.push(label);
    });
  }

  function renderProspectMap(list) {
    if (!window.L) return;
    if (!prospectState.map) {
      prospectState.map = L.map('prospects-map');
      // Above the tiles (200), below the pins (600), so a territory is ground
      // the doors sit on rather than a sheet over the top of them.
      prospectState.map.createPane(PROSPECT_TERRITORY_PANE).style.zIndex = 350;
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
        attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors'
      }).addTo(prospectState.map);
      prospectState.map.on('popupopen', function (e) {
        var link = e.popup._contentNode.querySelector('.popup-open-prospect');
        if (!link) return;
        link.addEventListener('click', function (evt) {
          evt.preventDefault();
          openProspect(parseInt(link.getAttribute('data-prospect-id'), 10));
        });
      });
    }

    Object.keys(prospectState.markers).forEach(function (id) {
      prospectState.map.removeLayer(prospectState.markers[id]);
    });
    prospectState.markers = {};

    // The view comes first. A Leaflet map with no view has no zoom to project
    // against, so every layer added before this point stays invisible even
    // once the view arrives -- which is what a "broken" blank map here has
    // always turned out to be.
    if (list.length) {
      prospectState.map.fitBounds(L.latLngBounds(list.map(function (p) { return [p.lat, p.lng]; })), { padding: [26, 26], maxZoom: 15 });
    } else if (!prospectState.map._loaded) {
      prospectState.map.setView([33.97, -118.19], 11);
    }

    list.forEach(function (p) {
      var marker = L.marker([p.lat, p.lng], { icon: prospectPin(p) }).addTo(prospectState.map);
      marker.bindPopup(prospectPopupHtml(p));
      prospectState.markers[p.id] = marker;
    });

    renderTerritoryShapes();
    prospectState.map.invalidateSize();
  }

  /** One pin, repainted in place. Re-running renderProspectMap after every tap
   *  would also refit the bounds and throw away the rep's pan and zoom. */
  function refreshProspectPin(p) {
    var marker = prospectState.markers[p.id];
    if (!marker) return;
    marker.setIcon(prospectPin(p));
    marker.setPopupContent(prospectPopupHtml(p));
  }

  // ---- the screen ---------------------------------------------------------
  function renderProspectProgress(list) {
    // The bar is the rep's own ground, not the whole county: on James's phone
    // "worked" has to mean worked out of his 174, or the number is somebody
    // else's progress.
    var scope = allProspects().filter(function (p) {
      return p.wave.indexOf('Excluded') !== 0 && prospectMatchesRep(p);
    });
    var counts = {};
    PROSPECT_STATUSES.forEach(function (st) { counts[st.key] = 0; });
    scope.forEach(function (p) { counts[prospectStatusKey(p)]++; });
    var walked = scope.length - counts['new'];

    var bar = PROSPECT_STATUSES.map(function (st) {
      var pct = scope.length ? (counts[st.key] / scope.length) * 100 : 0;
      return pct > 0 ? '<i style="width:' + pct.toFixed(2) + '%; background:' + st.color + ';" title="' +
        escapeHtml(st.label + ': ' + counts[st.key]) + '"></i>' : '';
    }).join('');

    var whose = prospectScopeLabel();
    var orphan = !prospectIsAdmin() && !myTerritory()
      ? '<div class="prospect-orphan-note">No prospecting territory is assigned to you yet, so this is the whole Los Angeles list. Ask the office which routes are yours.</div>'
      : '';
    var line = '<div class="pp-line">' + (whose ? '<b>' + escapeHtml(whose) + '</b> \u00b7 ' : '') +
      '<b>' + walked + '</b> of <b>' + scope.length + '</b> doors worked \u00b7 ' +
      '<b>' + counts.interested + '</b> interested \u00b7 <b>' + counts.signed + '</b> signed</div>';

    // The colour breakdown: every status with its count, so the bar can be
    // read rather than guessed at. It doubles as the map's legend, which is
    // why the old standalone legend row is gone.
    var breakdown = '<div class="prospect-legend">' + PROSPECT_STATUSES.map(function (st) {
      return '<span><i class="prospect-dot" style="background:' + st.color + ';"></i>' +
        escapeHtml(st.label) + ' <b>' + counts[st.key] + '</b></span>';
    }).join('') + '</div>';

    // An admin also gets both halves side by side, which is the comparison
    // the hub view exists for.
    var perRep = '';
    if (prospectIsAdmin()) {
      perRep = '<div class="prospect-legend">' + PROSPECT_TERRITORIES.map(function (t) {
        var rep = prospectTerritoryRep(t);
        var doors = allProspects().filter(function (p) { return prospectTerritory(p) === t; });
        var done = doors.filter(function (p) { return prospectStatusKey(p) !== 'new'; }).length;
        return '<span><i class="prospect-dot" style="background:' + rep.color + ';"></i>' +
          escapeHtml(rep.name + ' \u00b7 ' + t.label) + ' <b>' + done + '/' + doors.length + '</b></span>';
      }).join('') + '</div>';
    }

    document.getElementById('prospect-progress').innerHTML =
      line + '<div class="pp-bar">' + bar + '</div>' + breakdown + perRep + orphan;
  }

  /** Whose doors this screen is currently showing, in words. */
  function prospectScopeLabel() {
    if (prospectState.rep === 'all') return 'Everyone';
    var t = prospectState.rep === 'mine' ? myTerritory()
      : PROSPECT_TERRITORIES.filter(function (x) { return x.key === prospectState.rep; })[0];
    if (!t) return prospectIsAdmin() ? 'Everyone' : '';
    return prospectTerritoryRep(t).name + ' \u00b7 ' + t.label;
  }

  function renderProspectFilters() {
    var row = document.getElementById('prospect-rep-filter');

    if (prospectIsAdmin()) {
      // The hub: one chip per rep, plus both together. No "Mine" -- an admin
      // has no territory of his own, and a chip that silently meant
      // "everyone" would be a lie on his screen.
      var repChips = PROSPECT_TERRITORIES.map(function (t) {
        return { key: t.key, label: prospectTerritoryRep(t).name, color: prospectTerritoryRep(t).color };
      }).concat([{ key: 'all', label: 'Everyone' }]);

      row.innerHTML = repChips.map(function (c) {
        var on = prospectState.rep === c.key;
        var style = on && c.color ? ' style="background:' + c.color + '; border-color:' + c.color + '; color:#102f44;"' : '';
        return '<button type="button" class="chip' + (on ? ' selected' : '') + '" data-rep="' + c.key + '"' + style + '>' +
          escapeHtml(c.label) + '</button>';
      }).join('');
    } else {
      // The field: no chips at all. The screen is his own territory, and the
      // only question left is which region of it.
      row.innerHTML = '';
      prospectState.rep = 'mine';
    }

    renderProspectRegionSelect();
    renderProspectTierChips();

    var statusSelect = document.getElementById('prospect-status');
    if (!statusSelect.options.length) {
      statusSelect.innerHTML = '<option value="all">Any status</option>' + PROSPECT_STATUSES.map(function (st) {
        return '<option value="' + st.key + '">' + escapeHtml(st.label) + '</option>';
      }).join('');
    }
    statusSelect.value = prospectState.status;
    document.getElementById('prospect-sort').value = prospectState.sort;
  }

  /** Tier chips, counted against what the rep is actually looking at: the
   *  plan's 324/156/71 are county-wide totals and would be somebody else's
   *  numbers on James's phone. */
  function renderProspectTierChips() {
    var scope = allProspects().filter(function (p) {
      return prospectMatchesRegion(p) && prospectMatchesRep(p);
    });
    var counts = { A: 0, B: 0, C: 0 };
    scope.forEach(function (p) { if (counts[p.tier] !== undefined) counts[p.tier]++; });

    var chips = [{ key: 'all', label: 'All tiers', count: scope.length }].concat(
      PROSPECT_TIERS.map(function (t) {
        return { key: t.key, label: t.label, count: counts[t.key], chip: t.chip, swatch: t.swatch };
      })
    );

    document.getElementById('prospect-tier-filter').innerHTML = chips.map(function (c) {
      var on = prospectState.tier === c.key;
      var style = on && c.chip ? ' style="background:' + c.chip + '; border-color:' + c.swatch + '; color:' + c.swatch + ';"' : '';
      return '<button type="button" class="chip' + (on ? ' selected' : '') + '" data-tier="' + c.key + '"' + style + '>' +
        escapeHtml(c.label) + ' <b>' + c.count + '</b></button>';
    }).join('');

    // What the tier means, shown only once a rep has asked for one. Showing
    // all three definitions at once would be the wall of text this screen
    // just got rid of.
    var note = document.getElementById('prospect-tier-note');
    var tier = PROSPECT_TIERS.filter(function (t) { return t.key === prospectState.tier; })[0];
    note.innerHTML = tier
      ? '<strong>' + escapeHtml(tier.label) + '</strong>' + escapeHtml(tier.what) +
        '<span class="tier-how">' + escapeHtml(tier.how) + '</span>' +
        '<span class="tier-prior">' + escapeHtml(PROSPECT_TIER_PRIOR) + '</span>'
      : '';
  }

  /** The region list is rebuilt whenever the rep changes, because a rep's
   *  regions are the only ones worth offering him -- showing James the option
   *  to filter to R1 would be offering him a route he does not work. */
  function renderProspectRegionSelect() {
    var select = document.getElementById('prospect-region');
    var territories = prospectVisibleTerritories();

    var routes = [], groups = [];
    territories.forEach(function (t) {
      t.routes.forEach(function (r) { routes.push({ value: 'route:' + r, label: r, order: prospectRoutePriority(r) }); });
      t.groups.forEach(function (g) {
        var full = prospectGroupName(g);
        if (full) groups.push({ value: 'group:' + full, label: full.split(' (')[0] });
      });
    });
    routes.sort(function (a, b) { return a.order - b.order; });
    groups.sort(function (a, b) { return a.label.localeCompare(b.label); });

    function opts(list) {
      return list.map(function (o) {
        return '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>';
      }).join('');
    }

    var html = '<option value="">' + (prospectIsAdmin() ? 'All regions' : 'All my regions') + '</option>';
    if (routes.length) html += '<optgroup label="Routes">' + opts(routes) + '</optgroup>';
    if (groups.length) html += '<optgroup label="Second pass (the route\u2019s tail)">' + opts(groups) + '</optgroup>';
    html += '<optgroup label="Outside the split">' + opts(PROSPECT_OUTSIDE_TRACKS) + '</optgroup>';

    if (select.getAttribute('data-built-for') !== prospectState.rep) {
      select.innerHTML = html;
      select.setAttribute('data-built-for', prospectState.rep);
      // A region that belonged to the rep we just switched away from is no
      // longer in the list, so the select would silently fall back to its
      // first option while prospectState still held the old value.
      if (!select.querySelector('option[value="' + prospectState.region.replace(/"/g, '\\"') + '"]')) {
        prospectState.region = '';
      }
    }
    select.value = prospectState.region;
  }

  /** Which territories the current rep chip is looking at. */
  function prospectVisibleTerritories() {
    if (prospectState.rep === 'all') return PROSPECT_TERRITORIES;
    if (prospectState.rep === 'mine') {
      var mine = myTerritory();
      return mine ? [mine] : PROSPECT_TERRITORIES;
    }
    return PROSPECT_TERRITORIES.filter(function (t) { return t.key === prospectState.rep; });
  }

  function prospectRoutePriority(route) {
    var hit = allProspects().filter(function (p) { return p.route === route; })[0];
    return hit && hit.routePriority ? hit.routePriority : 99;
  }

  /** S1 -> the group's full sheet name, which is what the data carries. */
  function prospectGroupName(prefix) {
    var hit = allProspects().filter(function (p) { return p.group.indexOf(prefix) === 0; })[0];
    return hit ? hit.group : '';
  }

  /** The corridor sweep (column O) for whatever route is in view. It is the
   *  instruction the rep walks, and it only means anything when one route is
   *  selected -- with all nine on screen there is no single sweep to show. */
  function renderProspectSweep(list) {
    var el = document.getElementById('prospect-sweep');
    var sweeps = {};
    list.forEach(function (p) { var s = prospectSweep(p); if (s) sweeps[s] = true; });
    var keys = Object.keys(sweeps);
    el.innerHTML = keys.length === 1
      ? '<strong>The sweep</strong>' + escapeHtml(keys[0])
      : '';
  }

  function renderProspectList(list) {
    var shown = list.slice(0, prospectState.limit);
    document.getElementById('prospect-count-title').textContent =
      list.length + (list.length === 1 ? ' door' : ' doors');

    // Day dividers carry the day's driving: how far it is, and the link that
    // opens it in Maps as one multi-stop trip rather than twelve separate
    // address lookups.
    var cutIntoDays = prospectShowsDays();
    var dayInfo = {};
    if (cutIntoDays) {
      // Built from the whole filtered list, not the page of it on screen, so
      // "Day 2" means the whole of day 2 even when the list is still showing
      // the first forty rows.
      prospectGroupByDay(list).forEach(function (d) {
        var chunks = prospectMapsChunks(d.doors);
        dayInfo[d.day] = {
          doors: d.doors.length,
          miles: prospectPathMiles(d.doors),
          planMiles: prospectPathMiles(d.doors.slice().sort(function (a, b) { return a.id - b.id; })),
          links: chunks.map(function (chunk, i) {
            return {
              url: prospectMapsUrl(chunk),
              label: chunks.length === 1 ? 'Directions' : 'Directions ' + (i + 1) + '/' + chunks.length
            };
          })
        };
      });
    }
    var lastDay = null;

    document.getElementById('prospect-list').innerHTML = shown.map(function (p) {
      var s = prospectStatus(p);
      var divider = '';
      if (cutIntoDays) {
        var day = prospectDay(p);
        if (day && day !== lastDay) {
          lastDay = day;
          var info = dayInfo[day] || { doors: 0, miles: 0, planMiles: 0, links: [] };
          // Only worth saying when the optimiser actually saved something.
          var saved = prospectState.sort === 'walk' && info.planMiles - info.miles > 0.15
            ? ' \u00b7 <b>' + (info.planMiles - info.miles).toFixed(1) + ' mi shorter</b>'
            : '';
          divider =
            '<div class="prospect-day-divider">' +
              '<span class="day-name">Day ' + day + ' \u00b7 ' + info.doors +
                (info.doors === 1 ? ' door \u00b7 ' : ' doors \u00b7 ') +
                info.miles.toFixed(1) + ' mi' + saved + '</span>' +
              '<span class="day-links">' + info.links.map(function (l) {
                return '<a href="' + l.url + '" target="_blank" rel="noopener">' + escapeHtml(l.label) + '</a>';
              }).join('') + '</span>' +
            '</div>';
        }
      }
      // How far this door is from the rep, but only in the mode where that is
      // the thing being sorted on.
      var miles = prospectState.sort === 'near' && p._miles !== undefined
        ? ' · ' + p._miles.toFixed(1) + ' mi' : '';
      return divider + '<div class="order-row clickable prospect-row" data-prospect-id="' + p.id + '">' +
        '<span class="prospect-stop">' + (p.stop || '—') + '</span>' +
        '<span class="prospect-body">' +
          '<span class="oname"><i class="prospect-dot" style="background:' + s.color + ';"></i>' +
            escapeHtml(prospectTitle(p)) + '</span>' +
          '<span class="osub">' + escapeHtml(p.address.split(',')[0]) + ' · ' +
            escapeHtml(titleCase(p.city)) + miles + '</span>' +
          '<span class="prospect-tags">' +
            '<span class="prospect-tag tier-' + escapeHtml(p.tier) + '">Tier ' + escapeHtml(p.tier) + '</span>' +
            '<span class="prospect-tag">' + escapeHtml(prospectPlanLine(p)) + '</span>' +
            (PROSPECT_CHAIN_REVIEW[p.id]
              ? '<span class="prospect-tag prospect-tag--review">Team determination</span>'
              : '') +
            (prospectStatusKey(p) !== 'new'
              ? '<span class="prospect-tag" style="background:' + s.color + '22; color:' + s.color + ';">' + escapeHtml(s.label) + '</span>'
              : '') +
          '</span>' +
        '</span>' +
        '<span>→</span>' +
        '</div>';
    }).join('') || '<div class="empty-note">No doors match these filters.</div>';

    var more = document.getElementById('prospect-show-more');
    if (list.length > shown.length) {
      more.style.display = 'flex';
      more.querySelector('small').textContent = shown.length + ' of ' + list.length + ' shown';
    } else {
      more.style.display = 'none';
    }

    document.getElementById('prospect-list').querySelectorAll('[data-prospect-id]').forEach(function (row) {
      row.addEventListener('click', function () {
        openProspect(parseInt(row.getAttribute('data-prospect-id'), 10));
      });
    });
  }

  /** ABC writes cities in caps; the rest of this app does not shout. */
  function titleCase(str) {
    return (str || '').toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  function renderProspects() {
    var list = filteredProspects();
    renderProspectProgress();
    renderProspectFilters();
    renderProspectSweep(list);
    renderProspectList(list);
    renderProspectMap(list);
  }

  function openProspects() {
    prospectState.marks = loadProspectMarks();
    prospectState.limit = PROSPECT_PAGE;
    // An admin opens on the whole board; a rep opens on his own streets.
    prospectState.rep = prospectIsAdmin() ? 'all' : 'mine';
    prospectState.region = '';
    prospectState.tier = 'all';
    document.getElementById('prospect-region').removeAttribute('data-built-for');
    showScreen('screen-prospects');
    // Leaflet measures the container, so it has to be visible first -- the
    // same reason openAccountsMap defers.
    setTimeout(renderProspects, 50);
  }

  document.getElementById('btn-prospects').addEventListener('click', openProspects);
  document.getElementById('back-prospects-to-home').addEventListener('click', function () { showScreen('screen-home'); });

  document.getElementById('prospect-rep-filter').addEventListener('click', function (e) {
    var chip = e.target.closest('[data-rep]');
    if (!chip) return;
    prospectState.rep = chip.getAttribute('data-rep');
    prospectState.limit = PROSPECT_PAGE;
    renderProspects();
  });

  document.getElementById('prospect-tier-filter').addEventListener('click', function (e) {
    var chip = e.target.closest('[data-tier]');
    if (!chip) return;
    prospectState.tier = chip.getAttribute('data-tier');
    prospectState.limit = PROSPECT_PAGE;
    renderProspects();
  });

  document.getElementById('prospect-region').addEventListener('change', function (e) {
    prospectState.region = e.target.value;
    prospectState.limit = PROSPECT_PAGE;
    renderProspects();
  });

  document.getElementById('prospect-status').addEventListener('change', function (e) {
    prospectState.status = e.target.value;
    prospectState.limit = PROSPECT_PAGE;
    renderProspects();
  });

  // "Nearest to me" is the one control that can fail (permission denied, no
  // fix indoors). It asks once, tells the rep what happened, and falls back to
  // plan order rather than silently showing an unsorted list.
  document.getElementById('prospect-sort').addEventListener('change', function (e) {
    var value = e.target.value;
    if (value !== 'near' || prospectState.here) {
      prospectState.sort = value;
      prospectState.limit = PROSPECT_PAGE;
      renderProspects();
      return;
    }
    if (!navigator.geolocation) {
      toast('This phone will not share its location', true);
      e.target.value = prospectState.sort;
      return;
    }
    toast('Finding you…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      prospectState.here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      prospectState.sort = 'near';
      prospectState.limit = PROSPECT_PAGE;
      renderProspects();
    }, function () {
      toast('Could not get your location', true);
      document.getElementById('prospect-sort').value = prospectState.sort;
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });

  document.getElementById('prospect-show-more').addEventListener('click', function () {
    prospectState.limit += PROSPECT_PAGE;
    renderProspectList(filteredProspects());
  });

  var prospectSearchTimer = null;
  document.getElementById('prospect-search').addEventListener('input', function (e) {
    var value = e.target.value;
    clearTimeout(prospectSearchTimer);
    prospectSearchTimer = setTimeout(function () {
      prospectState.q = value;
      prospectState.limit = PROSPECT_PAGE;
      renderProspects();
    }, 180);
  });

  // ---- one door -----------------------------------------------------------
  function findProspect(id) {
    var list = allProspects();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function openProspect(id) {
    var p = findProspect(id);
    if (!p) return;
    prospectState.current = p;

    document.getElementById('prospect-name').textContent = prospectTitle(p);
    document.getElementById('prospect-address').textContent = p.address;
    document.getElementById('prospect-note').value = (prospectMark(id) || {}).note || '';
    document.getElementById('prospect-directions').href =
      'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lng;

    renderProspectStatusButtons();
    renderProspectFacts(p);
    showScreen('screen-prospect');
  }

  function renderProspectStatusButtons() {
    var p = prospectState.current;
    var current = prospectStatusKey(p);
    var mark = prospectMark(p.id);

    document.getElementById('prospect-status-buttons').innerHTML = PROSPECT_STATUSES.map(function (s) {
      var on = s.key === current;
      return '<button type="button" class="prospect-status-btn' + (on ? ' selected' : '') + '" data-status="' + s.key +
        '" style="color:' + (on ? s.color : 'var(--ink)') + ';">' +
        '<i style="background:' + s.color + ';"></i>' + escapeHtml(s.label) + '</button>';
    }).join('');

    var banner = document.getElementById('prospect-status-banner');
    var status = PROSPECT_STATUS_BY_KEY[current];
    banner.innerHTML = '<b style="color:' + status.color + ';">' + escapeHtml(status.label) + '</b> — ' +
      escapeHtml(status.blurb) +
      (mark && mark.at ? '<br/>Marked ' + escapeHtml(new Date(mark.at).toLocaleDateString()) + '.' : '');
  }

  function renderProspectFacts(p) {
    var rows = [
      ['Owner on the license', p.owner],
      ['License type', p.licType + (p.abcStatus !== 'ACTIVE' ? ' · ' + p.abcStatus : '')],
      ['Segment', p.segment],
      ['Concept fit', (function () {
        var t = PROSPECT_TIERS.filter(function (x) { return x.key === p.tier; })[0];
        return t ? t.label + ' — ' + t.what : 'Tier ' + p.tier;
      })()],
      ['Wave', p.wave],
      ['Where it falls', prospectPlanLine(p)],
      ['Territory', (function () {
        var t = prospectTerritory(p);
        return t ? prospectTerritoryRep(t).name + ' — ' + t.label : 'Outside the split';
      })()],
      ['ZIP', p.zip]
    ];
    var sweep = prospectSweep(p);
    if (sweep) rows.push(['The sweep', sweep]);
    if (p.geo !== 'rooftop') rows.push(['Pin accuracy', p.geo === 'zip' ? 'ZIP centroid — check the address' : 'Street-level — close, not exact']);
    if (PROSPECT_CHAIN_REVIEW[p.id]) {
      rows.push(['Before you knock', 'Flagged for a team determination. The license here is held by a local operator, not the brand, so the beer decision may be local \u2014 but that call has not been made. Do not cold-walk it; ask the office.']);
    }
    if (p.segment === 'Local multi-unit (owner-level)') {
      rows.push(['Before you knock', 'This is one of a family group. The owner meeting comes first — check with the office before walking in.']);
    }

    document.getElementById('prospect-facts').innerHTML = rows.filter(function (r) { return r[1]; }).map(function (r) {
      return '<div class="oline"><span>' + escapeHtml(r[0]) + '</span><strong style="text-align:right; max-width:62%;">' +
        escapeHtml(r[1]) + '</strong></div>';
    }).join('');
  }

  document.getElementById('prospect-status-buttons').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-status]');
    if (!btn || !prospectState.current) return;
    var p = prospectState.current;
    var key = btn.getAttribute('data-status');
    var existing = prospectMark(p.id) || {};

    if (key === 'new') {
      // Back to untouched. The note is deliberately kept: a rep clearing a
      // wrong status has not asked to lose what they wrote about the door.
      if (existing.note) prospectState.marks[p.id] = { status: 'new', note: existing.note, at: Date.now() };
      else delete prospectState.marks[p.id];
    } else {
      prospectState.marks[p.id] = { status: key, note: existing.note || '', at: Date.now() };
    }

    saveProspectMarks();
    renderProspectStatusButtons();
    refreshProspectPin(p);
    renderProspectProgress();
    toast(prospectTitle(p) + ' — ' + PROSPECT_STATUS_BY_KEY[key].label);
  });

  // Saved on the way out of the field rather than on every keystroke.
  var prospectNoteTimer = null;
  document.getElementById('prospect-note').addEventListener('input', function (e) {
    if (!prospectState.current) return;
    var p = prospectState.current, note = e.target.value;
    clearTimeout(prospectNoteTimer);
    prospectNoteTimer = setTimeout(function () {
      var existing = prospectMark(p.id) || { status: 'new', at: Date.now() };
      if (!note && existing.status === 'new') delete prospectState.marks[p.id];
      else prospectState.marks[p.id] = { status: existing.status || 'new', note: note, at: existing.at || Date.now() };
      saveProspectMarks();
    }, 400);
  });

  document.getElementById('back-prospect').addEventListener('click', function () {
    showScreen('screen-prospects');
    // The list carries status chips and the map carries colours, so both have
    // to catch up with whatever was just marked.
    setTimeout(renderProspects, 50);
  });

  // A signed door is not an account until it exists in the customer sheet.
  // This hands the rep the same new-account form as the home screen with the
  // four fields ABC already told us filled in.
  document.getElementById('prospect-add-account').addEventListener('click', function () {
    var p = prospectState.current;
    if (!p) return;
    openNewCustomerForm('screen-prospect');
    document.getElementById('nc-name').value = prospectTitle(p);
    document.getElementById('nc-address-street').value = p.address.split(',')[0].trim();
    document.getElementById('nc-address-city').value = titleCase(p.city);
    document.getElementById('nc-address-state').value = 'CA';
    document.getElementById('nc-address-zip').value = p.zip;
    var region = document.getElementById('nc-region');
    if (!region.value) {
      var suggested = inferRegion(state.rep, titleCase(p.city));
      if (suggested) region.value = suggested;
    }
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
