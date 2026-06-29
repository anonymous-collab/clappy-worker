// ============================================
// CLAPPY WORKER v5.0
// Model: llama-3.3-70b-versatile (Groq)
// Fallback: Gemini 2.5 Flash (live search)
// Tools: TMDB (movies/TV), Wikipedia, NewsData
// ============================================

// ── Allowed origins ──────────────────────────
const PRODUCTION_ORIGINS = [
  'https://moviesupdate.online',
  'https://www.moviesupdate.online',
  'https://6a3d215c97aa7a78850f99bf--relaxed-kringle-570cc0.netlify.app',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (PRODUCTION_ORIGINS.includes(origin)) return true;
  // Any localhost port is fine for local dev (Acode changes port each session)
  if (/^http:\/\/localhost:\d+$/.test(origin)) return true;
  return false;
}

// ── API constants ─────────────────────────────
const GROQ_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL    = 'llama-3.3-70b-versatile';
const GEMINI_URL    = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const TMDB_BASE     = 'https://api.themoviedb.org/3';
const WIKI_URL      = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const NEWS_URL      = 'https://newsdata.io/api/1/latest';
const FIREBASE_BASE = 'https://moviesupdate-e2ec9-default-rtdb.firebaseio.com';

// ── Cache TTLs (seconds) ──────────────────────
// Details: 1 day — recent films update frequently on TMDB
// News: 1 hour — must stay fresh
// Search/recommend/trending: 3 days
const TTL_DETAIL   = 86400;
const TTL_NEWS     = 3600;
const TTL_GENERAL  = 259200;

// ── Rate limit ────────────────────────────────
const RATE_MAX    = 20;   // requests
const RATE_WINDOW = 60;   // seconds

// ============================================
// TOOL DEFINITIONS
//
// IMPORTANT DESIGN NOTES:
// - "details" is the correct type for ANY query
//   asking about a specific title. The model must
//   use details, not search, for "tell me about X".
// - Tool descriptions are the model's instructions.
//   They must be unambiguous and leave no room for
//   the model to choose the wrong type.
// - search_wikipedia is complementary to search_movies
//   for biographical or historical context.
// ============================================
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_movies',
      description: `Search TMDB for movie and TV show data.

TYPE SELECTION — pick exactly one:
• "details" → Use when the user asks about a SPECIFIC title: "what is X about", "tell me about X", "who is in X", "is X good", "when did X come out", "X review". This returns full plot, cast, director, genres, runtime, rating.
• "search"  → Use when the user mentions a title but wants a quick lookup or you are not sure it exists yet.
• "recommend" → Use when the user wants movies similar to a title they mention.
• "trending" → Use when the user asks what is popular, trending, or new right now.

NEVER use "search" when "details" is appropriate. If the user is asking about a specific known title, always use "details".`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The movie or TV show title, actor, director, or genre. Must be a real concrete term — not a pronoun like "it" or "that".'
          },
          type: {
            type: 'string',
            enum: ['details', 'search', 'recommend', 'trending'],
            description: 'The query type. See tool description for which to use.'
          }
        },
        required: ['query', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_news',
      description: 'Get latest entertainment news, box office results, release announcements, casting news, and awards coverage. Use when the user asks about recent news, what is happening with a film or person, or industry updates.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The news search topic — a title, person, or event. Must be specific and non-empty.'
          },
          category: {
            type: 'string',
            enum: ['hollywood', 'anime', 'indian', 'general'],
            description: 'Entertainment category to search within.'
          }
        },
        required: ['query', 'category']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_wikipedia',
      description: 'Get biographical or historical background on a filmmaker, actor, franchise, or film movement. Use when the user asks "who is", "who was", "tell me about [person]", or needs context beyond what TMDB provides.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Person, film, or topic to look up. Must be a specific named subject.'
          }
        },
        required: ['query']
      }
    }
  }
];

