-- Phase 13: sales picker exposes only approved human-usable answers.
do $guard$ begin
  if current_setting('asher.allow_db_tests',true) is distinct from '1' then raise exception 'set asher.allow_db_tests=1'; end if;
end $guard$;
begin;
do $test$
declare v_admin uuid; v_sales uuid; v_category uuid; v_human uuid; v_bot uuid; r jsonb; denied boolean:=false;
begin
  select user_id into v_admin from core.profile where role='admin' and is_active limit 1;
  select user_id into v_sales from core.profile where role='sales' and is_active limit 1;
  select id into v_category from answer_hub.answer_category order by sort_order limit 1;
  if v_admin is null or v_sales is null or v_category is null then raise exception 'admin, sales, and category fixtures are required'; end if;
  insert into answer_hub.answer_item(category_id,title,body_template,status,audience,show_in_quick_answer,bot_auto_answer,priority)
    values(v_category,'[__selftest__] Human quick','A human-visible answer','approved','human',true,false,1) returning id into v_human;
  insert into answer_hub.answer_item(category_id,title,body_template,status,audience,show_in_quick_answer,bot_auto_answer,priority)
    values(v_category,'[__selftest__] Bot quick','A bot-only answer','approved','bot',true,true,1) returning id into v_bot;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_sales)::text,true); set local role authenticated;
  r:=inbox.ah_quick_answer(jsonb_build_object('query','[__selftest__]','category_id',v_category));
  if not (r->'rows' @> jsonb_build_array(jsonb_build_object('id',v_human))) then raise exception 'human quick answer missing'; end if;
  if r->'rows' @> jsonb_build_array(jsonb_build_object('id',v_bot)) then raise exception 'bot-only answer leaked'; end if;
  if not (r->'categories' @> jsonb_build_array(jsonb_build_object('id',v_category))) then raise exception 'category missing'; end if;
  begin perform inbox.ah_quick_answer(jsonb_build_object('project_id','not-a-uuid')); exception when others then denied:=true; end;
  if not denied then raise exception 'invalid project id accepted'; end if;
  reset role; perform set_config('request.jwt.claims','{}',true); set local role authenticated; denied:=false;
  begin perform inbox.ah_quick_answer('{}'); exception when others then denied:=true; end;
  if not denied then raise exception 'anonymous authenticated call accepted'; end if;
end $test$;
rollback;
