// ทดสอบว่า key ใช้ได้:  node scripts/test-claude.mjs
import { askClaude } from "../lib/claude.mjs";

try {
  const reply = await askClaude("ตอบสั้นๆ ว่า 'เชื่อมต่อสำเร็จ'", { maxTokens: 50 });
  console.log("OK:", reply);
} catch (err) {
  console.error("FAILED:", err.message);
  process.exit(1);
}