// ============================================
// SYSTEM PROMPT
// ============================================
function buildSystemPrompt(sessionMemory) {
  const now         = new Date();
  const dateStr     = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const currentYear = now.getFullYear();

  const memoryBlock = sessionMemory
    ? `\n\nUSER SESSION CONTEXT (use naturally — never say "I see you like" or "based on your preferences"):
- Liked genres: ${(sessionMemory.liked_genres || []).join(', ') || 'none recorded'}
- Disliked genres: ${(sessionMemory.disliked_genres || []).join(', ') || 'none'}
- Recently mentioned: ${(sessionMemory.recent_titles || []).slice(-5).join(', ') || 'none'}`
    : '';

  return `You are Clappy — a knowledgeable, passionate movie companion on MoviesUpdate. Think of yourself as that friend who has seen everything, remembers everything, and makes talking about movies genuinely enjoyable.

TODAY: ${dateStr} | CURRENT YEAR: ${currentYear}
Your training knowledge ends around August 2025. For anything after that — ${currentYear} releases, recent news, new casting — the tool data you receive is the source of truth. Always trust tool data over your memory.

━━━ HOW TO USE TOOLS ━━━

You have three tools. Use them silently — never announce that you are about to search or that you are looking something up. The user asked a question; answer it.

RULE: For any query about a specific movie or TV show title, call search_movies with type="details". This is the most important rule. "Tell me about X", "what is X about", "who is in X", "is X good", "when does X come out" — all of these are "details" queries.

RULE: NEVER answer a specific title query from memory alone if you can call the tool. Your memory can be wrong (wrong cast, wrong plot, wrong dates). The tool data is accurate.

RULE: After getting tool results, use ALL the relevant data. If you received overview, cast, director, genres, runtime — work them into your response naturally. Do not just read back the release date and stop.

RULE: If tool results come back empty and the title is recent (post-2025), say something like: "My data on that one is still loading in — try the search bar for the latest." If it is an older title with empty results, you may answer from your training knowledge but flag that it might not be fully accurate.

━━━ HOW TO RESPOND ━━━

When answering a "tell me about [movie]" query, your response should naturally cover:
1. What kind of film it is (genre, year, director if notable)
2. What it is actually about — describe the plot in 2-3 sentences in your own words
3. Key cast — mention at least 2-3 names if available
4. Whether it is worth watching — give a real opinion using the rating as one signal
5. Optionally: one follow-up offer ("Want recommendations in the same vein?")

Personality balance: you are warm and enthusiastic about cinema, but the substance always comes first. Never pad a response with filler before getting to the point. Never pad with filler after the point has been made.

━━━ HARD RULES ━━━

NEVER do any of these:
• Invent cast, plot details, directors, or ratings that were not in tool data
• Say "Let me check that", "Let me look that up", "I'm on it", or any variation — just answer
• Output [cite], [1], JSON, markdown bold (**), or any technical markup
• Say "my training data", "my knowledge cutoff", "as an AI", "I am a language model"
• Say "I found...", "Based on...", "Here are some...", "Great question!", "Certainly!"
• Say "Feel free to ask", "Don't hesitate", "I hope that helps"
• Ask more than one follow-up question per reply

UNRELEASED FILMS: If tool data shows released=false, say so naturally: "It is not out yet — scheduled for [date/month]."

━━━ RECOMMENDATION FORMAT ━━━
When listing multiple films (only when actually listing):
🎬 Title (Year) ⭐ Rating/10
One sentence — what makes this one the right pick for what they asked

Give exactly 5 unless asked for more or fewer.

━━━ GREETING ━━━
One warm sentence, one emoji max. Vary the wording every time. Never start with "Hey there!" — be more creative.${memoryBlock}`;
}

// ============================================
// TOOL EXECUTORS
// ============================================
async function executeTool(name, args, env) {
  if (name === 'search_movies')    return toolMovies(args, env);
  if (name === 'search_news')      return toolNews(args, env);
  if (name === 'search_wikipedia') return toolWikipedia(args);
  return { error: 'Unknown tool: ' + name };
}

