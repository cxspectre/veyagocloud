# Add a user — guided flow spec

Replaces the five-field panel on `/admin/team` with a three-step flow plus a durable
handoff page. Written to be built from without asking questions.

Status: **spec, not built.** One dependency is flagged in §7.

---

## 1. Why this one gets a wizard

Most creation flows in this product should stay single-panel forms — a new task, a
new transaction, a new invoice are frequent, expert and unbranching, and stepping
them makes the product slower. Inviting someone earns sequencing for four reasons
the current panel cannot express:

1. **A hidden external prerequisite.** Delivery depends on `RESEND_API_KEY`, which
   the panel discovers only after `createUser` and the `employees` upsert have
   already committed (`invite-employee/index.ts:85`, `:113`, `:150-158`).
2. **An irreversible half-commit.** The failure mode is "the account exists and the
   person cannot get in", which is worse than an outright failure.
3. **A consequential, silent decision.** The role select had no `selected`, so the
   browser picked one and `team.js` read it as a choice. (Fixed in `859b786`; the
   flow makes it structural.)
4. **A handoff.** Success today is a 3.2-second toast (`client.js:153`) on a wrapper
   with `pointer-events: none` (`admin.css`), so it cannot carry a next action even
   in principle — while the four screens that make a hire productive sit unlinked.

## 2. Route and shape

| | |
|---|---|
| Route | `/admin/member-new` (new page; `/admin/team` becomes a pure directory) |
| Pattern | Full-page stepper, one URL per step: `?step=person\|access\|review` |
| Back | Browser Back moves back a step, it does not abandon the flow |
| Guard | `requireManager()` on load, matching `settings.js` |
| Draft | `sessionStorage` under `veyago.admin.invite-draft`, cleared on success |
| Entry | The `Invite member` button on `/admin/team` navigates here instead of scroll-and-focusing a panel that was already visible |

The step rail renders from a single array so the header labels cannot drift from the
steps themselves.

## 3. Step 1 — Person

> **Who are you adding?**

| Field | Required | Validation |
|---|---|---|
| Full name | yes | non-empty after trim |
| Email | yes | regex on blur, not on submit |
| Job title | no | — |
| Start date | no | — |

**Live duplicate check.** The directory is already fetched for the check; match the
typed email case-insensitively against it as the user types. On a hit, stop and
branch explicitly rather than continuing:

> **alex@example.com is already on the team** — Alex Doe, Admin, active.
> [Open their profile] [Resend their invite]

This is the fix for the silent overwrite: `employees.email` is UNIQUE
(`0005_employee_dashboard.sql:38`) and the function upserts with
`onConflict: 'email'` carrying `status: 'invited'` plus the panel's role and title
(`invite-employee/index.ts:113-128`). Today a typo onto an existing owner resets
them to `invited` and overwrites their role, and the UI reports it as
*"linked to existing account"*.

## 4. Step 2 — Access

> **What should they be able to do?**

Radio cards, **nothing preselected**. Continue is disabled until one is chosen — the
default-free state is what makes the choice deliberate rather than structural.

Each card states what the role actually unlocks. Copy is in §7 because it depends on
the publishing decision.

**Elevated roles.** Choosing Admin or Owner reveals an explicit acknowledgement
before Continue enables:

> ☐ I understand this gives Alex access to finance, settings and publishing.

(The review proposed typed confirmation. For a five-person team that is
disproportionate; a checkbox is deliberate enough. Escalate to typed confirmation if
the team grows past a handful of admins.)

## 5. Step 3 — Review & send

> **Ready to invite Alex?**

Three blocks:

**A. Summary** — every value from steps 1–2, each with an Edit link back to its step.

**B. Delivery preflight — the load-bearing part.** Before any write, call
`invite-employee` with `{ dryRun: true }`. The function returns
`{ emailReady, reason }` without touching `auth.users`, `employees` or `email_log`.

