-- Phase 14 recommendation: rank keyword matches and keep bot/human audiences isolated.
do $guard$ begin if current_setting('asher.allow_db_tests',true) is distinct from '1' then raise exception 'set asher.allow_db_tests=1'; end if; end $guard$;
begin;
do $test$
declare v_sales uuid; v_cat uuid; v_human uuid; v_bot uuid; r jsonb;
begin
 select user_id into v_sales from core.profile where role='sales' and is_active limit 1; select id into v_cat from answer_hub.answer_category order by sort_order limit 1;
 insert into answer_hub.answer_item(category_id,title,body_template,status,audience,show_in_quick_answer,bot_auto_answer) values(v_cat,'[__selftest__] Recommendation price','price answer','approved','human',true,false) returning id into v_human;
 insert into answer_hub.answer_item(category_id,title,body_template,status,audience,show_in_quick_answer,bot_auto_answer) values(v_cat,'[__selftest__] Recommendation bot','bot price','approved','bot',true,true) returning id into v_bot;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',v_sales)::text,true); set local role authenticated;
 r:=inbox.ah_recommend(jsonb_build_object('question','Recommendation price','audience','human'));
 if not (r->'rows' @> jsonb_build_array(jsonb_build_object('id',v_human))) or r->'rows' @> jsonb_build_array(jsonb_build_object('id',v_bot)) then raise exception 'human recommendation isolation/ranking failed'; end if;
 r:=inbox.ah_recommend(jsonb_build_object('question','Recommendation bot','audience','bot'));
 if not (r->'rows' @> jsonb_build_array(jsonb_build_object('id',v_bot))) then raise exception 'bot recommendation missing'; end if;
end $test$;
rollback;
