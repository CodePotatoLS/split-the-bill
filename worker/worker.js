/*
 * Split the Bill: receipt reader relay.
 * Holds your Gemini key so friends can scan without seeing it.
 *
 * Settings (Cloudflare dashboard → your Worker → Settings → Variables and Secrets):
 *   GEMINI_API_KEY   (Secret, required)  your key from Google AI Studio
 *   ALLOWED_ORIGINS  (Text, optional)    e.g. https://yourname.github.io
 *                                        Leave unset to allow any *.github.io page.
 *   MODEL            (Text, optional)    defaults to gemini-3.5-flash-lite
 */

const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest"];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const PER_IP_PER_HOUR = 60;

const PROMPT = [
  "This image is a photo of a shop or restaurant receipt. Extract every purchased line item.",
  "Reply with JSON only, matching the schema.",
  "store: the shop or restaurant name, or an empty string if unreadable.",
  "currency: the 3-letter ISO 4217 code of the currency on the receipt (for example AUD, JPY, EUR), or an empty string if you cannot tell.",
  "items: one entry per purchased line. name is the item's description; if a line is printed in two languages, use the English one.",
  "price is the total charged for that line with quantity already multiplied (for \"1 @ $14.00 = $14.00\" use 14.00), as a plain number without a currency symbol.",
  "If the quantity is above 1, prefix the name like \"2x Beer\".",
  "Notes and modifiers with no price of their own (for example \"Not Spicy\", \"No onion\") are not items.",
  "Discounts and vouchers are items with a negative price.",
  "Never include subtotal, total, GST/VAT summary, payment, card, cash, change or balance lines as items.",
  "tax: only tax that is added on top of the item prices. If the receipt says tax or GST is included in the total, tax is 0.",
  "tip: any tip, service charge or card surcharge added on top of the items, else 0.",
  "total: the final total printed on the receipt, or 0 if not shown."
].join(" ");

const SCHEMA = {
  type: "OBJECT",
  properties: {
    store: { type: "STRING" },
    currency: { type: "STRING" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { name: { type: "STRING" }, price: { type: "NUMBER" } },
        required: ["name", "price"]
      }
    },
    tax: { type: "NUMBER" },
    tip: { type: "NUMBER" },
    total: { type: "NUMBER" }
  },
  required: ["items"]
};

/* Best-effort per-IP limit. Resets when Cloudflare recycles the Worker, which is fine for a group of friends. */
const hits = new Map();
function overLimit(ip) {
  const now = Date.now(), hour = 3600e3;
  const list = (hits.get(ip) || []).filter((t) => now - t < hour);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_IP_PER_HOUR;
}

function originAllowed(origin, env) {
  if (!origin) return false;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (list.length) return list.includes(origin);
  return /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function reply(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
}

async function callGemini(model, key, mime, b64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA }
    })
  });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const ok = originAllowed(origin, env);
    const cors = ok
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" }
      : { Vary: "Origin" };

    if (req.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers: cors });
    if (req.method === "GET") return reply({ ok: true, service: "split-the-bill reader", keySet: !!env.GEMINI_API_KEY }, 200, cors);
    if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405, cors);
    if (!ok) return reply({ error: "origin_not_allowed" }, 403, cors);
    if (!env.GEMINI_API_KEY) return reply({ error: "no_key", message: "GEMINI_API_KEY is not set on the Worker." }, 500, cors);

    const ip = req.headers.get("CF-Connecting-IP") || "?";
    if (overLimit(ip)) return reply({ error: "rate_limited", message: "Too many scans from this device. Try again later." }, 429, cors);

    let body;
    try { body = await req.json(); } catch { return reply({ error: "bad_request" }, 400, cors); }
    const mime = String(body.mime || "image/jpeg");
    const b64 = String(body.image || "");
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(mime) || !b64) return reply({ error: "bad_image" }, 400, cors);
    if (b64.length * 0.75 > MAX_IMAGE_BYTES) return reply({ error: "too_large" }, 413, cors);

    const models = env.MODEL ? [env.MODEL, ...DEFAULT_MODELS.filter((m) => m !== env.MODEL)] : DEFAULT_MODELS;
    let last = null;
    for (const model of models) {
      let r;
      try { r = await callGemini(model, env.GEMINI_API_KEY, mime, b64); }
      catch { return reply({ error: "upstream_unreachable" }, 502, cors); }
      if (r.status === 404 || r.status === 400 && /model/i.test(await r.clone().text())) { last = r.status; continue; }
      if (r.status === 429) return reply({ error: "rate_limited", message: "The free Gemini quota is used up for now." }, 429, cors);
      if (r.status === 401 || r.status === 403) return reply({ error: "bad_key", message: "Gemini rejected the API key." }, 502, cors);
      if (!r.ok) return reply({ error: "upstream_error", status: r.status }, 502, cors);
      const data = await r.json();
      const cand = data.candidates && data.candidates[0];
      const text = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || "").join("") : "";
      if (!text) return reply({ error: "no_answer", reason: cand && cand.finishReason || data.promptFeedback && data.promptFeedback.blockReason || "" }, 502, cors);
      try {
        const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        return reply({ ...parsed, model }, 200, cors);
      } catch {
        return reply({ error: "invalid_json" }, 502, cors);
      }
    }
    return reply({ error: "no_model", message: "None of the Gemini models were available.", status: last }, 502, cors);
  }
};