// ── TMDB ─────────────────────────────────────
async function toolMovies(args, env) {
  const { query, type } = args;
  if (!env.TMDB_KEY) return { error: 'TMDB key not configured' };

  const cacheKey = `v5_tmdb_${type}_${query.toLowerCase().replace(/\W+/g, '_')}`;
  const cached   = await cacheGet(cacheKey, env);
  if (cached) return cached;

  const p   = `api_key=${env.TMDB_KEY}&language=en-US`;
  const now = new Date();

  // ── DETAILS: full movie/TV info with cast ──
  if (type === 'details') {
    // Try movie search first, then TV
    let detailData = null;
    let mediaType  = 'movie';

    const movieSearch = await safeFetch(`${TMDB_BASE}/search/movie?${p}&query=${enc(query)}`);
    if (movieSearch?.results?.[0]) {
      const id   = movieSearch.results[0].id;
      detailData = await safeFetch(`${TMDB_BASE}/movie/${id}?${p}&append_to_response=credits`);
      mediaType  = 'movie';
    }

    if (!detailData?.id) {
      const tvSearch = await safeFetch(`${TMDB_BASE}/search/tv?${p}&query=${enc(query)}`);
      if (tvSearch?.results?.[0]) {
        const id   = tvSearch.results[0].id;
        detailData = await safeFetch(`${TMDB_BASE}/tv/${id}?${p}&append_to_response=credits`);
        mediaType  = 'tv';
      }
    }

    if (!detailData?.id) return { results: [], source: 'tmdb', message: 'Title not found on TMDB' };

    const releaseDate = detailData.release_date || detailData.first_air_date || '';
    const cast        = (detailData.credits?.cast  || []).slice(0, 7).map(c => c.name).join(', ');
    const director    = (detailData.credits?.crew  || []).find(c => c.job === 'Director')?.name || '';
    const genres      = (detailData.genres         || []).map(g => g.name).join(', ');
    const creators    = (detailData.created_by     || []).map(c => c.name).join(', ');

    const result = {
      results: [{
        title:        detailData.title || detailData.name || '',
        year:         releaseDate.slice(0, 4),
        release_date: releaseDate,
        released:     releaseDate ? new Date(releaseDate) <= now : true,
        rating:       detailData.vote_average ? Number(detailData.vote_average).toFixed(1) : null,
        vote_count:   detailData.vote_count || 0,
        overview:     (detailData.overview   || '').slice(0, 600),
        tagline:      detailData.tagline     || '',
        genres,
        director:     director || creators,
        cast,
        runtime:      detailData.runtime || detailData.episode_run_time?.[0] || null,
        type:         mediaType,
        status:       detailData.status || '',
      }],
      source: 'tmdb'
    };

    await cacheSet(cacheKey, result, TTL_DETAIL, env);
    return result;
  }

  // ── TRENDING ──────────────────────────────
  if (type === 'trending') {
    const data = await safeFetch(`${TMDB_BASE}/trending/all/week?${p}`);
    const results = buildBasicResults(data?.results || [], now);
    const result  = { results, source: 'tmdb' };
    await cacheSet(cacheKey, result, TTL_GENERAL, env);
    return result;
  }

  // ── RECOMMEND ─────────────────────────────
  if (type === 'recommend') {
    const search = await safeFetch(`${TMDB_BASE}/search/movie?${p}&query=${enc(query)}`);
    const first  = search?.results?.[0];
    if (!first) return { results: [], source: 'tmdb', message: 'No matching title found for recommendations' };

    const data    = await safeFetch(`${TMDB_BASE}/movie/${first.id}/recommendations?${p}`);
    const results = buildBasicResults(data?.results || [], now);
    const result  = { results, source: 'tmdb' };
    await cacheSet(cacheKey, result, TTL_GENERAL, env);
    return result;
  }

  // ── SEARCH (general) ─────────────────────
  const data    = await safeFetch(`${TMDB_BASE}/search/multi?${p}&query=${enc(query)}`);
  const results = buildBasicResults(data?.results || [], now);
  const result  = { results, source: 'tmdb' };
  await cacheSet(cacheKey, result, TTL_GENERAL, env);
  return result;
}

function buildBasicResults(items, now) {
  return items.slice(0, 8).map(m => {
    const rd = m.release_date || m.first_air_date || '';
    return {
      title:        m.title || m.name || '',
      year:         rd.slice(0, 4),
      release_date: rd,
      released:     rd ? new Date(rd) <= now : true,
      rating:       m.vote_average ? Number(m.vote_average).toFixed(1) : null,
      overview:     (m.overview || '').slice(0, 300),
      type:         m.media_type || 'movie'
    };
  });
}

// ── NewsData ─────────────────────────────────
async function toolNews(args, env) {
  const { query, category } = args;
  if (!env.NEWS_KEY) return { error: 'NewsData key not configured' };

  const cacheKey = `v5_news_${category}_${query.toLowerCase().replace(/\W+/g, '_')}`;
  const cached   = await cacheGet(cacheKey, env);
  if (cached) return cached;

  const url  = `${NEWS_URL}?apikey=${env.NEWS_KEY}&q=${enc(query)}&language=en&category=entertainment`;
  const data = await safeFetch(url);

  const results = (data?.results || []).slice(0, 5).map(a => ({
    title:       a.title       || '',
    description: (a.description || '').slice(0, 250),
    source:      a.source_id   || '',
    date:        a.pubDate     || ''
  }));

  const result = { results, source: 'newsdata' };
  await cacheSet(cacheKey, result, TTL_NEWS, env);
  return result;
}

