/* fake-supabase.js - stands in for data/supabase.js in the Cockpit demo.
 *
 * The workspace's own queries.js, store.js and actions.js run unchanged; only
 * the client under them is swapped. `window.supabase.createClient()` hands
 * back an object that answers `.from(table)` out of the fixture tables in
 * fixtures.js and `.rpc(name)` out of its rpc answers. Nothing here reaches a
 * network: there is no URL, no key and no fetch.
 *
 * The filters the queries use (eq, neq, is, not, in, gt/gte/lt/lte, order,
 * limit, range) are applied, so a view sees the rows it would have seen.
 * `.or()` takes PostgREST filter text and is ignored - every table here is
 * small and the store de-duplicates what comes back twice. Embedded
 * relations (`contact:crm_contacts (...)`) are already on the fixture rows.
 *
 * Writes resolve with no error and change nothing: the demo is for looking at.
 */
(function () {
  'use strict';

  var ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

  function comparable(value) {
    if (typeof value === 'string' && ISO_DAY.test(value)) {
      var t = Date.parse(value.length === 10 ? value + 'T00:00:00Z' : value);
      if (!isNaN(t)) return t;
    }
    return value;
  }

  function compare(a, b) {
    var x = comparable(a);
    var y = comparable(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x < y ? -1 : x > y ? 1 : 0;
  }

  function listOf(text) {
    return String(text).replace(/^\(|\)$/g, '').split(',').map(function (s) { return s.trim(); });
  }

  function answer(data) {
    return Promise.resolve({ data: data, error: null, count: Array.isArray(data) ? data.length : null });
  }

  /* One chain of .from(table)...: filters and orders collected, applied when
     it is awaited. Unknown methods chain as no-ops, so a query written after
     this file still resolves instead of throwing. */
  function query(tables, table) {
    var tests = [];
    var orders = [];
    var window_ = { from: 0, to: Infinity };
    var single = null;
    var writing = false;

    function run() {
      if (writing) return answer(single ? null : []);
      var rows = (tables[table] || []).filter(function (row) {
        return tests.every(function (test) { return test(row); });
      });
      if (orders.length) {
        rows = rows.slice().sort(function (a, b) {
          for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            var c = compare(a[o.column], b[o.column]);
            if (c) return o.ascending ? c : -c;
          }
          return 0;
        });
      }
      rows = rows.slice(window_.from, window_.to + 1);
      if (single) return answer(rows[0] || null);
      return answer(rows);
    }

    var api = {
      select: function () { return proxy; },
      insert: function () { writing = true; return proxy; },
      update: function () { writing = true; return proxy; },
      upsert: function () { writing = true; return proxy; },
      delete: function () { writing = true; return proxy; },
      eq: function (c, v) { tests.push(function (r) { return String(r[c]) === String(v); }); return proxy; },
      neq: function (c, v) { tests.push(function (r) { return String(r[c]) !== String(v); }); return proxy; },
      gt: function (c, v) { tests.push(function (r) { return r[c] != null && compare(r[c], v) > 0; }); return proxy; },
      gte: function (c, v) { tests.push(function (r) { return r[c] != null && compare(r[c], v) >= 0; }); return proxy; },
      lt: function (c, v) { tests.push(function (r) { return r[c] != null && compare(r[c], v) < 0; }); return proxy; },
      lte: function (c, v) { tests.push(function (r) { return r[c] != null && compare(r[c], v) <= 0; }); return proxy; },
      in: function (c, list) {
        var wanted = (Array.isArray(list) ? list : listOf(list)).map(String);
        tests.push(function (r) { return wanted.indexOf(String(r[c])) !== -1; });
        return proxy;
      },
      is: function (c, v) { tests.push(function (r) { return v === null ? r[c] == null : r[c] === v; }); return proxy; },
      not: function (c, op, v) {
        if (op === 'is') tests.push(function (r) { return v === null ? r[c] != null : r[c] !== v; });
        else if (op === 'in') {
          var banned = listOf(v);
          tests.push(function (r) { return banned.indexOf(String(r[c])) === -1; });
        } else if (op === 'eq') tests.push(function (r) { return String(r[c]) !== String(v); });
        return proxy;
      },
      order: function (column, options) {
        if (!(options && (options.foreignTable || options.referencedTable))) {
          orders.push({ column: column, ascending: !(options && options.ascending === false) });
        }
        return proxy;
      },
      limit: function (n) { window_.to = Math.min(window_.to, window_.from + n - 1); return proxy; },
      range: function (from, to) { window_ = { from: from, to: to }; return proxy; },
      single: function () { single = true; return proxy; },
      maybeSingle: function () { single = true; return proxy; },
      then: function (resolve, reject) { return run().then(resolve, reject); },
      catch: function (reject) { return run().catch(reject); }
    };

    var proxy = new Proxy(api, {
      get: function (target, key) {
        if (key in target) return target[key];
        return function () { return proxy; };
      }
    });
    return proxy;
  }

  function createClient() {
    var demo = window.COCKPIT_DEMO || { tables: {}, rpc: {} };
    var none = function () { return answer(null); };
    return {
      from: function (table) { return query(demo.tables, table); },
      rpc: function (name, args) {
        var fn = demo.rpc[name];
        return answer(typeof fn === 'function' ? fn(args || {}) : (fn === undefined ? [] : fn));
      },
      auth: {
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
        signInWithPassword: none, signOut: none, getUser: none, refreshSession: none,
        mfa: { listFactors: function () { return answer({ all: [], totp: [] }); }, challenge: none, verify: none }
      },
      storage: {
        from: function () {
          return { upload: none, remove: none, download: none, createSignedUrl: none, list: function () { return answer([]); } };
        }
      },
      functions: { invoke: none },
      channel: function () {
        var ch = { on: function () { return ch; }, subscribe: function () { return ch; }, unsubscribe: function () {} };
        return ch;
      },
      removeChannel: function () {}
    };
  }

  window.supabase = { createClient: createClient };
})();
