(function () {
  var API = window.LM_CONFIG.APPS_SCRIPT_URL;
  var state = {
    rep: null,
    stats: null,
    selection: {}, // productId -> { formatCode: qty }
    customer: null,
    customers: loadCachedCustomers() || (window.LM_CUSTOMERS || []).slice(),
    navReturnTo: 'screen-order' // where the customer picker sends you back to
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
        }
      })
      .catch(function () {
        // Stay on whatever we already have (cache or bundled file) — this is a
        // background refresh, not something that should interrupt the rep.
      });
  }

  // ---------- Login ----------
  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('login-name').value.trim();
    var pin = document.getElementById('login-pin').value.trim();
    var errEl = document.getElementById('login-error');
    var btn = document.getElementById('login-submit');
    errEl.textContent = '';

    if (!apiConfigured()) {
      // Dev fallback so the app is testable before Apps Script is deployed.
      state.rep = name;
      saveSession(name);
      enterHome();
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Checking...';
    apiGet({ action: 'login', name: name, pin: pin })
      .then(function (res) {
        if (res.ok) {
          state.rep = res.rep;
          saveSession(res.rep);
          enterHome();
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

  function friendlyApiError(err) {
    if (err && err.message === 'NOT_SIGNED_IN') {
      return 'Sign in to your Google account first: open the link at the bottom of this page once, sign in, then come back and try again.';
    }
    return 'Could not reach the server. Check your connection.';
  }

  document.getElementById('logout-btn').addEventListener('click', function () {
    clearSession();
    state.rep = null;
    showScreen('screen-login');
  });

  // ---------- Home / stats ----------
  function enterHome() {
    document.getElementById('home-rep-name').textContent = state.rep;
    var regions = window.LM_REP_REGIONS || {};
    document.getElementById('home-rep-region').textContent = regions[state.rep] || 'Sales Rep';
    showScreen('screen-home');
    loadStats();
    refreshCustomers();
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
      return '<div class="order-row">' +
        '<div><div class="oname">' + escapeHtml(o.customer || 'Unknown account') + '</div>' +
        '<div class="osub">' + escapeHtml(o.product || '') + ' · ' + escapeHtml(o.packaging || '') + ' · Qty ' + o.qty + '</div></div>' +
        '<span class="pill ' + statusClass + '">' + escapeHtml(o.status || 'Pending') + '</span>' +
        '</div>';
    }).join('');
  }

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

  document.getElementById('btn-reorder').addEventListener('click', function () {
    resetOrderForm();
    var last = (state.stats && state.stats.recentOrders && state.stats.recentOrders[0]) || null;
    if (last && last.customer) {
      var match = state.customers.find(function (c) { return c.establishmentName === last.customer; });
      setCustomer(match || { establishmentName: last.customer, address: '', licenseNumber: '' });
    }
    showScreen('screen-order');
    toast('Pick beers below to repeat this account’s order');
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
  document.getElementById('back-newcustomer-to-customers').addEventListener('click', function () { showScreen('screen-customers'); });

  document.getElementById('customer-search').addEventListener('input', function (e) {
    renderCustomerList(e.target.value);
  });

  function renderCustomerList(query) {
    var host = document.getElementById('customer-list');
    var q = (query || '').trim().toLowerCase();
    var list = state.customers.filter(function (c) {
      if (!q) return true;
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
    document.getElementById('new-customer-form').reset();
    document.getElementById('new-customer-error').textContent = '';
    showScreen('screen-new-customer');
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
      region: val('nc-region'),
      licenseNumber: val('nc-license'),
      salesRep: state.rep || '',
      addedBy: state.rep || '',
      // New accounts have no payment arrangement yet -- never leave this blank
      // (blank could be misread as "no charge" or a data gap), and never guess
      // a real payment method for an account that hasn't been set up.
      paymentMethod: 'Not Set Up'
    };

    var required = ['establishmentName', 'address', 'orderingContact', 'phone', 'email', 'deliveryAddress', 'deliveryInstructions', 'region'];
    var missing = required.filter(function (k) { return !newCustomer[k]; });
    if (missing.length) { errEl.textContent = 'Please fill in all required fields.'; return; }

    var btn = document.getElementById('nc-submit');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    var finish = function () {
      state.customers.unshift(newCustomer);
      setCustomer(newCustomer);
      btn.disabled = false;
      btn.textContent = 'Save Customer';
      toast('Customer added');
      showScreen('screen-order');
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
    host.innerHTML = window.LM_PRODUCTS.map(function (p) {
      var selected = !!state.selection[p.id];
      return (
        '<div class="product-card' + (selected ? ' selected' : '') + '" data-product="' + p.id + '">' +
          '<div class="product-row">' +
            '<div class="product-thumb"><img src="' + p.image + '" alt="' + escapeHtml(p.name) + ' can" /></div>' +
            '<div class="product-text">' +
              '<div class="pname">' + escapeHtml(p.name) + '</div>' +
              '<div class="psub">' + escapeHtml(p.subtitle) + '</div>' +
            '</div>' +
            '<button class="product-toggle" data-toggle="' + p.id + '">' + (selected ? 'Selected ✓' : 'Select') + '</button>' +
          '</div>' +
          '<div class="product-info">' +
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
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  document.getElementById('product-list').addEventListener('click', function (e) {
    var toggleId = e.target.getAttribute('data-toggle');
    if (toggleId) {
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

    var finish = function (ok, msg) {
      btn.disabled = false;
      label.textContent = 'Submit Order';
      toast(msg, !ok);
      if (ok) {
        loadStats();
        showScreen('screen-home');
      }
    };

    if (!apiConfigured()) {
      setTimeout(function () { finish(true, 'Order captured (demo mode — connect the sheet in config.js)'); }, 500);
      return;
    }

    apiPost(payload)
      .then(function (res) {
        if (res.ok) finish(true, lines.length + ' line item(s) sent to the order sheet');
        else finish(false, res.error || 'Order failed to submit');
      })
      .catch(function (err) { finish(false, friendlyApiError(err)); });
  });

  // ---------- Boot ----------
  var existing = loadSession();
  if (existing) {
    state.rep = existing;
    enterHome();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
