-- Hotfix 2026-10-01: Thai literals in connect_private.receive_event were mojibake
-- (sql/202609211200_messenger_identity_p0.sql had been saved through cp874).
-- ASCII-only on purpose: Thai is written as U&'\0E..' so pasting into a terminal cannot corrupt it again.
-- Rewrites only 4 string literals in the live function; if any pattern does not match exactly once it errors and changes nothing.
begin;
do $do$
declare d text := pg_get_functiondef('connect_private.receive_event(jsonb,timestamptz,integer)'::regprocedure); n int;
begin
  n := (select count(*) from regexp_matches(d, $p$'follow','text','[^']*'$p$, 'g'));
  if n <> 1 then raise exception 'pattern % matched % times', $p$'follow','text','[^']*'$p$, n; end if;
  d := regexp_replace(d, $p$'follow','text','[^']*'$p$, $r$'follow','text','$r$ || U&'\0E40\0E1E\0E34\0E48\0E21\0E40\0E1E\0E37\0E48\0E2D\0E19\0E43\0E2B\0E21\0E48' || $r$'$r$);
  n := (select count(*) from regexp_matches(d, $p$'system', '\[[^']*\]', 'follow'$p$, 'g'));
  if n <> 1 then raise exception 'pattern % matched % times', $p$'system', '\[[^']*\]', 'follow'$p$, n; end if;
  d := regexp_replace(d, $p$'system', '\[[^']*\]', 'follow'$p$, $r$'system', '$r$ || U&'[\0E25\0E39\0E01\0E04\0E49\0E32\0E40\0E1E\0E34\0E48\0E21\0E40\0E1E\0E37\0E48\0E2D\0E19]' || $r$', 'follow'$r$);
  n := (select count(*) from regexp_matches(d, $p$'system', '\[[^']*\]', 'unfollow'$p$, 'g'));
  if n <> 1 then raise exception 'pattern % matched % times', $p$'system', '\[[^']*\]', 'unfollow'$p$, n; end if;
  d := regexp_replace(d, $p$'system', '\[[^']*\]', 'unfollow'$p$, $r$'system', '$r$ || U&'[\0E25\0E39\0E01\0E04\0E49\0E32\0E1A\0E25\0E47\0E2D\0E01\0E1A\0E31\0E0D\0E0A\0E35]' || $r$', 'unfollow'$r$);
  n := (select count(*) from regexp_matches(d, $p$p_data->>'text', '\[[^']*\]'\)$p$, 'g'));
  if n <> 1 then raise exception 'pattern % matched % times', $p$p_data->>'text', '\[[^']*\]'\)$p$, n; end if;
  d := regexp_replace(d, $p$p_data->>'text', '\[[^']*\]'\)$p$, $r$p_data->>'text', '$r$ || U&'[\0E02\0E49\0E2D\0E04\0E27\0E32\0E21\0E17\0E35\0E48\0E44\0E21\0E48\0E43\0E0A\0E48\0E02\0E49\0E2D\0E04\0E27\0E32\0E21\0E15\0E31\0E27\0E2D\0E31\0E01\0E29\0E23]' || $r$')$r$);
  execute d;
end $do$;
select position(U&'\0E40\0E1E\0E34\0E48\0E21\0E40\0E1E\0E37\0E48\0E2D\0E19\0E43\0E2B\0E21\0E48' in pg_get_functiondef('connect_private.receive_event(jsonb,timestamptz,integer)'::regprocedure)) > 0 as follow_text_fixed;
commit;
