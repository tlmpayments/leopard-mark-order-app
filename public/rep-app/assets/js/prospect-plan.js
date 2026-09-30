// The prospecting schedule: which doors James and Zack work on which day.
//
// There are no territories. Every rep can open any route, and every mark is
// shared live, so two people working the same streets do not need a fence
// between them -- they need an agreed order. This file is that order.
//
// The shape of a day is the one the crew asked for: they start TOGETHER on the
// same doors, then SPLIT and each take an equal share of what is left, so the
// two of them cover a marathon of a city without walking over each other. The
// shared block is worked once (a door either of them marks is done for both,
// because marks sync), so it costs each rep a few doors of the day but
// covers ground twice as fast.
//
// Pure functions of the door list, no DOM: the rep app calls them, and
// __tests__/prospect-plan.test.ts pins the invariants (no door twice, equal
// legs, every door somewhere) so an edit to the numbers cannot quietly drop
// a route.
(function (root) {
  // Keyed on FIRST name because that is what the crew says ("James and
  // Zack"). The PIN login returns a full name ("James Williams", "Zack Bone"),
  // so a rep is matched on the front of it, and on the spellings a Reps sheet
  // is likely to carry for Zack.
  var CREW = [
    { key: 'james', name: 'James', names: ['james'] },
    { key: 'zack',  name: 'Zack',  names: ['zack', 'zach', 'zac', 'zachary'] }
  ];

  var DEFAULTS = {
    // First working day. The plan is a fixed sequence from here, so a day
    // that slips is fixed by moving this date, not by rebuilding anything.
    start: '2026-09-30',
    // Every calendar day is a working day: no weekday/weekend distinction.
    weekdaysOnly: false,
    // Doors the two do side by side at the start of each day.
    together: 6,
    // Doors each rep works alone after the split.
    solo: 12,
    // The second-pass groups, in the order they follow the routes.
    groupOrder: ['S3', 'S1', 'S2', 'S4']
  };

  function crewKey(repName) {
    var first = String(repName || '').trim().toLowerCase().split(/[\s.]+/)[0];
    if (!first) return null;
    for (var i = 0; i < CREW.length; i++) {
      if (CREW[i].names.indexOf(first) !== -1) return CREW[i].key;
    }
    return null;
  }

  function crewName(key) {
    for (var i = 0; i < CREW.length; i++) if (CREW[i].key === key) return CREW[i].name;
    return key;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseIso(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function isExcluded(p) { return String(p.wave || '').indexOf('Excluded') === 0; }

  /** The regions in the order the plan works them: the first-push routes by
   *  their priority, then the second-pass groups that extend them. */
  function regionOrder(prospects, opts) {
    var routes = {}, groups = {};
    prospects.forEach(function (p) {
      if (isExcluded(p)) return;
      if (p.route && !routes[p.route]) routes[p.route] = p.routePriority || 99;
      if (p.group && !groups[p.group]) groups[p.group] = true;
    });
    var out = Object.keys(routes)
      .sort(function (a, b) { return routes[a] - routes[b]; })
      .map(function (r) { return { kind: 'route', name: r }; });
    opts.groupOrder.forEach(function (prefix) {
      Object.keys(groups).forEach(function (g) {
        if (g.indexOf(prefix) === 0) out.push({ kind: 'group', name: g });
      });
    });
    return out;
  }

  function regionLabel(r) { return r.kind === 'group' ? r.name.split(' (')[0] : r.name; }

  /** Every schedulable door, in working order: region by region, stop by stop
   *  (column A already encodes the plan's stop order). */
  function doorQueue(prospects, opts) {
    var queue = [];
    regionOrder(prospects, opts).forEach(function (r) {
      prospects
        .filter(function (p) {
          return !isExcluded(p) && (r.kind === 'route' ? p.route === r.name : p.group === r.name);
        })
        .sort(function (a, b) { return a.id - b.id; })
        .forEach(function (p) { queue.push(p); });
    });
    return queue;
  }

  /**
   * The whole schedule: one entry per working day.
   *
   *   { date, label, together: [ids], legs: { james: [ids], zack: [ids] } }
   *
   * A day takes the next (together + 2 x solo) doors in working order. The
   * first `together` of them are shared. The rest are cut in two along the
   * same order, so each rep's half is a contiguous stretch of the route
   * rather than every other door; who takes the near half (the one that
   * starts where the shared block ended) alternates by day, so neither rep
   * is always the one who drives farther.
   */
  function buildSchedule(prospects, options) {
    var opts = {};
    Object.keys(DEFAULTS).forEach(function (k) { opts[k] = DEFAULTS[k]; });
    Object.keys(options || {}).forEach(function (k) { opts[k] = options[k]; });

    var queue = doorQueue(prospects, opts);
    var perDay = opts.together + opts.solo * 2;
    var days = [];
    var date = parseIso(opts.start);

    function nextWorkingDay() {
      while (opts.weekdaysOnly && (date.getDay() === 0 || date.getDay() === 6)) {
        date.setDate(date.getDate() + 1);
      }
    }

    for (var i = 0; i < queue.length; i += perDay) {
      nextWorkingDay();
      var block = queue.slice(i, i + perDay);
      var together = block.slice(0, opts.together);
      var rest = block.slice(opts.together);
      var half = Math.ceil(rest.length / 2);
      var near = rest.slice(0, half);
      var far = rest.slice(half);
      var swap = days.length % 2 === 1;

      var seen = {}, labels = [];
      block.forEach(function (p) {
        var label = regionLabel(p.route ? { kind: 'route', name: p.route } : { kind: 'group', name: p.group });
        if (!seen[label]) { seen[label] = true; labels.push(label); }
      });

      days.push({
        date: isoOf(date),
        label: labels.join(' + '),
        together: together.map(function (p) { return p.id; }),
        legs: {
          james: (swap ? far : near).map(function (p) { return p.id; }),
          zack: (swap ? near : far).map(function (p) { return p.id; })
        }
      });
      date.setDate(date.getDate() + 1);
    }
    return days;
  }

  var api = {
    CREW: CREW,
    DEFAULTS: DEFAULTS,
    crewKey: crewKey,
    crewName: crewName,
    buildSchedule: buildSchedule,
    regionOrder: regionOrder,
    doorQueue: doorQueue,
    isoOf: isoOf,
    parseIso: parseIso
  };
  root.LM_PROSPECT_PLAN = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