// ── Wikipedia ────────────────────────────────
async function toolWikipedia(args) {
  const { query } = args;
  const data = await safeFetch(`${WIKI_URL}/${enc(query)}`);
  if (!data?.extract) return { error: 'Not found on Wikipedia', source: 'wikipedia' };

  const summary = (data.extract || '')
    .replace(/\[\d+\]/g, '')
    .slice(0, 800);

  return { title: data.title || query, summary, source: 'wikipedia' };
}

// ============================================
// FIREBASE CACHE
// ============================================
async function cacheGet(key, env) {
  try {
    const safeKey = key.replace(/[.#$/\[\]]/g, '_');
    const data    = await firebaseGet(`query_cache/${safeKey}`, env);
    if (!data) return null;
    if (data.expires_at && Date.now() > data.expires_at) {
      firebaseDelete(`query_cache/${safeKey}`, env).catch(() => {});
      return null;
    }
    return data.value;
  } catch { return null; }
}

async function cacheSet(key, value, ttlSeconds, env) {
  try {
    const safeKey = key.replace(/[.#$/\[\]]/g, '_');
    await firebasePut(`query_cache/${safeKey}`, {
      value,
      expires_at: Date.now() + (ttlSeconds * 1000)
    }, env);
  } catch { /* non-fatal — continue without caching */ }
}

async function firebaseGet(path, env) {
  const token = env.FIREBASE_SECRET;
  const url   = `${FIREBASE_BASE}/${path}.json${token ? `?auth=${token}` : ''}`;
  const res   = await safeFetchRaw(url);
  if (!res?.ok) return null;
  return res.json();
}

async function firebasePut(path, data, env) {
  const token = env.FIREBASE_SECRET;
  const url   = `${FIREBASE_BASE}/${path}.json${token ? `?auth=${token}` : ''}`;
  return safeFetchRaw(url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data)
  });
}

async function firebaseDelete(path, env) {
  const token = env.FIREBASE_SECRET;
  const url   = `${FIREBASE_BASE}/${path}.json${token ? `?auth=${token}` : ''}`;
  return safeFetchRaw(url, { method: 'DELETE' });
}

// ============================================
// RATE LIMITING
// ============================================
async function checkRateLimit(ip, env) {
  try {
    const key  = `rate_${ip.replace(/[.:#]/g, '_')}`;
    const data = await firebaseGet(`rate_limits/${key}`, env);
    const now  = Date.now();

    if (data && (now - data.window_start) < (RATE_WINDOW * 1000)) {
      if (data.count >= RATE_MAX) return false;
      firebasePut(`rate_limits/${key}`, {
        count: data.count + 1, window_start: data.window_start
      }, env).catch(() => {});
    } else {
      firebasePut(`rate_limits/${key}`, {
        count: 1, window_start: now
      }, env).catch(() => {});
    }
    return true;
  } catch { return true; /* fail open */ }
}

// ============================================
// FETCH HELPERS
// ============================================

// Returns parsed JSON or null — never throws
async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// Returns raw Response or null — never throws
async function safeFetchRaw(url, options = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch { return null; }
}

// Groq/Gemini need longer timeouts (LLM latency)
async function llmFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch { return null; }
}

function enc(str) { return encodeURIComponent(str); }

// ============================================
// RESPONSE CLEANUP
// Strips markdown/citation artifacts that
// sometimes leak through from the LLM output
// ============================================
function cleanResponse(text) {
  if (!text) return '';
  return text
    // Complete citation blocks e.g. [cite: 1, 2]
    .replace(/\[cite:\s*[\d,\s]+\]/gi, '')
    // Partial/truncated [cite at end of response
    .replace(/\[cite[^\]]*$/gi, '')
    // Numeric citations [1] [2,3]
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    // Tool call artifacts
    .replace(/<function[\s\S]*?<\/function>/gi, '')
    .replace(/\{["']?(?:query|function)["']?:[\s\S]*?\}/g, '')
    // Bold markdown **text** → text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // Bullet * at start of line → remove marker only
    .replace(/(^|\n)\s*\*\s+/g, '$1')
    // Collapse extra whitespace
    .replace(/  +/g, ' ')
    .trim();
}

// ============================================
// GEMINI FALLBACK
// Used when Groq fails, tool results are empty,
// or a tool_use_failed 400 is returned.
// Gemini has live Google Search — good for
// very recent titles Groq doesn't know about.
// ============================================
async function geminiFallback(messages, env) {
  if (!env.GEMINI_API_KEY) {
    return "Something went sideways — give it another shot! 🎬";
  }

  // Build a readable prompt from the conversation
  const prompt = messages
    .filter(m => m.role !== 'system')
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const res = await llmFetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 600 }
    })
  });

  if (!res?.ok) return "Something went sideways — give it another shot! 🎬";

  const data = await res.json().catch(() => null);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return cleanResponse(text) || "Something went sideways — give it another shot! 🎬";
}

