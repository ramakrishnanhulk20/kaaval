-- A signed-in trader, the keys they have connected, and the plans made for them.
-- The engine's own public record stays in files; nothing about it lives here.

create table if not exists users (
  id text primary key,
  created_at timestamptz not null default now()
);

create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users (id) on delete cascade,
  label text not null,
  uid text,
  -- The three credential strings sealed together under the server key. This column is
  -- never selected by anything that answers a browser.
  sealed jsonb not null,
  equity_usdt numeric,
  positions integer,
  checked_at timestamptz,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references connections (id) on delete cascade,
  ts timestamptz not null,
  -- "window" is a reserved word in Postgres, so it is quoted here and everywhere it is
  -- read. The name is kept because it is the word the engine and the screens both use.
  "window" text not null,
  plan jsonb not null,
  signature text,
  created_at timestamptz not null default now()
);

create table if not exists audit (
  id bigserial primary key,
  user_id text not null references users (id) on delete cascade,
  kind text not null,
  at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);

create index if not exists connections_user_id_idx on connections (user_id);
create index if not exists plans_connection_id_ts_idx on plans (connection_id, ts desc);
