// ตั้งสถานะ "ซ่อนเมนู" ก่อนวาดหน้า — กันเมนูกางแล้วยุบให้เห็นกะพริบตอนโหลด
// ★ ต้องเป็นไฟล์แยก (CSP: script-src 'self' ห้าม inline) และโหลดแบบธรรมดาใน <head> ไม่ defer/module
// ★ localStorage ใช้ไม่ได้ (โหมดส่วนตัว/ถูกบล็อก) = ใช้ค่าเริ่มต้นคือกางเมนู ไม่ throw
try { if (localStorage.getItem('connect.nav.collapsed') === '1') document.documentElement.classList.add('nav-collapsed') } catch {}
