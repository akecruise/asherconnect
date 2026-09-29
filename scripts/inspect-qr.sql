select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='inbox' and table_name in ('quick_reply','quick_reply_attachment','quick_reply_usage','media_asset','message') order by table_name,ordinal_position;
select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='inbox' and (p.proname like 'qr_%' or p.proname in ('can_read','stats_scope'));
select conrelid::regclass,pg_get_constraintdef(oid) from pg_constraint where conrelid in ('inbox.quick_reply'::regclass,'inbox.quick_reply_usage'::regclass,'inbox.media_asset'::regclass);
select count(*) as reply_count from inbox.quick_reply;
