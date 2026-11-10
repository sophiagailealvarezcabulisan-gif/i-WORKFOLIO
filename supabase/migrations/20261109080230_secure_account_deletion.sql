create extension if not exists pgcrypto;

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  password_verified boolean not null default false,
  email_verified boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  unique (user_id, id)
);

alter table public.account_deletion_requests enable row level security;

create or replace function public.prepare_account_deletion()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  request_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  delete from public.account_deletion_requests
  where user_id = auth.uid() and created_at < now() - interval '15 minutes';

  insert into public.account_deletion_requests (user_id, password_verified)
  values (auth.uid(), true)
  returning id into request_id;

  return request_id;
end;
$$;

create or replace function public.mark_account_deletion_email_verified(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.account_deletion_requests
  set email_verified = true
  where id = p_request_id
    and user_id = auth.uid()
    and password_verified = true
    and expires_at > now();

  if not found then
    raise exception 'Invalid or expired account deletion request';
  end if;
  return true;
end;
$$;

create or replace function public.delete_account_data(p_request_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'Only the account deletion service may complete deletion';
  end if;

  if not exists (
    select 1
    from public.account_deletion_requests
    where id = p_request_id
      and user_id = p_user_id
      and password_verified = true
      and email_verified = true
      and expires_at > now()
  ) then
    raise exception 'Account deletion verification is incomplete or expired';
  end if;

  delete from public.class_members
  where student_id = p_user_id
     or class_id in (
       select id from public.immersion_classes where teacher_id = p_user_id
     );

  delete from public.immersion_classes where teacher_id = p_user_id;
  delete from public.portfolio_entries where user_id = p_user_id;
  delete from public.profiles where id = p_user_id;

  return true;
end;
$$;

revoke all on function public.prepare_account_deletion() from public;
revoke all on function public.mark_account_deletion_email_verified(uuid) from public;
revoke all on function public.delete_account_data(uuid, uuid) from public;
grant execute on function public.prepare_account_deletion() to authenticated;
grant execute on function public.mark_account_deletion_email_verified(uuid) to authenticated;
