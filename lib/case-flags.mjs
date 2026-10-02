// ทะเบียน RPC ของ ติดดาว · การติดตาม · Tag · รายชื่อติดต่อ — ชื่อตรงกับ inbox.* ใน sql/2026100*_*.sql
// ยึดแบบ STATS_ACTIONS: ยิงด้วย token ของคนล็อกอิน ด่านสิทธิ์จริง (can_read, role, test_only)
// อยู่ในฟังก์ชันของฐาน ที่นี่กันแค่ไม่ให้เรียกฟังก์ชันนอกทะเบียน
// ★ ตัวช่วย inbox.flag_actor / flag_contact_of / flag_tags_of ตั้งใจไม่อยู่ในทะเบียน
export const FLAG_ACTIONS = new Set([
  'case_star', 'case_follow', 'case_tags_set', 'tags_list',
  'tag_upsert', 'tag_archive', 'case_flags', 'flag_list',
  // หน้ารายชื่อติดต่อ + drawer ลูกค้า (sql/202610021000_contacts_page.sql)
  'contacts_list', 'contact_detail',
])

// ทุกฟังก์ชันรับ (p jsonb) ตัวเดียว — tags_list ก็รับ p default '{}' เพื่อ signature เดียวกัน
export function flagRpc(action, data) {
  if (!FLAG_ACTIONS.has(action)) return null
  return { fn: action, body: { p: data && typeof data === 'object' && !Array.isArray(data) ? data : {} } }
}
