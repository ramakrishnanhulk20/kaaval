-- One row per trader per Bitget account. Connecting the same account again updates the row
-- that is there instead of leaving a second copy of the same sealed key behind. Two rows
-- whose uid is null are left alone by this: Postgres reads two nulls as two different
-- values, and an account Bitget never named cannot be proved to be the same account.
create unique index if not exists connections_user_id_uid_idx on connections (user_id, uid);
