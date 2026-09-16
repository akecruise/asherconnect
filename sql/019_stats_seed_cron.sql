-- =====================================================================
-- ASHER Connect — Reply Stats  /  0004 seed + cron
-- =====================================================================

-- นโยบายเริ่มต้น (ทุก project / ทุก channel) — ปรับได้จากหน้า admin
insert into inbox.sla_policy (project, channel_key, target_sec, warn_sec, breach_sec,
                              biz_open, biz_close, biz_days, tz)
select null, null, 900, 1800, 3600, '09:00', '20:00', '{1,2,3,4,5,6,7}', 'Asia/Bangkok'
where not exists (select 1 from inbox.sla_policy where project is null and channel_key is null);

-- ตัวอย่างการผูกลายเซ็น -> พนักงาน (เติมจริงจากหน้า admin)
-- insert into inbox.signature_alias (alias, profile_id) values ('-มิ้นท์', '<uuid>');

-- ---------------------------------------------------------------------
-- pg_cron  (เวลาเป็น UTC: Asia/Bangkok = UTC+7)
-- ---------------------------------------------------------------------
-- create extension if not exists pg_cron;

-- ทุก 5 นาที: อัปสถานะรอบที่เกินกำหนดแล้วยังไม่มีใครตอบ
-- select cron.schedule('stats_mark_overdue', '*/5 * * * *',
--   $$select inbox.mark_overdue_windows()$$);

-- 00:15 เวลาไทย (17:15 UTC): รวมยอดของเมื่อวาน
-- select cron.schedule('stats_rollup_daily', '15 17 * * *',
--   $$select inbox.rollup_agent_daily((now() at time zone 'Asia/Bangkok')::date - 1)$$);

-- 01:00 เวลาไทย: ปิดรอบที่ค้างเกิน 7 วัน
-- select cron.schedule('stats_abandon', '0 18 * * *',
--   $$select inbox.abandon_stale_windows(7)$$);

-- หมายเหตุ: การยิง Telegram ให้ทำจากฝั่ง asher-connect (Node) ไม่ใช่ pg_net
-- เพราะ token ของ Telegram อยู่ใน channels.json ไม่ได้อยู่ใน DB โดยเจตนา
-- Node เรียก rpc inbox.stats_telegram_daily() แล้วส่งข้อความเอง
