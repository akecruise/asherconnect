// =====================================================================
//  gid — Edge Function ชั่วคราวสำหรับหา LINE group id
//
//  ใช้ครั้งเดียวแล้วลบ: ตั้งเป็น Webhook URL ของ LINE ชั่วคราว
//  → พิมพ์อะไรก็ได้ในกลุ่ม → บอทตอบ groupId กลับเข้ากลุ่มทันที
//
//  ★ ต้องปิด "Verify JWT" ของฟังก์ชันนี้ ไม่งั้น LINE จะโดน 401
//  ★ ไม่แตะฐานข้อมูล ไม่แตะตารางใด ๆ อ่านอย่างเดียวแล้วตอบกลับ
// =====================================================================

const LINE_TOKEN = Deno.env.get("LINE_TOKEN") ?? Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";

async function reply(replyToken: string, text: string) {
  if (!LINE_TOKEN) { console.log("ไม่มี LINE_TOKEN — ตอบกลับเข้ากลุ่มไม่ได้ ดูค่าจาก log แทน"); return; }
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + LINE_TOKEN },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) console.log("reply ล้มเหลว:", res.status, await res.text());
}

Deno.serve(async (req) => {
  // เปิดด้วยเบราว์เซอร์เพื่อเช็กว่าฟังก์ชันเดินอยู่จริง
  if (req.method === "GET") {
    return new Response(
      "gid พร้อมทำงาน\n\n" +
      "1. เอา URL นี้ไปวางเป็น Webhook URL ใน LINE Developers Console\n" +
      "2. เปิดสวิตช์ Use webhook\n" +
      "3. พิมพ์อะไรก็ได้ในกลุ่ม LINE\n" +
      "4. บอทจะตอบ groupId กลับเข้ากลุ่ม\n\n" +
      "LINE_TOKEN: " + (LINE_TOKEN ? "ตั้งแล้ว (ตอบกลับเข้ากลุ่มได้)" : "ยังไม่ตั้ง (ดูค่าจาก Logs แทน)"),
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // ต้องตอบ 200 เสมอ ไม่ว่าข้างในจะเป็นอย่างไร
  // LINE ตัดสินว่า webhook ใช้ได้จากรหัสตอบกลับเท่านั้น
  try {
    const body = await req.json();
    const events = body?.events ?? [];
    console.log("EVENTS:", events.length);

    for (const ev of events) {
      const src = ev?.source ?? {};
      const gid = src.groupId ?? src.roomId ?? null;

      // พิมพ์ทุก event ลง Logs ไว้เป็นหลักฐาน แม้ตอบกลับไม่ได้
      console.log("GID CATCH:", JSON.stringify({
        type: ev?.type, sourceType: src.type, groupId: src.groupId ?? null,
        roomId: src.roomId ?? null, userId: src.userId ?? null,
      }));

      if (!gid || !ev?.replyToken) continue;

      const label = src.type === "room" ? "roomId" : "groupId";
      await reply(ev.replyToken,
        `นี่คือรหัสของห้องนี้\n\n${label}:\n${gid}\n\n` +
        `คัดลอกไปใส่ LINE_NOTIFY_GROUP_ID ได้เลยค่ะ`);
    }
  } catch (e) {
    console.log("อ่าน body ไม่ได้:", String(e));
  }

  return new Response("OK", { status: 200 });
});
