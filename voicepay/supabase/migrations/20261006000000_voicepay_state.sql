-- One row per user. `data` = wallet, KYC (masked), contacts, saved bills, transactions.
-- `agent` / `kyc_sessions` = the voice conversation state, so any Edge Function instance can continue it.
-- Only the Edge Function (direct database connection) touches this table: RLS is on with no policies,
-- and anon / authenticated roles have no privileges.
create table if not exists public.vp_state (
  user_id      text primary key,
  data         jsonb not null,
  agent        jsonb not null default '{}'::jsonb,
  kyc_sessions jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

alter table public.vp_state enable row level security;
revoke all on public.vp_state from anon, authenticated;
