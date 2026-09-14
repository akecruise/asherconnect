-- ─────────────────────────────────────────────────────────────────────────────
-- โหมดเงา: เก็บคำตอบของบอทตัวเดิมไว้ โดยไม่ส่งอะไรออกไปหาลูกค้า
--
-- ที่มา: ระหว่างที่บอทตัวเดิมยังคุยกับลูกค้าอยู่ เราอยากสะสมบทสนทนาจริงไว้ใน ASHER
-- เพื่อเอาไปพัฒนาคำตอบ แต่ webhook พาเข้ามาแต่ข้อความของลูกค้า ไม่มีคำตอบของบอทติดมาด้วย
-- ซึ่งคำตอบของบอทคือครึ่งที่มีค่าที่สุด — ถ้าไม่เก็บ จะรู้แค่ว่าลูกค้าถามอะไร
-- แต่ไม่รู้ว่าตอบแบบไหนแล้วลูกค้าไปต่อ
--
-- กับดักที่ migration นี้มีไว้แก้:
--   การบันทึกคำตอบของบอทต้องใส่เป็น sender_type='bot' ซึ่งจะไปปลุก trigger
--   inbox.enqueue_outbound แล้วสร้างงานขาออกขึ้นมา ในโหมดเงา worker ไม่เดิน
--   งานพวกนั้นจะกองเป็น pending ไปเรื่อย ๆ แล้ว *วันที่ปิดโหมดเงา worker จะตื่นขึ้นมา
--   ยิงคำตอบเก่าทั้งหมดออกไปหาลูกค้าพร้อมกัน* ทุกข้อความที่บอทเคยตอบไปเมื่อหลายสัปดาห์ก่อน
--   จะถูกส่งซ้ำอีกรอบ
--
--   แก้ด้วยการให้ trigger รู้ตัวตั้งแต่แรกว่านี่คือการบันทึกย้อนหลัง ไม่ใช่คำสั่งให้ส่ง
--   จึงไม่มีงานขาออกเกิดขึ้นเลย — ดีกว่าการจำไว้ว่าต้องล้างคิวก่อนปิดโหมด
--   ซึ่งเป็นสิ่งที่คนลืมได้ และลืมทีเดียวก็เสียหายกับลูกค้าจริง
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1) ให้ trigger ข้ามการสร้างงานขาออก เมื่ออยู่ในธุรกรรมของการบันทึกย้อนหลัง

create or replace function inbox.enqueue_outbound()
returns trigger
language plpgsql
security definer
set search_path to 'inbox', 'connect_private', 'core', 'public', 'pg_temp'
as $function$
DECLARE v_has_recipient boolean;
BEGIN
    -- การบันทึกย้อนหลังจากบอทตัวเดิม ไม่ใช่ข้อความที่เราต้องส่ง
    -- GUC ตัวนี้ตั้งแบบ transaction-local โดย connect_private.replay() เท่านั้น
    IF coalesce(current_setting('connect.replay', true), '') = 'on' THEN
        RETURN NEW;
    END IF;

    IF NEW.sender_type NOT IN ('agent','bot') THEN
        RETURN NEW;
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM inbox.conversation c
          JOIN inbox.inbox i ON i.id = c.inbox_id AND i.is_active
          JOIN core.contact_identity ci
            ON ci.contact_id = c.contact_id
           AND ci.channel = i.channel
           AND ci.account_key = i.id::text
         WHERE c.id = NEW.conversation_id
    ) INTO v_has_recipient;

    IF NOT v_has_recipient THEN
        -- บันทึกไว้ให้คนตามได้ว่าทำไมข้อความนี้ไม่ถูกส่ง
        -- เงียบไปเฉย ๆ คือสิ่งที่ทำให้ปัญหาแบบนี้ใช้เวลาหาหลายชั่วโมง
        INSERT INTO core.event_log(event_type, entity, entity_id, actor_type, project_id, channel, request_id, payload)
        SELECT 'inbox.outbound_skipped', 'message', NEW.id, 'system'::core.actor_type,
               i.project_id, i.channel, NEW.id::text,
               jsonb_build_object('reason','ไม่พบช่องทางติดต่อของลูกค้า (core.contact_identity)')
          FROM inbox.conversation c JOIN inbox.inbox i ON i.id = c.inbox_id
         WHERE c.id = NEW.conversation_id;
        RETURN NEW;
    END IF;

    INSERT INTO connect_private.delivery (message_id, status, available_at)
    VALUES (NEW.id, 'pending', now())
    ON CONFLICT (message_id) DO NOTHING;

    RETURN NEW;
END;
$function$;


