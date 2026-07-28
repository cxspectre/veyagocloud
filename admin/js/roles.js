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

  /* Resolve the signed-in user's role from employees.role — the single source
     of truth since migration 0007.

     This used to fall back to the legacy public.admins allowlist and report
     'admin' for anyone on it. That contradicted the database: 0007 states in
     its own header that public.admins "still exist[s] but [is] referenced by
     NO policy", and is_manager() reads employees.role alone. So such a user was
     handed the full manager UI — Finance, Settings, Transactions, Invoices,
     Publish, the approval queue — and every one of those screens then returned
     nothing, because RLS had never heard of them. A UI built on a role the
     server does not recognise is worse than no access: it looks like the
     product is broken rather than like you are not allowed in.

     The allowlist is still the break-glass, but recovering through it means
     inserting an employees row (0007 gives the exact SQL), not signing in and
     hoping. */
  async function resolve() {
    if (cached) return cached;
    var session = await window.admin.session();
    if (!session) return { role: null, employee: null };

    var emp = await window.sb.from('employees')
      .select('id,full_name,role,status,title')
      .eq('user_id', session.user.id)
      .maybeSingle();

    var active = emp.data && emp.data.status !== 'inactive';
    cached = {
      role: active ? emp.data.role : null,
      employee: emp.data || null,
      /* Surfaced so a screen can say something more useful than "no access" to
         someone who is genuinely on the allowlist but has no employees row. */
      inactive: !!(emp.data && emp.data.status === 'inactive')
    };
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

    /* Anyone with a role at all — matches is_staff() in the database. */
    async isStaff() {
      var r = await resolve();
      return !!r.role;
    },

    /* Who may publish the live site. Mirrors PUBLISHERS in
       supabase/functions/deploy/index.ts — keep the two in step. Cosmetic, like
       every predicate here: the function re-resolves the role server-side from
       the database, so this cannot be spoofed into a publish.

       Deliberately NOT backed by a SQL is_publisher() helper. Migration 0007
       names exactly that as an anti-pattern: a helper implies RLS enforces
       something that is really enforced in the Edge Function. */
    async isPublisher() {
      var r = await resolve();
      return r.role === 'owner' || r.role === 'admin' || r.role === 'assistant';
    },

    /* Guard a page. Redirects to the dashboard if the caller isn't allowed.
       Cosmetic only — RLS is the real boundary — but it means a wrong URL
       shows the dashboard instead of a broken empty page. */
    async requireManager() {
      if (await this.isManager()) return true;
      window.location.href = '/admin/';
      return false;
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
