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
    if (url.pathname === "/health") return json({ ok: true, groq: !!env.GROQ_API_KEY, gemini: !!env.GEMINI_API_KEY, model: env.GROQ_API_KEY ? (env.GROQ_MODEL || "openai/gpt-oss-120b") : (env.GEMINI_MODEL || "gemini-3.7-flash") });
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    if (!okOrigin) return json({ error: "forbidden_origin" }, 403);
    if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) return json({ error: "server_not_configured" }, 500);

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

    // Speech-to-text: the page posts the raw recording; Groq Whisper returns the text
    if (url.pathname === "/transcribe") {
      try {
        const text = await transcribe(env, request, url.searchParams.get("lang") || "en");
        return json({ text });
      } catch (e) {
        return json({ error: e.status === 429 ? "rate_limited" : e.status === 413 ? "too_large" : "stt_error", detail: String(e.message || e).slice(0, 200) }, e.status === 429 ? 429 : e.status === 413 ? 413 : 502);
      }
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

    let prompt;
    if (url.pathname === "/score") prompt = scorePrompt(body);
    else if (url.pathname === "/topics") prompt = topicsPrompt(body);
    else return json({ error: "not_found" }, 404);
    if (!prompt) return json({ error: "bad_input" }, 400);

    try {
      const result = await callAI(env, prompt);
      return json(result);
    } catch (e) {
      const status = e.status === 429 ? 429 : 502;
      return json({ error: status === 429 ? "rate_limited" : "ai_error", detail: String(e.message || e).slice(0, 200) }, status);
    }
  },
};

const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // Groq free tier accepts up to 25 MB

async function transcribe(env, request, lang) {
  if (!env.GROQ_API_KEY) { const e = new Error("GROQ_API_KEY not set"); e.status = 500; throw e; }
  const type = (request.headers.get("Content-Type") || "audio/webm").split(";")[0];
  const audio = await request.arrayBuffer();
  if (audio.byteLength < 1000) { const e = new Error("recording too short"); e.status = 400; throw e; }
  if (audio.byteLength > MAX_AUDIO_BYTES) { const e = new Error("recording too large"); e.status = 413; throw e; }
  const ext = type.includes("mp4") || type.includes("m4a") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `answer.${ext}`);
  form.append("model", env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
  form.append("language", /^[a-z]{2}$/.test(lang) ? lang : "en");
  form.append("response_format", "json");
  form.append("temperature", "0");
  // A prompt with fillers nudges Whisper to keep "um", "uh", "like" so we can count them
  form.append("prompt", "Umm, so, uh, I think, like, you know, basically... Hmm.");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` }, body: form,
  });
  if (!res.ok) { const e = new Error(`Groq STT ${res.status}: ${(await res.text()).slice(0, 150)}`); e.status = res.status; throw e; }
  const data = await res.json();
  return String(data.text || "").trim();
}

// Groq first (fast); Gemini as a backup if Groq is busy or fails
async function callAI(env, prompt) {
  if (env.GROQ_API_KEY) {
    try { return await callGroq(env, prompt); }
    catch (e) { if (!env.GEMINI_API_KEY) throw e; }
  }
  return callGemini(env, prompt);
}

async function callGroq(env, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: env.GROQ_MODEL || "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.4,
      }),
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) { const e = new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 150)}`); e.status = res.status; throw e; }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

// Try the main Gemini model first; if it is busy (429/503), errors (5xx) or is too slow, try the fallback.
async function callGemini(env, prompt) {
  const models = [env.GEMINI_MODEL || "gemini-3.7-flash", env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite"];
  let lastErr;
  for (const model of [...new Set(models)]) {
    try { return await callModel(env, model, prompt); }
    catch (e) {
      lastErr = e;
      const retryable = e.name === "AbortError" || e.status === 429 || (e.status >= 500 && e.status < 600);
      if (!retryable) throw e;
    }
  }
  throw lastErr;
}

async function callModel(env, model, prompt, lowThinking = true) {
  const generationConfig = { responseMimeType: "application/json", temperature: 0.4 };
  if (lowThinking) generationConfig.thinkingConfig = { thinkingLevel: "low" }; // faster replies
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), parseInt(env.MODEL_TIMEOUT_MS || "25000", 10));
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const text = await res.text();
    // Some models don't accept thinkingLevel: retry once without it
    if (res.status === 400 && lowThinking && /thinking/i.test(text)) return callModel(env, model, prompt, false);
    const err = new Error(`Gemini ${model} ${res.status}: ${text.slice(0, 150)}`);
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