-- ── 2) ฟังก์ชันบันทึกคำตอบของบอทตัวเดิม
--
-- แยกจาก connect_private.worker โดยตั้งใจ เพื่อให้อ่านออกจากชื่อเลยว่าเส้นทางนี้
-- ไม่เคยส่งอะไรออก และเพื่อไม่ต้องไปแก้ฟังก์ชันก้อนใหญ่ที่ของจริงวิ่งผ่านอยู่ทุกวัน

create or replace function connect_private.replay(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_inbox inbox.inbox;
  v_contact uuid;
  v_id uuid;
  v_message uuid;
  v_time timestamptz;
  v_sender text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_only' using errcode='42501';
  end if;

  -- รับได้ทั้งคำตอบของบอทและของคนที่ตอบผ่านระบบเดิม ค่าอื่นไม่รับ
  -- 'contact' ต้องเข้าทาง receive เท่านั้น ไม่ใช่ทางนี้
  v_sender := coalesce(p_data->>'sender_type','bot');
  if v_sender not in ('bot','agent') then
    raise exception 'invalid_sender';
  end if;

  select * into v_inbox from inbox.inbox where id=(p_data->>'inbox_id')::uuid and is_active;
  if not found then raise exception 'channel_not_configured'; end if;

  if coalesce(p_data->>'external_id','')='' or coalesce(p_data->>'event_id','')='' then
    raise exception 'invalid_event';
  end if;

  -- ล็อกด้วยคู่ (ช่องทาง, ผู้ติดต่อ) แบบเดียวกับ receive เพื่อกันสองสายเข้าพร้อมกัน
  perform pg_advisory_xact_lock(hashtextextended(v_inbox.id::text||':'||(p_data->>'external_id'),0));

  v_contact := core.resolve_identity(
    v_inbox.channel, p_data->>'external_id', v_inbox.id::text,
    p_data->>'display_name', v_inbox.project_id);

  select id into v_id from inbox.conversation
   where inbox_id=v_inbox.id and contact_id=v_contact
   order by created_at desc limit 1 for update;
  if v_id is null then
    insert into inbox.conversation(inbox_id,contact_id) values(v_inbox.id,v_contact) returning id into v_id;
  end if;

  -- กันซ้ำด้วย event_id เหมือน receive ยิงซ้ำกี่รอบก็ไม่เกิดข้อความซ้ำ
  if exists(select 1 from inbox.message where conversation_id=v_id and external_message_id=p_data->>'event_id') then
    return jsonb_build_object('duplicate',true);
  end if;

  perform connect_private.ensure_lead(v_id);
  v_time := least(now(), coalesce((p_data->>'occurred_at')::timestamptz, now()));

  -- ธงที่ทำให้ trigger ไม่สร้างงานขาออก ตั้งแบบ transaction-local (พารามิเตอร์ที่สามเป็น true)
  -- จึงหมดผลเองเมื่อจบธุรกรรม ไม่รั่วไปถึงคำสั่งอื่นที่ใช้ connection เดียวกันทีหลัง
  perform set_config('connect.replay','on',true);

  insert into inbox.message(conversation_id,sender_type,content,content_type,external_message_id,created_at)
  values (v_id, v_sender,
          coalesce(p_data->>'text','[ข้อความที่ไม่ใช่ข้อความตัวอักษร]'),
          coalesce(p_data->>'content_type','text'),
          p_data->>'event_id', v_time)
  returning id into v_message;

  -- ลูกค้าได้คำตอบไปแล้วจากบอทตัวเดิม จึงหยุดนาฬิกา SLA
  -- ถ้าไม่หยุด ทุกเคสจะขึ้นว่าเกินกำหนดทั้งที่มีคนตอบไปแล้ว แล้วหน้าจอ SLA จะใช้ไม่ได้เลย
  update connect_private.case_state set waiting_since=null where conversation_id=v_id;

  return jsonb_build_object('id',v_id,'message_id',v_message,'replayed',true);
end;
$function$;


-- ── 3) ปลายทางที่เรียกจากภายนอก

create or replace function inbox.connect_replay(p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language sql
set search_path to 'pg_catalog', 'public'
as $function$ select connect_private.replay(p_data) $function$;


-- ── 4) สิทธิ์: เครื่องคุยกับเครื่องเท่านั้น เบราว์เซอร์ไม่มีสิทธิ์แตะเส้นทางนี้

revoke all on function inbox.connect_replay(text,jsonb) from public;
revoke all on function connect_private.replay(jsonb) from public;
grant execute on function inbox.connect_replay(text,jsonb) to service_role;
-- wrapper เป็น SQL ธรรมดา จึงรันด้วยสิทธิ์ของผู้เรียก ต้อง grant ฟังก์ชันข้างในด้วย
-- แบบเดียวกับที่ connect_private.worker ทำอยู่ ไม่ใช่ SECURITY DEFINER ที่ wrapper
grant execute on function connect_private.replay(jsonb) to service_role;

commit;
