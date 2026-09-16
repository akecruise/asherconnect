CREATE OR REPLACE FUNCTION inbox.refresh_sales_staff_kpi_daily(p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_from timestamptz := p_day::timestamp at time zone 'Asia/Bangkok';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'Asia/Bangkok';
  v_rows int;
begin
  delete from inbox.sales_staff_kpi_daily where report_date = p_day;

  with eps as (
    select * from inbox.reply_episodes(v_from, v_to) where responder is not null
  ),
  first_resp as (
    select responder,
           count(*)::int as first_responses,
           count(distinct conversation_id)::int as conversations,
           round(avg(minutes), 1) as avg_min,
           round((percentile_cont(0.5) within group (order by minutes))::numeric, 1) as median_min,
           round(max(minutes), 1) as max_min
      from eps group by 1
  ),
  totals as (
    select case when msg.sender_type = 'bot' then 'bot'
                else coalesce(st.name, u.email, 'unknown') end as responder,
           count(*)::int as replies
      from inbox.message msg
      left join inbox.sales_staff st on st.user_id = msg.sender_id
      left join core."user" u on u.id = msg.sender_id
     where msg.sender_type in ('agent','bot')
       and msg.created_at >= v_from and msg.created_at < v_to
     group by 1
  )
  insert into inbox.sales_staff_kpi_daily(report_date, responder, staff_id, replies,
                                          first_responses, conversations, avg_min, median_min, max_min)
  select p_day, t.responder,
         (select st.id from inbox.sales_staff st where st.name = t.responder limit 1),
         t.replies, coalesce(f.first_responses,0), coalesce(f.conversations,0),
         f.avg_min, f.median_min, f.max_min
    from totals t left join first_resp f using (responder);

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$

