// Spin & Speak API — a small Cloudflare Worker that calls Google Gemini.
// The Gemini key stays here as a secret (GEMINI_API_KEY); the website never sees it.
// Endpoints:  POST /score   { topic, answer, targetSeconds, elapsedSeconds, words, wpm, fillers }
//             POST /topics  { prompt, count }
//             GET  /health

const MAX_ANSWER_CHARS = 6000;
const MAX_PROMPT_CHARS = 300;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://imvikv.github.io")
      .split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : allowed[0],
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, model: env.GEMINI_MODEL || "gemini-3.7-flash" });
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    if (!okOrigin) return json({ error: "forbidden_origin" }, 403);
    if (!env.GEMINI_API_KEY) return json({ error: "server_not_configured" }, 500);

    // Per-visitor limit (optional: needs the RATE_LIMITER binding in wrangler.toml)
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: "rate_limited" }, 429);
    }
    // Site-wide daily cap (optional: needs the USAGE KV binding)
    if (env.USAGE) {
      const day = new Date().toISOString().slice(0, 10);
      const key = "count:" + day;
      const n = parseInt((await env.USAGE.get(key)) || "0", 10);
      const cap = parseInt(env.DAILY_LIMIT || "300", 10);
      if (n >= cap) return json({ error: "daily_limit" }, 429);
      await env.USAGE.put(key, String(n + 1), { expirationTtl: 60 * 60 * 48 });
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

    let prompt;
    if (url.pathname === "/score") prompt = scorePrompt(body);
    else if (url.pathname === "/topics") prompt = topicsPrompt(body);
    else return json({ error: "not_found" }, 404);
    if (!prompt) return json({ error: "bad_input" }, 400);

    try {
      const result = await callGemini(env, prompt);
      return json(result);
    } catch (e) {
      const status = e.status === 429 ? 429 : 502;
      return json({ error: status === 429 ? "rate_limited" : "ai_error", detail: String(e.message || e).slice(0, 200) }, status);
    }
  },
};

async function callGemini(env, prompt) {
  const model = env.GEMINI_MODEL || "gemini-3.7-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
    }),
  });
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 150)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

const clean = (s, n) => String(s ?? "").replace(/"""/g, "'''").slice(0, n);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

function scorePrompt(b) {
  const answer = clean(b.answer, MAX_ANSWER_CHARS).trim();
  if (answer.split(/\s+/).length < 15) return null;
  const topic = clean(b.topic, MAX_PROMPT_CHARS) || "(no topic given; judge it as a free answer)";
  const fillers = b.fillers && typeof b.fillers === "object" ? JSON.stringify(b.fillers).slice(0, 300) : "{}";
  return `You are an experienced public-speaking and interview coach. Score this impromptu answer fairly and specifically. Be encouraging but honest; do not inflate scores.

TOPIC: ${topic}
TARGET TIME: ${num(b.targetSeconds)} seconds. TIME USED: ${num(b.elapsedSeconds)} seconds.
WORDS: ${num(b.words)}. PACE: ${b.wpm ? num(b.wpm) + " words per minute" : "unknown"}. FILLER WORDS DETECTED: ${fillers}.
NOTE: The answer may be a speech-to-text transcript, so ignore missing punctuation and capitalisation; judge the spoken language.

ANSWER:
"""${answer}"""

Score each of these from 0 to 10 (decimals allowed):
- grammar: correctness of sentences and tenses
- coherence: clear opening, logical structure, relevance to the topic, a conclusion
- confidence: assertiveness, persuasion, examples, conviction (avoid hedging)
- vocabulary: range and precision of words
- fluency: flow, sentence variety, pace (130-160 wpm is ideal when known), using the time well
- filler_words: 10 = no fillers or repetition, lower as fillers increase relative to length

Return ONLY JSON in exactly this shape:
{"scores":{"grammar":n,"coherence":n,"confidence":n,"vocabulary":n,"fluency":n,"filler_words":n},
"reasons":{"grammar":"max 12 words","coherence":"...","confidence":"...","vocabulary":"...","fluency":"...","filler_words":"..."},
"verdict":"one sentence overall summary, max 25 words",
"strengths":["2 to 3 specific strengths quoting their words where useful"],
"improvements":[{"area":"short name","issue":"what went wrong, specific to this answer","fix":"concrete thing to do next time"}],
"corrections":[{"original":"phrase from the answer","better":"improved phrase","why":"short reason"}],
"polished":"a rewritten version of their answer of similar length that keeps their ideas but has a hook, 2-3 clear points and a strong close",
"structure":"a one-line suggested structure for this topic, e.g. Point -> Reason -> Example -> Point",
"drill":"one short exercise to practise their weakest skill"}
Give 3 to 4 improvements, ordered by impact. Give 0 to 5 corrections (only real ones).`;
}

function topicsPrompt(b) {
  const q = clean(b.prompt, MAX_PROMPT_CHARS).trim();
  if (!q) return null;
  const count = [3, 5, 10].includes(num(b.count)) ? num(b.count) : 5;
  return `Generate ${count} varied impromptu speaking topics for this situation: """${q}""". Each should be answerable in 1-3 minutes without preparation, specific, and phrased as a question or prompt (max 22 words). Mix difficulty slightly. Return ONLY JSON: {"topics":[{"text":"...","tag":"1-2 word theme"}]}`;
}
