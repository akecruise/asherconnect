-- Trial qualification set: one customer question per reply.
-- intents are structured hints for downstream TypeSafe analysis; they are not
-- treated as proof of customer intent by themselves.
begin;

alter table inbox.quick_reply drop constraint if exists quick_reply_category_check;
alter table inbox.quick_reply add constraint quick_reply_category_check check (category = any (array[
  'greeting','rooms_price','floorplan','facilities','location','promo','visit','other',
  'ราคา','โปรโมชั่น','นัดชม','ทำเล','ห้องว่าง','การจอง','ทั่วไป','ข้อมูลโครงการ','คัดกรอง','ติดตาม'
]));

insert into inbox.quick_reply
  (project, category, shortcut, title, body, send_order, intents, bot_enabled, confidence_min, sort_order, active, source, source_shortcut)
values
  ('all','คัดกรอง','buyer_type','ถามวัตถุประสงค์','เพื่อแนะนำข้อมูลให้ตรงที่สุด สนใจซื้ออยู่เองหรือลงทุนครับ/คะ?','text_only',array['buyer_intent'],false,.8,10,true,'asher','buyer_type'),
  ('all','คัดกรอง','project_interest','ถามโครงการ','มีโครงการหรือทำเลที่สนใจเป็นพิเศษไหมครับ/คะ?','text_only',array['project_interest','location_interest'],false,.8,20,true,'asher','project_interest'),
  ('all','คัดกรอง','budget_range','ถามงบประมาณ','เพื่อแนะนำห้องที่ตรงที่สุด มองงบประมาณไว้ประมาณช่วงไหนครับ/คะ?','text_only',array['budget_range'],false,.8,30,true,'asher','budget_range'),
  ('all','คัดกรอง','room_type','ถามประเภทห้อง','ต้องการห้องประมาณกี่ห้องนอนครับ/คะ?','text_only',array['room_type','bedroom_count'],false,.8,40,true,'asher','room_type'),
  ('all','คัดกรอง','buying_timeline','ถามช่วงเวลาซื้อ','วางแผนซื้อประมาณช่วงไหนครับ/คะ?','text_only',array['buying_timeline'],false,.8,50,true,'asher','buying_timeline'),
  ('all','คัดกรอง','financing','ถามการเงิน','สะดวกซื้อด้วยเงินสดหรือวางแผนขอสินเชื่อครับ/คะ?','text_only',array['financing_method'],false,.8,60,true,'asher','financing'),
  ('all','นัดชม','offer_visit','ชวนนัดชม','หากสะดวก ทางเรานัดเข้าชมโครงการให้ได้ครับ/ค่ะ สนใจวันไหนเป็นพิเศษไหม?','text_only',array['site_visit_intent','next_action'],false,.8,70,true,'asher','offer_visit'),
  ('all','ติดตาม','ask_contact','ขอช่องทางติดต่อ','หากสะดวก ขอเบอร์โทรหรือช่องทางที่ให้ฝ่ายขายติดต่อกลับได้ไหมครับ/คะ?','text_only',array['contact_permission','preferred_channel'],false,.8,80,true,'asher','ask_contact'),
  ('all','ติดตาม','followup_after_price','ติดตามหลังส่งราคา','ไม่ทราบว่าได้รับข้อมูลราคาแล้ว มีห้องหรือรายละเอียดส่วนไหนให้ช่วยเพิ่มเติมไหมครับ/คะ?','text_only',array['followup_status','objection'],false,.8,90,true,'asher','followup_after_price')
on conflict (project, shortcut) do update set
  category=excluded.category,
  title=excluded.title,
  body=excluded.body,
  send_order=excluded.send_order,
  intents=excluded.intents,
  bot_enabled=excluded.bot_enabled,
  confidence_min=excluded.confidence_min,
  sort_order=excluded.sort_order,
  active=excluded.active,
  source=excluded.source,
  source_shortcut=excluded.source_shortcut,
  updated_at=now();

commit;
