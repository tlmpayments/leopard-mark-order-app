(function () {
  var API = window.LM_CONFIG.APPS_SCRIPT_URL;
  var state = {
    rep: null,
    stats: null,
    selection: {}, // productId -> { formatCode: qty }
    customer: null,
    customers: loadCachedCustomers() || (window.LM_CUSTOMERS || []).slice()
  };

  var screens = {};
  document.querySelectorAll('.screen').forEach(function (el) { screens[el.id] = el; });

  function showScreen(id) {
    Object.keys(screens).forEach(function (k) { screens[k].classList.toggle('active', k === id); });
    document.getElementById('order-footer').style.display = id === 'screen-order' ? 'flex' : 'none';
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

  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('login-name').value.trim();
    var pin = document.getElementById('login-pin').value.trim();
    var errEl = document.getElementById('login-error');
    var btn = document.getElementById('login-submit');
    errEl.textContent = '';

    if (!apiConfigured()) {
      // Dev fallback so the app is testable before Apps Script is deployed.
      completeLogin(name, 'Rep');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Checking...';
    apiGet({ action: 'login', name: name, pin: pin })
      .then(function (res) {
        if (res.ok) {
          completeLogin(res.rep, res.role);
        } else {
          errEl.textContent = res.error || 'Invalid name or PIN';
        }
      })
      .catch(function (err) { errEl.textContent = friendlyApiError(err); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Log In';
      });
  });

  document.getElementById('login-use-form-link').addEventListener('click', function (e) {
    e.preventDefault();
    showLoginFallback();
  });

  function showLoginFallback() {
    document.getElementById('login-step-pick').style.display = 'none';
    document.getElementById('login-step-pin').style.display = 'none';
    document.getElementById('login-form').style.display = 'flex';
  }

  // ---------- Tap-to-pick-name + PIN pad ----------
  // Big-target tap flow so reps never have to type on the small login
  // screen: pick your name from a list, then punch a 4-digit PIN. Falls
  // back to the plain typed form (below) if the reps list can't load.
  var pinState = { rep: null, digits: '' };

  function loadRepPicker() {
    var host = document.getElementById('rep-picker');
    if (!apiConfigured()) {
      var demoNames = Object.keys(window.LM_REP_REGIONS || {});
      renderRepPicker(demoNames.length ? demoNames.map(function (n) { return { name: n, role: 'Rep' }; }) : [{ name: 'Demo Rep', role: 'Rep' }]);
      return;
    }
    apiGet({ action: 'reps' })
      .then(function (res) {
        if (res.ok && Array.isArray(res.reps) && res.reps.length) {
          renderRepPicker(res.reps);
        } else {
          host.innerHTML = '<div class="empty-note">Could not load reps.</div>';
        }
      })
      .catch(function () {
        host.innerHTML = '<div class="empty-note">Could not reach the server. Use "Log in a different way" below.</div>';
      });
  }

  function renderRepPicker(reps) {
    var host = document.getElementById('rep-picker');
    host.innerHTML = reps.map(function (r) {
      return '<button type="button" class="rep-tile" data-name="' + escapeHtml(r.name) + '" data-role="' + escapeHtml(r.role || 'Rep') + '" data-needs-pin="' + (r.needsPin ? '1' : '') + '">' + escapeHtml(r.name) + '</button>';
    }).join('');
    host.querySelectorAll('.rep-tile').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openPinPad(btn.getAttribute('data-name'), btn.getAttribute('data-role'), btn.getAttribute('data-needs-pin') === '1');
      });
    });
  }

  // mode is 'login' (rep already has a PIN), 'create' (first digits of a new
  // PIN), or 'confirm' (re-entering it to catch typos) -- 'create'/'confirm'
  // only happen the very first time a rep taps their name with no PIN set.
  function openPinPad(name, role, needsPin) {
    pinState.rep = name;
    pinState.role = role || 'Rep';
    pinState.mode = needsPin ? 'create' : 'login';
    pinState.firstPin = null;
    pinState.digits = '';
    document.getElementById('pin-rep-name').textContent = name;
    document.getElementById('pin-error').textContent = '';
    updatePinInstructions();
    updatePinDots(false);
    document.getElementById('login-step-pick').style.display = 'none';
    document.getElementById('login-step-pin').style.display = 'flex';
  }

  function updatePinInstructions() {
    var el = document.getElementById('pin-instructions');
    if (pinState.mode === 'create') el.textContent = 'Choose a 4-digit PIN';
    else if (pinState.mode === 'confirm') el.textContent = 'Re-enter your PIN to confirm';
    else el.textContent = 'Enter your PIN';
  }

  document.getElementById('pin-back-link').addEventListener('click', function (e) {
    e.preventDefault();
    document.getElementById('login-step-pin').style.display = 'none';
    document.getElementById('login-step-pick').style.display = 'flex';
  });

  function updatePinDots(isError) {
    var dots = document.querySelectorAll('#pin-dots .pin-dot');
    dots.forEach(function (d, i) {
      d.classList.toggle('filled', !isError && i < pinState.digits.length);
      d.classList.toggle('error', !!isError);
    });
  }

  document.getElementById('pin-pad').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-key]');
    if (!btn) return;
    var key = btn.getAttribute('data-key');
    if (key === 'back') {
      pinState.digits = pinState.digits.slice(0, -1);
      updatePinDots(false);
      return;
    }
    if (pinState.digits.length >= 4) return;
    pinState.digits += key;
    updatePinDots(false);
    if (pinState.digits.length === 4) handlePinComplete();
  });

  function handlePinComplete() {
    if (pinState.mode === 'create') {
      pinState.firstPin = pinState.digits;
      pinState.digits = '';
      pinState.mode = 'confirm';
      updatePinInstructions();
      updatePinDots(false);
      return;
    }
    if (pinState.mode === 'confirm') {
      if (pinState.digits !== pinState.firstPin) {
        document.getElementById('pin-error').textContent = "PINs didn't match -- try again";
        updatePinDots(true);
        setTimeout(function () {
          pinState.mode = 'create';
          pinState.firstPin = null;
          pinState.digits = '';
          updatePinInstructions();
          updatePinDots(false);
        }, 500);
        return;
      }
      submitSetPin();
      return;
    }
    submitLogin();
  }

  function submitLogin() {
    var errEl = document.getElementById('pin-error');
    errEl.textContent = '';
    var name = pinState.rep;
    var pin = pinState.digits;

    if (!apiConfigured()) {
      completeLogin(name, pinState.role);
      return;
    }

    apiGet({ action: 'login', name: name, pin: pin })
      .then(function (res) {
        if (res.ok) {
          completeLogin(res.rep, res.role);
        } else {
          errEl.textContent = res.error || 'Incorrect PIN';
          updatePinDots(true);
          setTimeout(function () { pinState.digits = ''; updatePinDots(false); }, 400);
        }
      })
      .catch(function (err) {
        errEl.textContent = friendlyApiError(err);
        pinState.digits = '';
        updatePinDots(false);
      });
  }

  function submitSetPin() {
    var errEl = document.getElementById('pin-error');
    errEl.textContent = '';
    var name = pinState.rep;
    var pin = pinState.firstPin;

    if (!apiConfigured()) {
      completeLogin(name, pinState.role);
      return;
    }

    apiPost({ action: 'setPin', name: name, pin: pin })
      .then(function (res) {
        if (res.ok) {
          completeLogin(res.rep, res.role);
        } else {
          errEl.textContent = res.error || 'Could not save your PIN';
          setTimeout(function () {
            pinState.mode = 'create';
            pinState.firstPin = null;
            pinState.digits = '';
            updatePinInstructions();
            updatePinDots(false);
          }, 600);
        }
      })
      .catch(function (err) {
        errEl.textContent = friendlyApiError(err);
        pinState.mode = 'create';
        pinState.firstPin = null;
        pinState.digits = '';
        updatePinInstructions();
        updatePinDots(false);
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
    document.getElementById('login-step-pin').style.display = 'none';
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('login-step-pick').style.display = 'flex';
    showScreen('screen-login');
    loadRepPicker();
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
        renderInvoice(res);
        document.getElementById('invoice-loading').style.display = 'none';
        document.getElementById('invoice-doc').style.display = 'block';
        document.getElementById('invoice-print-btn').style.display = 'block';
      })
      .catch(function (err) {
        document.getElementById('invoice-loading').textContent = friendlyApiError(err);
      });
  }

  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }

  function fmtMoney(n) {
    return '$' + (Number(n) || 0).toFixed(2);
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

  function renderInvoice(inv) {
    document.getElementById('invoice-doc').innerHTML = buildInvoiceHtml(inv);
  }

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

  // Region is inferred, never typed by the rep: an establishment's address is
  // the most reliable signal (it's an exact place, not a rep's general
  // territory), so city/area keywords are checked first. Only when the
  // address doesn't match anything recognized do we fall back to the
  // logged-in rep's territory, via the same last-name matching used for
  // "My Accounts" above (Sales sheet rep names and Customer Accounts sales
  // person names aren't written consistently).
  var REGION_KEYWORDS = [
    { region: 'San Rafael', match: ['san rafael'] },
    { region: 'Burlingame', match: ['burlingame'] },
    { region: 'North Bay', match: ['north bay', 'santa rosa', 'napa', 'sonoma', 'petaluma', 'novato', 'marin'] },
    { region: 'San Francisco', match: ['san francisco', 'oakland', 'berkeley', 'daly city', ' sf ', ' sf,', ' sf.'] },
    { region: 'Arcadia', match: ['arcadia'] },
    { region: 'Long Beach', match: ['long beach'] },
    { region: 'Orange County', match: ['orange county', 'anaheim', 'irvine', 'santa ana', 'huntington beach', 'costa mesa'] },
    { region: 'San Diego', match: ['san diego'] },
    // No bare "la" token here -- real CA cities like La Mesa, La Jolla, and
    // La Habra all contain it and would be misclassified as Los Angeles.
    { region: 'Los Angeles', match: ['los angeles'] }
  ];

  // Reps whose territory we know from historical order data -- keyed by last
  // name so "T. Gilbert" and "Thomas Gilbert" both resolve. Reps not listed
  // here have no reliable default yet; for them, region only fills in when
  // the address itself gives a match.
  var REP_DEFAULT_REGION = {
    'gilbert': 'San Francisco',
    'williams': 'Los Angeles',
    'krause': 'Orange County',
    'sprague': 'Orange County'
  };

  function inferRegion(rep, address) {
    var addr = ' ' + String(address || '').toLowerCase() + ' ';
    for (var i = 0; i < REGION_KEYWORDS.length; i++) {
      var rule = REGION_KEYWORDS[i];
      for (var j = 0; j < rule.match.length; j++) {
        if (addr.indexOf(rule.match[j]) !== -1) return rule.region;
      }
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
    renderProductList();
    renderPickedCustomer();
    updateOrderTotal();
  }

  // ---------- Customer picker ----------
  function setCustomer(c) {
    state.customer = c;
    renderPickedCustomer();
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

  document.getElementById('btn-pick-customer').addEventListener('click', function () {
    renderCustomerList('');
    document.getElementById('customer-search').value = '';
    showScreen('screen-customers');
  });
  document.getElementById('back-customers-to-order').addEventListener('click', function () { showScreen('screen-order'); });

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
    setCustomer(state.customers[idx]);
    showScreen('screen-order');
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
    state.newCustomerReturnTo = returnTo;
    showScreen('screen-new-customer');
  }

  document.getElementById('back-newcustomer-to-customers').addEventListener('click', function () {
    showScreen(state.newCustomerReturnTo || 'screen-customers');
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
    return document.getElementById(id).getAttribute('data-value') || 'No';
  }

  document.querySelectorAll('.yn-toggle').forEach(function (wrap) {
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('.yn-btn');
      if (!btn) return;
      setYnToggle(wrap.id, btn.getAttribute('data-value'));
    });
  });

  document.getElementById('new-customer-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var errEl = document.getElementById('new-customer-error');
    var val = function (id) { return document.getElementById(id).value.trim(); };
    var newCustomer = {
      establishmentName: val('nc-name'),
      address: val('nc-address'),
      orderingContact: val('nc-contact'),
      phone: val('nc-phone'),
      email: val('nc-email'),
      deliveryAddress: val('nc-delivery-address'),
      deliveryInstructions: val('nc-delivery-instructions'),
      region: inferRegion(state.rep, val('nc-address')),
      licenseNumber: val('nc-license'),
      tapHandleRequested: getYnToggle('nc-tap-handle'),
      salesRep: state.rep || '',
      addedBy: state.rep || '',
      // New accounts have no payment arrangement yet -- never leave this blank
      // (blank could be misread as "no charge" or a data gap), and never guess
      // a real payment method for an account that hasn't been set up.
      paymentMethod: 'Not Set Up'
    };

    var required = ['establishmentName', 'address', 'orderingContact', 'phone', 'email', 'deliveryAddress', 'deliveryInstructions'];
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
        showScreen('screen-home');
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
        '<button type="button" class="product-tile' + (selected ? ' selected' : '') + '" data-toggle="' + p.id + '">' +
          (selected ? '<span class="tile-check">✓</span>' : '') +
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

  // ---------- Boot ----------
  var existing = loadSession();
  if (existing) {
    state.rep = existing;
    state.repRole = loadRole();
    enterHome();
  } else {
    loadRepPicker();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
