create table if not exists public.teacher_feedback (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references auth.users(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  message text not null check (length(trim(message)) > 0),
  category text,
  created_at timestamptz not null default now()
);

create index if not exists teacher_feedback_teacher_created_idx
  on public.teacher_feedback (teacher_id, created_at desc);
create index if not exists teacher_feedback_student_created_idx
  on public.teacher_feedback (student_id, created_at desc);

alter table public.teacher_feedback enable row level security;

drop policy if exists "Participants can read teacher feedback" on public.teacher_feedback;
create policy "Participants can read teacher feedback"
  on public.teacher_feedback
  for select
  to authenticated
  using (teacher_id = auth.uid() or student_id = auth.uid());

drop policy if exists "Teachers can send feedback to class members" on public.teacher_feedback;
create policy "Teachers can send feedback to class members"
  on public.teacher_feedback
  for insert
  to authenticated
  with check (
    teacher_id = auth.uid()
    and exists (
      select 1
      from public.immersion_classes as class
      join public.class_members as member on member.class_id = class.id
      where class.teacher_id = auth.uid()
        and member.student_id = student_id
    )
  );

revoke all on public.teacher_feedback from anon, authenticated;
grant select, insert on public.teacher_feedback to authenticated;

create table if not exists public.student_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  message text not null,
  feedback_id uuid not null references public.teacher_feedback(id) on delete cascade,
  created_at timestamptz not null default now(),
  is_read boolean not null default false,
  unique (feedback_id)
);

create index if not exists student_notifications_recipient_created_idx
  on public.student_notifications (recipient_id, created_at desc);
create index if not exists student_notifications_unread_idx
  on public.student_notifications (recipient_id, created_at desc)
  where is_read = false;

alter table public.student_notifications enable row level security;

drop policy if exists "Students can read their notifications" on public.student_notifications;
create policy "Students can read their notifications"
  on public.student_notifications
  for select
  to authenticated
  using (recipient_id = auth.uid());

drop policy if exists "Students can mark their notifications as read" on public.student_notifications;
create policy "Students can mark their notifications as read"
  on public.student_notifications
  for update
  to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

revoke all on public.student_notifications from anon, authenticated;
grant select on public.student_notifications to authenticated;
grant update (is_read) on public.student_notifications to authenticated;

create or replace function public.notify_student_of_teacher_feedback()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.student_notifications (
    recipient_id,
    title,
    message,
    feedback_id
  )
  values (
    new.student_id,
    new.title,
    'Your Work Immersion teacher sent you new feedback.',
    new.id
  );

  return new;
end;
$$;

drop trigger if exists teacher_feedback_notification_insert on public.teacher_feedback;
create trigger teacher_feedback_notification_insert
  after insert on public.teacher_feedback
  for each row
  execute function public.notify_student_of_teacher_feedback();
