// lib/claude.mjs — เรียก Claude API แบบไม่ต้องติดตั้ง SDK (ใช้ fetch ของ Node 18+)
// ต้องมี env: ANTHROPIC_API_KEY  (ไม่บังคับ: ANTHROPIC_MODEL)

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

/**
 * ถาม Claude แล้วได้ข้อความตอบกลับ
 * @param {string|Array} input  ข้อความ หรือ messages array [{role, content}]
 * @param {object} opts  { system, model, maxTokens, timeoutMs }
 * @returns {Promise<string>}
 */
export async function askClaude(input, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const {
    system,
    model = DEFAULT_MODEL,
    maxTokens = 1024,
    timeoutMs = 30000,
  } = opts;

  const messages = Array.isArray(input)
    ? input
    : [{ role: "user", content: String(input) }];

  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || res.statusText;
      throw new Error(`Claude API ${res.status}: ${msg}`);
    }

    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Claude API timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