- `emailReady: true` → a quiet line: *"The invite will be emailed to alex@example.com."*
- `emailReady: false` → **hard-block Send** with the real remedy, not a pointer to a
  screen that cannot help:

  > **Email is not configured, so the invite cannot be delivered.**
  > `RESEND_API_KEY` is a Supabase secret and has to be set from a terminal:
  > ```
  > supabase secrets set RESEND_API_KEY=re_xxx
  > ```
  > You can still create the account and copy the sign-in link yourself —
  > [Create without sending].

  Today the failure message says *"fix email in Settings"*, and `/admin/settings` is a
  read-only log (`settings.js:93-135`) structurally incapable of fixing it.

**C. What happens next** — pre-ticked opt-ins:

- ☑ Start their onboarding checklist
- ☑ Pre-tick *"Dashboard access granted"* (already seeded at
  `0005_employee_dashboard.sql:295` — it is literally the work this flow just did)
- ☐ Assign a first task

An invite email preview sits behind a disclosure. The template lives server-side only
(`_shared/email.ts:115-137`); expose it through the `dryRun` response so the manager
can see what the new hire will actually receive.

## 6. Success — a page, not a toast

Redirect to `/admin/member?id=<new>#welcome`. A real URL that survives a reload,
replacing a notification that self-destructs in 3.2 seconds.

**Per-write outcomes**, because the server does five distinct things that can each
fail independently (`createUser`, `generateLink`, the `employees` upsert, the Resend
send, the `email_log` insert):

```
✓ Account created
✓ Added to the team as Assistant
✓ Invite emailed to alex@example.com
✓ Onboarding checklist started — 1 of 6 already ticked
```

**A live expiry countdown.** The email promises the link expires in 24 hours
(`_shared/email.ts:128`) and nothing in the admin tracks it, so a dead invite looks
identical to one sent five minutes ago:

> Invited 3 minutes ago — the link expires in about 21 hours.

**Resend inline**, not buried. It currently lives in the member page's danger zone
(`member.html:137`); resending an invite is routine, not destructive.

**Named next actions:** Work the checklist · Assign a task · Add to the template ·
Invite someone else.

### Error recovery — partial failure

If the record committed but the email did not, the flow must not strand the person it
just created. `invite-employee/index.ts:135` already generates `action_link` and
throws it away — **return it** on the `emailSent: false` branch so the handoff page
can offer:

> The account exists but the invite email did not send.
> [Copy sign-in link] — send it to Alex yourself, then [Resend] once email works.

This is the single highest-value line of server change in the spec.

## 7. Dependency: the publishing-approval decision

Agreed model: **an assistant can publish, with an admin's approval.**

That is a request/approve workflow, not a permission toggle, and none of it exists.
Until it does, Step 2's Assistant card cannot honestly claim a publishing capability:
`functions/deploy/index.ts:31` authorises assistants in `PUBLISHERS`, but the only
publish UI is mounted behind `requireManager()` (`settings.js:20`) and `nav.js` hides
the Settings link, so no assistant can reach it.

**Role copy, once the approval flow exists:**

| Role | Card copy |
|---|---|
| Employee | Create and edit site content. Cannot publish. |
| Assistant | Create and edit site content, and request a publish — an admin approves it. |
| Admin | Everything, including finance, settings, and approving publishes. |
| Owner | Everything, including finance, settings, and approving publishes. |

**Until then** the shipped copy says what is true — Assistant and Employee grant the
same access (`859b786`).

Rough shape of that separate build: a `publish_requests` table (requester, status,
approver, decided_at) or a `requested`/`approved` status on `build_runs`; `deploy`
rejects an unapproved request; a Request-publish button wherever content is saved;
an approval queue for admins with a notification. **Estimate: comparable to this
flow.** It should be its own task, sequenced against the other seven.

## 8. Build order

1. `dryRun` mode + return `action_link` on send failure — server, independently useful
2. `/admin/member-new` steps 1–3 against the existing function
3. The handoff page at `#welcome`, and move Resend out of the danger zone
4. Opt-ins (checklist pre-tick, first task) — needs `?assignee=` to prefill the
   compose select, not just the filter (`tasks.js:57` vs `:65-66`)
5. Point `/admin/team`'s Invite button here; delete the sticky panel

Steps 1–3 deliver the whole complaint. 4–5 are the polish.

## 9. Out of scope

Bulk invite, CSV import, custom per-person permissions, SSO, an approvals UI for the
invite itself. None are justified at five people.
