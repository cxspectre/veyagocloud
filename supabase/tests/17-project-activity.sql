-- 17-project-activity.sql — a project's own history (0052).
--
-- Every entry in workspace_activity says which project it belongs to. A task on
-- a project being added, done, reopened and deleted, a note on the project being
-- added and deleted, and a file being added and removed each write exactly one
-- entry, on the project, signed by whoever did it, in the words 0027's entries
-- use. Moving a task along without finishing it, renaming it, ticking it twice,
-- a task under no project and a note on anything but a project write none.
-- 0027's own entries (a project, a ticket) carry their project too, and entries
-- written before there was a project to carry are filed under theirs.
--
-- A file's name is for its project's team (0039), so a file's entries are too:
-- staff not on the team read none of them, while still reading the project's
-- other entries; leaving the team closes them; owners and admins read them all,
-- including those of a project deleted outright. Nobody writes the feed except
-- the triggers.
--
-- The member is the inactive assistant, woken for this transaction only; the
-- OWNER is the manager. Changes are made as those people, and every entry is
-- then read as the table owner, in its own statement. Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

-- A statement that must be refused, for the reason given.
create function pg_temp.refused(p_name text, p_statement text, p_reason text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_statement;
    insert into results(name, expected, actual, pass)
    values (p_name, 'refused: ' || p_reason, 'went through', false);
  exception when others then
    insert into results(name, expected, actual, pass)
    values (p_name, 'refused: ' || p_reason, 'refused: ' || left(sqlerrm, 90),
            strpos(lower(sqlerrm), lower(p_reason)) > 0);
  end;
end;
$$;

-- A statement that must go through and touch exactly this many rows.
create function pg_temp.affects(p_name text, p_statement text, p_rows int)
returns void
language plpgsql
as $$
declare
  n int;
begin
  execute p_statement;
  get diagnostics n = row_count;
  insert into results(name, expected, actual, pass)
  values (p_name, p_rows || ' rows', n || ' rows', n = p_rows);
exception when others then
  insert into results(name, expected, actual, pass)
  values (p_name, p_rows || ' rows', 'refused: ' || left(sqlerrm, 90), false);
end;
$$;

-- A query that answers (actual text, pass boolean). An error is a named FAIL,
-- not the end of the suite.
create function pg_temp.check(p_name text, p_expected text, p_query text)
returns void
language plpgsql
as $$
declare
  v_actual text;
  v_pass   boolean;
begin
  execute p_query into v_actual, v_pass;
  insert into results(name, expected, actual, pass)
  values (p_name, p_expected, coalesce(v_actual, 'null'), coalesce(v_pass, false));
exception when others then
  insert into results(name, expected, actual, pass)
  values (p_name, p_expected, 'error: ' || left(sqlerrm, 90), false);
end;
$$;

-- The entries about one record with one verb: how many, and each one's verb,
-- kind of record, wording, audience, project and author.
create function pg_temp.entries(p_entity text, p_verb text)
returns text
language plpgsql
as $$
declare
  v text;
begin
  execute $q$
    select count(*) || coalesce(' · ' || string_agg(
             a.verb || ' ' || a.entity_type
             || ' · ' || a.summary
             || ' · ' || a.visibility
             || ' · ' || case a.project_id::text
                           when 'c1700000-0000-4000-a000-000000000021' then 'on Kept'
                           when 'c1700000-0000-4000-a000-000000000022' then 'on Elsewhere'
                           else coalesce('on ' || a.project_id::text, 'on no project') end
             || ' · ' || case a.actor_id::text
                           when current_setting('test.assistant_employee') then 'by the assistant'
                           when current_setting('test.owner_employee') then 'by the OWNER'
                           else coalesce('by ' || a.actor_id::text, 'by nobody') end,
             ' | ' order by a.summary), '')
    from public.workspace_activity a
    where a.entity_id = $1::uuid and a.verb = $2
  $q$ into v using p_entity, p_verb;
  return v;
end;
$$;

create function pg_temp.entries_are(p_name text, p_entity text, p_verb text, p_expected text)
returns void
language plpgsql
as $$
begin
  perform pg_temp.check(p_name, p_expected,
    format('select v, v = %L from pg_temp.entries(%L, %L) v', p_expected, p_entity, p_verb));
end;
$$;

grant execute on function pg_temp.refused(text, text, text) to authenticated, anon;
grant execute on function pg_temp.affects(text, text, int) to authenticated, anon;
grant execute on function pg_temp.check(text, text, text) to authenticated, anon;
grant execute on function pg_temp.entries(text, text) to authenticated, anon;
grant execute on function pg_temp.entries_are(text, text, text, text) to authenticated, anon;

-- ── Fixtures, as the table owner ─────────────────────────────────────────

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

insert into public.crm_companies (id, name) values
  ('c1700000-0000-4000-a000-000000000010', 'check-db 17 Co');
insert into public.crm_contacts (id, company_id, full_name) values
  ('c1700000-0000-4000-a000-000000000011', 'c1700000-0000-4000-a000-000000000010', 'check-db 17 Person');

-- Kept (…21) is the OWNER's, with the assistant on its team. Elsewhere (…22)
-- has no owner and the assistant is not on it. …23 is deleted outright below.
insert into public.client_projects (id, name, owner_id) values
  ('c1700000-0000-4000-a000-000000000021', 'check-db 17 Kept',
   current_setting('test.owner_employee')::uuid),
  ('c1700000-0000-4000-a000-000000000022', 'check-db 17 Elsewhere', null),
  ('c1700000-0000-4000-a000-000000000023', 'check-db 17 Deleted outright',
   current_setting('test.owner_employee')::uuid);
insert into public.project_members (project_id, employee_id)
values ('c1700000-0000-4000-a000-000000000021', current_setting('test.assistant_employee')::uuid);

insert into public.support_tickets (id, subject, project_id) values
  ('c1700000-0000-4000-a000-000000000041', 'check-db 17 ticket on Kept', 'c1700000-0000-4000-a000-000000000021'),
  ('c1700000-0000-4000-a000-000000000042', 'check-db 17 ticket under no project', null);

-- Uploads, stored the way the Storage API stores them.
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('project-files', 'c1700000-0000-4000-a000-000000000021/u1/check-db-17-brief.pdf',
   '21fc20c1-50e8-4764-9a11-71031d2f8f2c', '{"size": 10, "mimetype": "application/pdf"}'),
  ('project-files', 'c1700000-0000-4000-a000-000000000022/u2/check-db-17-p2-secret.pdf',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', '{"size": 10, "mimetype": "application/pdf"}'),
  ('project-files', 'c1700000-0000-4000-a000-000000000023/u3/check-db-17-p3-gone.pdf',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', '{"size": 10, "mimetype": "application/pdf"}');

-- ── The assistant, a member of Kept ──────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('EVENT: a member adds a task to their project, as the workspace does', $sql$
  insert into public.tasks (id, title, project_id, assignee_id, created_by)
  values ('c1700000-0000-4000-a000-000000000031', 'check-db 17 task',
          'c1700000-0000-4000-a000-000000000021', public.active_employee_id(), auth.uid())
$sql$, 1);

select pg_temp.affects('EVENT: moves it along without finishing it', $sql$
  update public.tasks set status = 'in_progress'
  where id = 'c1700000-0000-4000-a000-000000000031'
$sql$, 1);

select pg_temp.affects('EVENT: ticks it', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1700000-0000-4000-a000-000000000031'
$sql$, 1);

select pg_temp.affects('EVENT: ticks it again, as a second click does', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1700000-0000-4000-a000-000000000031'
$sql$, 1);

select pg_temp.affects('EVENT: unticks it', $sql$
  update public.tasks set status = 'todo', completed_at = null
  where id = 'c1700000-0000-4000-a000-000000000031'
$sql$, 1);

select pg_temp.affects('EVENT: adds a task under no project', $sql$
  insert into public.tasks (id, title, assignee_id, created_by)
  values ('c1700000-0000-4000-a000-000000000032', 'check-db 17 task under no project',
          public.active_employee_id(), auth.uid())
$sql$, 1);

select pg_temp.affects('EVENT: writes a note on the project', $sql$
  insert into public.workspace_notes (id, entity_type, entity_id, author_id, body)
  values ('c1700000-0000-4000-a000-000000000061', 'project', 'c1700000-0000-4000-a000-000000000021',
          public.active_employee_id(), 'check-db 17 note')
$sql$, 1);

select pg_temp.affects('EVENT: writes a note on a contact', $sql$
  insert into public.workspace_notes (id, entity_type, entity_id, author_id, body)
  values ('c1700000-0000-4000-a000-000000000062', 'contact', 'c1700000-0000-4000-a000-000000000011',
          public.active_employee_id(), 'check-db 17 note on a contact')
$sql$, 1);

select pg_temp.affects('EVENT: deletes their note on the project', $sql$
  delete from public.workspace_notes where id = 'c1700000-0000-4000-a000-000000000061'
$sql$, 1);

select pg_temp.affects('EVENT: records a file they uploaded to the project', $sql$
  insert into public.project_files (project_id, storage_path, name, size_bytes, content_type)
  values ('c1700000-0000-4000-a000-000000000021',
          'c1700000-0000-4000-a000-000000000021/u1/check-db-17-brief.pdf',
          'check-db-17-brief.pdf', 10, 'application/pdf')
$sql$, 1);

-- The record's id, for its entries, before the record goes.
select set_config('test.file_kept',
  coalesce((select id::text from public.project_files
            where storage_path = 'c1700000-0000-4000-a000-000000000021/u1/check-db-17-brief.pdf'), 'none'), true);

select pg_temp.affects('EVENT: removes the file''s record', $sql$
  delete from public.project_files
  where storage_path = 'c1700000-0000-4000-a000-000000000021/u1/check-db-17-brief.pdf'
$sql$, 1);

-- ── The OWNER, a manager ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('EVENT: a manager renames the task', $sql$
  update public.tasks set title = 'check-db 17 task, renamed'
  where id = 'c1700000-0000-4000-a000-000000000031'
$sql$, 1);

select pg_temp.affects('EVENT: and deletes it', $sql$
  delete from public.tasks where id = 'c1700000-0000-4000-a000-000000000031'
$sql$, 1);

select pg_temp.affects('EVENT: a manager records a file on a project the assistant is not on', $sql$
  insert into public.project_files (project_id, storage_path, name, size_bytes, content_type)
  values ('c1700000-0000-4000-a000-000000000022',
          'c1700000-0000-4000-a000-000000000022/u2/check-db-17-p2-secret.pdf',
          'check-db-17-p2-secret.pdf', 10, 'application/pdf')
$sql$, 1);

reset role;
select set_config('request.jwt.claims', '', true);

-- A file added to …23 and removed again, and then the project deleted outright
-- (it has no files left, so it can be).
insert into public.project_files (project_id, storage_path, name, size_bytes, content_type)
values ('c1700000-0000-4000-a000-000000000023',
        'c1700000-0000-4000-a000-000000000023/u3/check-db-17-p3-gone.pdf',
        'check-db-17-p3-gone.pdf', 10, 'application/pdf');
delete from public.project_files
where storage_path = 'c1700000-0000-4000-a000-000000000023/u3/check-db-17-p3-gone.pdf';
delete from public.client_projects where id = 'c1700000-0000-4000-a000-000000000023';

-- ── One entry per event, on its project, by whoever did it ───────────────

select pg_temp.entries_are('TASK ADDED: one entry, on its project, by the member who added it',
  'c1700000-0000-4000-a000-000000000031', 'created',
  '1 · created task · New task · check-db 17 task · staff · on Kept · by the assistant');

select pg_temp.entries_are('TASK DONE: one entry, though it was ticked twice',
  'c1700000-0000-4000-a000-000000000031', 'completed',
  '1 · completed task · Completed task · check-db 17 task · staff · on Kept · by the assistant');

select pg_temp.entries_are('TASK REOPENED: one entry',
  'c1700000-0000-4000-a000-000000000031', 'reopened',
  '1 · reopened task · Reopened task · check-db 17 task · staff · on Kept · by the assistant');

select pg_temp.entries_are('TASK DELETED: one entry, still on its project, by the manager who deleted it',
  'c1700000-0000-4000-a000-000000000031', 'deleted',
  '1 · deleted task · Deleted task · check-db 17 task, renamed · staff · on Kept · by the OWNER');

select pg_temp.check('TASK: moving it along or renaming it writes nothing more', '4 entries', $sql$
  select count(*) || ' entries', count(*) = 4
  from public.workspace_activity where entity_id = 'c1700000-0000-4000-a000-000000000031'
$sql$);

select pg_temp.check('TASK: one under no project writes nothing', '0 entries', $sql$
  select count(*) || ' entries', count(*) = 0
  from public.workspace_activity where entity_id = 'c1700000-0000-4000-a000-000000000032'
$sql$);

select pg_temp.entries_are('NOTE ADDED: one entry, on its project, by its author',
  'c1700000-0000-4000-a000-000000000061', 'created',
  '1 · created note · New note · check-db 17 Kept · staff · on Kept · by the assistant');

select pg_temp.entries_are('NOTE DELETED: one entry',
  'c1700000-0000-4000-a000-000000000061', 'deleted',
  '1 · deleted note · Deleted note · check-db 17 Kept · staff · on Kept · by the assistant');

select pg_temp.check('NOTE: one on a contact writes nothing', '0 entries', $sql$
  select count(*) || ' entries', count(*) = 0
  from public.workspace_activity where entity_id = 'c1700000-0000-4000-a000-000000000062'
$sql$);

select pg_temp.entries_are('FILE ADDED: one entry, on its project, for its team',
  current_setting('test.file_kept'), 'created',
  '1 · created file · New file · check-db-17-brief.pdf · team · on Kept · by the assistant');

select pg_temp.entries_are('FILE REMOVED: one entry, for its team',
  current_setting('test.file_kept'), 'deleted',
  '1 · deleted file · Removed file · check-db-17-brief.pdf · team · on Kept · by the assistant');

select pg_temp.entries_are('PROJECT: 0027''s own entry about a project is on it',
  'c1700000-0000-4000-a000-000000000021', 'created',
  '1 · created project · New project · check-db 17 Kept · staff · on Kept · by nobody');

select pg_temp.check('TICKET: 0027''s own entry about a ticket is on the ticket''s project, or on none', 'on Kept · on no project', $sql$
  select string_agg(case a.project_id::text when 'c1700000-0000-4000-a000-000000000021' then 'on Kept'
                                            else coalesce('on ' || a.project_id::text, 'on no project') end,
                    ' · ' order by a.entity_id),
         bool_and(case a.entity_id when 'c1700000-0000-4000-a000-000000000041'
                                   then a.project_id is not distinct from 'c1700000-0000-4000-a000-000000000021'::uuid
                                   else a.project_id is null end)
           and count(*) = 2
  from public.workspace_activity a
  where a.entity_type = 'ticket' and a.verb = 'created'
    and a.entity_id in ('c1700000-0000-4000-a000-000000000041', 'c1700000-0000-4000-a000-000000000042')
$sql$);

select pg_temp.entries_are('DELETED OUTRIGHT: a project''s entries stay in the feed, on no project',
  'c1700000-0000-4000-a000-000000000023', 'created',
  '1 · created project · New project · check-db 17 Deleted outright · staff · on no project · by nobody');

-- ── A file's entries are for its project's team ──────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.check('FILE PRIVACY: a member reads their team''s file entries, name and all', '2 entries', $sql$
  select count(*) || ' entries', count(*) = 2
  from public.workspace_activity
  where entity_type = 'file' and project_id = 'c1700000-0000-4000-a000-000000000021'
    and summary like '%check-db-17-brief.pdf'
$sql$);

select pg_temp.check('FILE PRIVACY: staff not on a project''s team read none of its file entries', '0 entries', $sql$
  select count(*) || ' entries', count(*) = 0
  from public.workspace_activity
  where entity_type = 'file' and project_id = 'c1700000-0000-4000-a000-000000000022'
$sql$);

select pg_temp.check('FILE PRIVACY: nor find the file''s name anywhere in the feed', '0 entries', $sql$
  select count(*) || ' entries', count(*) = 0
  from public.workspace_activity where summary like '%check-db-17-p2-secret%'
$sql$);

select pg_temp.check('FILE PRIVACY: yet still read that project''s other entries', '1 entry', $sql$
  select count(*) || case when count(*) = 1 then ' entry' else ' entries' end, count(*) = 1
  from public.workspace_activity
  where entity_type = 'project' and project_id = 'c1700000-0000-4000-a000-000000000022'
$sql$);

select pg_temp.check('FILE PRIVACY: the file entries of a project deleted outright are hidden from staff', '0 entries', $sql$
  select count(*) || ' entries', count(*) = 0
  from public.workspace_activity where summary like '%check-db-17-p3-gone%'
$sql$);

reset role;
delete from public.project_members
where project_id = 'c1700000-0000-4000-a000-000000000021'
  and employee_id = current_setting('test.assistant_employee')::uuid;
set local role authenticated;

select pg_temp.check('FILE PRIVACY: leaving the team closes its file entries, and only those', '0 file entries · the rest still read', $sql$
  select f.n || ' file entries · ' || case when o.n > 0 then 'the rest still read' else 'nothing else read' end,
         f.n = 0 and o.n > 0
  from (select count(*) as n from public.workspace_activity
        where entity_type = 'file' and project_id = 'c1700000-0000-4000-a000-000000000021') f,
       (select count(*) as n from public.workspace_activity
        where entity_type in ('task', 'note') and project_id = 'c1700000-0000-4000-a000-000000000021') o
$sql$);

select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.check('FILE PRIVACY: owners and admins read them all, a deleted project''s included', '1 · 2', $sql$
  select s.n || ' · ' || g.n, s.n = 1 and g.n = 2
  from (select count(*) as n from public.workspace_activity where summary like '%check-db-17-p2-secret%') s,
       (select count(*) as n from public.workspace_activity where summary like '%check-db-17-p3-gone%') g
$sql$);

reset role;
select set_config('request.jwt.claims', '', true);

-- ── Entries written before an entry had a project ────────────────────────
insert into public.tasks (id, title, project_id)
values ('c1700000-0000-4000-a000-000000000033', 'check-db 17 older task', 'c1700000-0000-4000-a000-000000000022');

-- As 0027's triggers wrote them.
insert into public.workspace_activity (id, verb, entity_type, entity_id, summary) values
  ('c1700000-0000-4000-a000-000000000081', 'updated', 'project', 'c1700000-0000-4000-a000-000000000021',
   'check-db 17 older · Kept moved to in review'),
  ('c1700000-0000-4000-a000-000000000082', 'created', 'ticket', 'c1700000-0000-4000-a000-000000000041',
   'check-db 17 older · a ticket on Kept'),
  ('c1700000-0000-4000-a000-000000000083', 'created', 'task', 'c1700000-0000-4000-a000-000000000033',
   'check-db 17 older · a task on Elsewhere'),
  ('c1700000-0000-4000-a000-000000000084', 'created', 'contact', 'c1700000-0000-4000-a000-000000000011',
   'check-db 17 older · a contact'),
  ('c1700000-0000-4000-a000-000000000085', 'created', 'ticket', 'c1700000-0000-4000-a000-000000000042',
   'check-db 17 older · a ticket under no project'),
  ('c1700000-0000-4000-a000-000000000086', 'updated', 'project', 'c1700000-0000-4000-a000-000000000023',
   'check-db 17 older · a project deleted outright');

select pg_temp.affects('BACKFILL: the older entries start on no project, as every entry did before 0052', $sql$
  update public.workspace_activity set project_id = null
  where id in ('c1700000-0000-4000-a000-000000000081', 'c1700000-0000-4000-a000-000000000082',
               'c1700000-0000-4000-a000-000000000083', 'c1700000-0000-4000-a000-000000000084',
               'c1700000-0000-4000-a000-000000000085', 'c1700000-0000-4000-a000-000000000086')
$sql$, 6);

select pg_temp.affects('BACKFILL: backfill_activity_projects(), which 0052 runs, runs', $sql$
  select public.backfill_activity_projects()
$sql$, 1);

select pg_temp.check('BACKFILL: an entry about a project is filed under it', 'on Kept', $sql$
  select case project_id::text when 'c1700000-0000-4000-a000-000000000021' then 'on Kept'
              else coalesce('on ' || project_id::text, 'on no project') end,
         project_id is not distinct from 'c1700000-0000-4000-a000-000000000021'::uuid
  from public.workspace_activity where id = 'c1700000-0000-4000-a000-000000000081'
$sql$);

select pg_temp.check('BACKFILL: an entry about a ticket, under the ticket''s project', 'on Kept', $sql$
  select case project_id::text when 'c1700000-0000-4000-a000-000000000021' then 'on Kept'
              else coalesce('on ' || project_id::text, 'on no project') end,
         project_id is not distinct from 'c1700000-0000-4000-a000-000000000021'::uuid
  from public.workspace_activity where id = 'c1700000-0000-4000-a000-000000000082'
$sql$);

select pg_temp.check('BACKFILL: an entry about a task, under the task''s project', 'on Elsewhere', $sql$
  select case project_id::text when 'c1700000-0000-4000-a000-000000000022' then 'on Elsewhere'
              else coalesce('on ' || project_id::text, 'on no project') end,
         project_id is not distinct from 'c1700000-0000-4000-a000-000000000022'::uuid
  from public.workspace_activity where id = 'c1700000-0000-4000-a000-000000000083'
$sql$);

select pg_temp.check('BACKFILL: a contact, a ticket under no project and a project deleted outright stay on none',
  'on no project · on no project · on no project', $sql$
  select string_agg(coalesce('on ' || project_id::text, 'on no project'), ' · ' order by id),
         count(*) = 3 and bool_and(project_id is null)
  from public.workspace_activity
  where id in ('c1700000-0000-4000-a000-000000000084', 'c1700000-0000-4000-a000-000000000085',
               'c1700000-0000-4000-a000-000000000086')
$sql$);

-- ── Nobody writes the feed but the triggers ──────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('WRITES: staff cannot add an entry, not even one naming a project', $sql$
  insert into public.workspace_activity (verb, entity_type, entity_id, summary, visibility, project_id)
  values ('created', 'task', 'c1700000-0000-4000-a000-000000000032', 'check-db 17 forged', 'staff',
          'c1700000-0000-4000-a000-000000000021')
$sql$, 'row-level security');

select pg_temp.affects('WRITES: nor reword one, or move it to another project', $sql$
  update public.workspace_activity
  set summary = 'check-db 17 reworded', project_id = 'c1700000-0000-4000-a000-000000000022'
  where id = 'c1700000-0000-4000-a000-000000000081'
$sql$, 0);

select pg_temp.affects('WRITES: nor delete one', $sql$
  delete from public.workspace_activity where id = 'c1700000-0000-4000-a000-000000000081'
$sql$, 0);

select pg_temp.refused('WRITES: nor log one the way the triggers do', $sql$
  select public.log_project_activity('c1700000-0000-4000-a000-000000000021', 'created', 'task',
                                     'c1700000-0000-4000-a000-000000000032', 'check-db 17 forged', 'staff')
$sql$, 'permission denied');

select pg_temp.refused('WRITES: nor file entries under projects', $sql$
  select public.backfill_activity_projects()
$sql$, 'permission denied');

select pg_temp.refused('GRANTS: nor ask which project a record belongs to', $sql$
  select public.activity_project_of('task', 'c1700000-0000-4000-a000-000000000033')
$sql$, 'permission denied');

reset role;
select set_config('request.jwt.claims', '', true);

select pg_temp.check('WRITES: the entry is as it was', 'check-db 17 older · Kept moved to in review · on Kept', $sql$
  select summary || ' · ' || case project_id::text when 'c1700000-0000-4000-a000-000000000021' then 'on Kept'
                                  else coalesce('on ' || project_id::text, 'on no project') end,
         summary = 'check-db 17 older · Kept moved to in review'
           and project_id is not distinct from 'c1700000-0000-4000-a000-000000000021'::uuid
  from public.workspace_activity where id = 'c1700000-0000-4000-a000-000000000081'
$sql$);

-- ── Shape ────────────────────────────────────────────────────────────────

insert into results(name, expected, actual, pass)
select 'SHAPE: an entry''s project is a client project, and the entry outlives it, on none',
       'client_projects · set null',
       coalesce(string_agg(c.confrelid::regclass::text || ' · '
                           || case c.confdeltype when 'n' then 'set null' when 'c' then 'cascade'
                                                 when 'r' then 'restrict' when 'a' then 'no action'
                                                 else c.confdeltype::text end, ', '), 'none'),
       count(*) = 1 and bool_and(c.confrelid = 'public.client_projects'::regclass and c.confdeltype = 'n')
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
where c.conrelid = 'public.workspace_activity'::regclass and c.contype = 'f' and a.attname = 'project_id';

insert into results(name, expected, actual, pass)
select 'SHAPE: a project''s history is read from an index, newest first', '(project_id, created_at DESC)',
       coalesce(string_agg(indexname, ', '), 'none'), count(*) = 1
from pg_indexes
where schemaname = 'public' and tablename = 'workspace_activity'
  and indexdef like '%(project_id, created_at DESC)';

insert into results(name, expected, actual, pass)
select 'POLICIES: a team entry is for the project''s team, whatever else lets staff read the feed',
       'team entries are for the project team',
       coalesce(string_agg(policyname, ', '), 'none'), count(*) = 1
from pg_policies
where schemaname = 'public' and tablename = 'workspace_activity'
  and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
  and roles @> array['authenticated']::name[]
  and qual like '%''team''%' and qual like '%can_open_project_files(project_id)%';

insert into results(name, expected, actual, pass)
select 'POLICIES: the feed still requires the second factor', 'second factor required',
       coalesce(string_agg(policyname, ', '), 'none'), count(*) = 1
from pg_policies
where schemaname = 'public' and tablename = 'workspace_activity'
  and policyname = 'second factor required' and permissive = 'RESTRICTIVE' and cmd = 'ALL';

insert into results(name, expected, actual, pass)
select 'POLICIES: nothing lets anyone write the feed', 'none',
       coalesce(string_agg(policyname, ', '), 'none'), count(*) = 0
from pg_policies
where schemaname = 'public' and tablename = 'workspace_activity'
  and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
