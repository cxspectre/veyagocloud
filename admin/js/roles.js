/* Role resolution + Edge Function helper for the employee dashboard.
   Load after client.js. Exposes window.adminRoles. */
(function () {
  'use strict';

  var cached = null; // { role, employee } once resolved

  /* Session-cached role so the sidebar can render correctly on first paint
     (no flash while queries run). UX only — RLS remains the real boundary. */
  var ROLE_KEY = 'veyago.admin.role';
  function readCachedRole()  { try { return sessionStorage.getItem(ROLE_KEY); } catch (e) { return null; } }
  function writeCachedRole(r) { try { r ? sessionStorage.setItem(ROLE_KEY, r) : sessionStorage.removeItem(ROLE_KEY); } catch (e) {} }

  /* Resolve the signed-in user's role. Order: employees row (owner/admin/
     assistant/employee), else legacy admins-allowlist row → 'admin'. */
  async function resolve() {
    if (cached) return cached;
    var session = await window.admin.session();
    if (!session) return { role: null, employee: null };

    var emp = await window.sb.from('employees')
      .select('id,full_name,role,status,title')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (emp.data && emp.data.status !== 'inactive') {
      cached = { role: emp.data.role, employee: emp.data };
      writeCachedRole(cached.role);
      return cached;
    }

    var adm = await window.sb.from('admins')
      .select('user_id')
      .eq('user_id', session.user.id)
      .maybeSingle();
    cached = { role: adm.data ? 'admin' : null, employee: emp.data || null };
    writeCachedRole(cached.role);
    return cached;
  }

  window.adminRoles = {
    resolve: resolve,

    /* Synchronous best-guess from the session cache — for first-paint UI
       decisions only. May be null on the very first page after login. */
    cachedRole: readCachedRole,

    async role() {
      var r = await resolve();
      return r.role;
    },

    async isManager() {
      var r = await resolve();
      return r.role === 'owner' || r.role === 'admin';
    },

    /* Current user's employees row (null for legacy allowlist-only admins). */
    async employee() {
      var r = await resolve();
      return r.employee;
    },

    /* Call a Supabase Edge Function with the caller's JWT. Throws with a
       readable message on failure. */
    async invokeFn(name, body) {
      var res = await window.sb.functions.invoke(name, { body: body || {} });
      if (res.error) {
        var detail = res.error.message || 'Edge Function error';
        try {
          var ctx = await res.error.context.json();
          if (ctx && ctx.error) detail = ctx.error;
        } catch (e) { /* response body not JSON */ }
        throw new Error(detail);
      }
      if (res.data && res.data.error) throw new Error(res.data.error);
      return res.data;
    }
  };
})();