// ============================================
// TOOL CALL VALIDATOR
// Checks that the model filled all required
// fields before we attempt to execute the tool.
// Malformed calls cause 400s from Groq.
// ============================================
function validateToolCall(tc) {
  try {
    if (!tc?.function?.name)      return false;
    if (!tc?.function?.arguments) return false;
    const args    = JSON.parse(tc.function.arguments);
    const toolDef = TOOLS.find(t => t.function.name === tc.function.name);
    if (!toolDef) return false;
    const required = toolDef.function.parameters.required || [];
    return required.every(r => args[r] !== undefined && args[r] !== null && String(args[r]).trim() !== '');
  } catch { return false; }
}

// ============================================
// TOOL RESULT VALIDATOR
// Checks that at least one tool returned
// useful data before we pass it to the LLM.
// ============================================
function hasUsefulResults(toolResults) {
  for (const r of toolResults) {
    try {
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      if (parsed.error) continue;
      if (Array.isArray(parsed.results) && parsed.results.length > 0) return true;
      if (parsed.summary) return true;
    } catch { continue; }
  }
  return false;
}

// ============================================
// PURE GREETING DETECTOR
// Only messages that are literally just a
// greeting with zero content skip tool calls.
// Everything else — including "hi, tell me
// about X" — gets tools.
// ============================================
const PURE_GREETING = /^(hi+|hello|hey|yo|sup|hiya|greetings|howdy|thanks?|thank\s*you|ty|thx|lol|lmao|haha|ok+|okay|cool|nice|great|wow|sure|yep|nope|bye|cya|k|👍|🙏|😊)[\s!?.]*$/i;

function isPureGreeting(msg) {
  return PURE_GREETING.test(msg.trim());
}

// ============================================
// GROQ API CALLER
// Shared helper to keep orchestrate() clean.
// Returns { ok, data, error }
// ============================================
async function callGroq(body, env) {
  const res = await llmFetch(GROQ_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${env.GROQ_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!res) return { ok: false, error: 'network' };

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: text.includes('tool_use_failed') ? 'tool_fail' : 'http', status: res.status, text };
  }

  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, error: 'parse' };

  return { ok: true, data };
}

