-- E2-3: Coordinator asks the Organiser for clarification/amendment.
--
-- 0007's review_outcome/status only capture a single free-text message —
-- enough to flag "Clarification Requested" but not a back-and-forth. This
-- table holds the full thread the clarification popup renders: top-level
-- questions (parent_id null) and the replies threaded under each one
-- (parent_id = that question's id). Replies are one level deep — no
-- reply-to-a-reply — matching the "Qn 1 -> its replies" shape in the UI.
--
-- Guarded so this is safe to re-run.

create table if not exists event_clarifications (
  id bigserial primary key,
  event_id integer not null references events (id),
  parent_id bigint references event_clarifications (id),
  author_id text not null references users (id),
  author_role text not null check (author_role in ('coordinator', 'organiser')),
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists event_clarifications_event_id_idx on event_clarifications (event_id);
create index if not exists event_clarifications_parent_id_idx on event_clarifications (parent_id);