// ============================================
// MAIN ORCHESTRATION
//
// Flow:
// 1. Send message to Groq with tools available
// 2a. If Groq returns tool calls → validate → execute → send results back → get final answer
// 2b. If Groq returns direct text → return it
// 3. On any Groq failure → Gemini fallback
// ============================================
async function orchestrate(userMessage, sessionMemory, history, env) {
  const systemPrompt = buildSystemPrompt(sessionMemory);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: userMessage }
  ];

  const useTools     = !isPureGreeting(userMessage);
  const toolPayload  = useTools ? { tools: TOOLS, tool_choice: 'auto' } : {};

  // ── Step 1: Initial Groq call ────────────
  const step1 = await callGroq({
    model:       GROQ_MODEL,
    messages,
    max_tokens:  800,
    temperature: 0.72,
    ...toolPayload
  }, env);

  // If Groq failed entirely → Gemini
  if (!step1.ok) {
    // On tool_use_failed, retry without tools before falling to Gemini
    if (step1.error === 'tool_fail') {
      const retry = await callGroq({
        model: GROQ_MODEL, messages, max_tokens: 700, temperature: 0.72
      }, env);
      if (retry.ok) {
        const text = retry.data.choices?.[0]?.message?.content;
        if (text) return cleanResponse(text);
      }
    }
    return geminiFallback(messages, env);
  }

  const assistantMsg = step1.data.choices?.[0]?.message;
  if (!assistantMsg) return geminiFallback(messages, env);

  const allCalls   = assistantMsg.tool_calls || [];
  const validCalls = allCalls.filter(validateToolCall);

  // ── No tool calls → direct reply ─────────
  if (validCalls.length === 0) {
    // If model tried tools but ALL were invalid → retry without tools
    if (allCalls.length > 0) {
      const retry = await callGroq({
        model: GROQ_MODEL, messages, max_tokens: 700, temperature: 0.72
      }, env);
      if (retry.ok) {
        const text = retry.data.choices?.[0]?.message?.content;
        if (text) return cleanResponse(text);
      }
      return geminiFallback(messages, env);
    }

    // Genuine direct reply
    const direct = assistantMsg.content;
    if (direct) return cleanResponse(direct);
    return geminiFallback(messages, env);
  }

  // ── Step 2: Execute valid tool calls ─────
  const toolResults = await Promise.all(validCalls.map(async tc => {
    try {
      const args   = JSON.parse(tc.function.arguments);
      const result = await executeTool(tc.function.name, args, env);
      return {
        tool_call_id: tc.id,
        role:         'tool',
        name:         tc.function.name,
        content:      JSON.stringify(result)
      };
    } catch (err) {
      return {
        tool_call_id: tc.id,
        role:         'tool',
        name:         tc.function.name,
        content:      JSON.stringify({ error: err.message || 'Tool execution failed' })
      };
    }
  }));

  // Check if tool results are useful
  const parsedResults = toolResults.map(r => {
    try { return JSON.parse(r.content); } catch { return {}; }
  });

  if (!hasUsefulResults(parsedResults)) {
    // Tools returned nothing useful — fall to Gemini (has live search)
    return geminiFallback(messages, env);
  }

  // ── Step 3: Final Groq call with tool data
  const finalMessages = [
    ...messages,
    assistantMsg,
    ...toolResults
  ];

  const step3 = await callGroq({
    model:       GROQ_MODEL,
    messages:    finalMessages,
    max_tokens:  800,
    temperature: 0.72
  }, env);

  if (!step3.ok) return geminiFallback(messages, env);

  const finalText = step3.data.choices?.[0]?.message?.content;
  if (!finalText)  return geminiFallback(messages, env);

  return cleanResponse(finalText);
}

// ============================================
// CORS HELPERS
// ============================================
function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return isAllowedOrigin(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonRes(data, status = 200, origin = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(data), { status, headers });
}

// ============================================
// CLOUDFLARE WORKER ENTRY POINT
// ============================================
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = getAllowedOrigin(request);

    // Preflight
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response('Forbidden', { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health check
    if (request.method === 'GET' && url.pathname === '/') {
      return jsonRes({ status: 'Clappy v5.0 🎬', ok: true }, 200, origin);
    }

    // Main chat endpoint
    if (request.method === 'POST' && url.pathname === '/') {
      if (!origin) return jsonRes({ error: 'Forbidden' }, 403, null);

      // Rate limit
      const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await checkRateLimit(ip, env);
      if (!allowed) {
        return jsonRes({ error: 'Too many requests — slow down a little.' }, 429, origin);
      }

      // Parse body
      let body;
      try { body = await request.json(); }
      catch { return jsonRes({ error: 'Invalid JSON body' }, 400, origin); }

      const { messages, sessionMemory } = body;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return jsonRes({ error: 'messages array is required' }, 400, origin);
      }

      const userMessage = messages[messages.length - 1]?.content?.trim();
      if (!userMessage) return jsonRes({ error: 'Empty message' }, 400, origin);

      // History is everything except the last (current) message
      const history = messages.slice(0, -1).map(m => ({
        role: m.role, content: m.content
      }));

      try {
        const reply = await orchestrate(userMessage, sessionMemory || null, history, env);
        return jsonRes({ reply }, 200, origin);
      } catch {
        return jsonRes({
          reply: "Something went sideways on my end — give it another shot! 🎬"
        }, 200, origin);
      }
    }

    return jsonRes({ error: 'Not found' }, 404, origin);
  }
}; 
