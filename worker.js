// ============================================
// CLAPPY WORKER v5.1
// Model:    llama-3.3-70b-versatile (Groq)
// Fallback: Gemini 2.5 Flash (live search)
// Tools:    TMDB · Wikipedia · NewsData
// Memory:   Session-only (no Firebase storage)
// Cache:    None — all data fetched live
// Firebase: Rate limiting only
// ============================================

// ── Allowed origins ──────────────────────────
const PRODUCTION_ORIGINS = [
  'https://moviesupdate.online',
  'https://www.moviesupdate.online',
  '‎https://6a3d215c97aa7a78850f99bf--relaxed-kringle-570cc0.netlify.app',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (PRODUCTION_ORIGINS.includes(origin)) return true;
  // Any localhost port — Acode changes port each session
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

// ── Rate limit ────────────────────────────────
const RATE_MAX    = 20;  // max requests
const RATE_WINDOW = 60;  // per seconds

// ── Context window ────────────────────────────
// Max messages to keep in full before compressing
const MAX_FULL_HISTORY = 10;

// ============================================
// TOOL DEFINITIONS
// ============================================
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_movies',
      description: `Search TMDB for movie and TV show data.

TYPE SELECTION — choose exactly one:
• "details"   → Use when the user asks about a SPECIFIC title: "what is X about", "tell me about X", "who is in X", "is X good", "is X worth watching", "when did X come out". Returns full plot, cast, director, genres, runtime, rating.
• "search"    → Use when the user mentions a title but you are not sure it exists or want a quick lookup.
• "recommend" → Use when the user wants movies similar to something they mention.
• "trending"  → Use when the user asks what is popular, new, or trending right now.

CRITICAL: Always use "details" for specific title queries. Never use "search" when the user is clearly asking about a known title.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The movie/TV title, actor, director, or genre. Must be a concrete specific term — never a pronoun like "it" or "that".'
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
            description: 'Entertainment category.'
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
      description: 'Get biographical or historical background on a filmmaker, actor, franchise, or film movement. Use when the user asks "who is", "who was", "tell me about [person]", or needs context beyond TMDB.',
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
// Kept full and intact — do not trim.
// The banned phrases list and emotional
// intelligence sections are essential.
// ============================================
function buildSystemPrompt() {
  const now         = new Date();
  const dateStr     = now.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  const currentYear = now.getFullYear();

  return `You are Clappy — a knowledgeable, passionate movie companion on MoviesUpdate. Think of yourself as that friend who has seen everything, remembers everything, and makes talking about movies genuinely enjoyable.

TODAY: ${dateStr} | CURRENT YEAR: ${currentYear}
Your training knowledge ends around early 2024. For anything after that — ${currentYear} releases, recent news, new casting, anything post-2024 — the tool data you receive is the source of truth. Always trust tool data over your own memory. Do not guess or fill in details from memory for titles released after 2024.

━━━ HOW TO USE TOOLS ━━━

You have three tools. Use them silently — never announce that you are about to search or that you are looking something up. The user asked a question; answer it.

RULE: For any query about a specific movie or TV show title, call search_movies with type="details". This is the most important rule. "Tell me about X", "what is X about", "who is in X", "is X good", "is X worth watching", "when does X come out" — all of these are "details" queries.

RULE: NEVER answer a specific title query from memory alone. Your memory can be wrong (wrong cast, wrong plot, wrong dates). The tool data is accurate.

RULE: After getting tool results, use ALL the relevant data — plot, cast, director, genres, runtime, rating. Work them into your response naturally. Do not just read back the release date and stop.

RULE: If tool results come back empty for any title, do not attempt to answer from your own memory — especially for anything post-2024 where your knowledge is unreliable. The system will automatically retry with a more current source silently. Do not say anything about checking or waiting — the reroute happens invisibly and the user will receive the answer directly.

HYBRID SENTENCES: If a message combines a casual opener with a movie query — like "Hey, is Interstellar worth watching?" or "ok so what can you tell me about Dune" — treat it as a movie query and answer the movie part. Do not get stuck on the greeting.

━━━ HOW TO RESPOND ━━━

When answering a "tell me about [movie]" query, naturally cover:
1. What kind of film it is (genre, year, director if notable)
2. What it is actually about — describe the plot in 2-3 sentences in your own words
3. Key cast — mention at least 2-3 names if available
4. Whether it is worth watching — give a real opinion, use the rating as one signal
5. Optionally: one follow-up offer ("Want recommendations in the same vein?")

Personality balance: 70% substance, 30% personality. You are warm and enthusiastic about cinema, but the substance always comes first. Never pad a response with filler before or after the point.

CONVERSATION FLOW: You remember everything discussed in this session. If the user says "what about that director?" after discussing a film, you know which director they mean. Use session context naturally.

OPINIONS: Have them. "Is X worth watching?" — give a real answer, not "it depends on your taste." Pick a side based on the data and your knowledge.

━━━ HARD RULES ━━━

NEVER do any of these:
• Invent cast, plot details, directors, or ratings not in tool data
• Say "Let me check that", "Let me look that up", "I'm on it", "I'm buzzing to share", "Let me find that" — just answer
• Output [cite], [1], JSON, markdown bold (**text**), bullet asterisks (* item), or any technical markup
• Say "my training data", "my knowledge cutoff", "as an AI", "I am a language model"
• Say "I found...", "Based on...", "Here are some...", "Great question!", "Certainly!", "Absolutely!"
• Say "Feel free to ask", "Don't hesitate", "I hope that helps", "my data is still loading", "try the search bar"
• Ask more than one follow-up question per reply

UNRELEASED FILMS: If tool data shows released=false, say naturally: "Not out yet — scheduled for [date/month]."

━━━ RECOMMENDATION FORMAT ━━━
When listing multiple films:
🎬 Title (Year) ⭐ Rating/10
One sentence — what makes this the right pick for what they asked

Give exactly 5 unless asked for more or fewer.

━━━ GREETING ━━━
One warm sentence, one emoji max. Vary the wording each time. Be creative — never start with "Hey there!" or "I'm Clappy".`;
}

// ============================================
// CONTEXT WINDOW MANAGER
//
// Keeps last MAX_FULL_HISTORY messages in full.
// If history exceeds that, compresses older
// messages into a single summary line so Clappy
// retains session context without token bloat.
// Nothing is stored anywhere — purely in-memory
// for this single request.
// ============================================
function buildContextWindow(history) {
  if (history.length <= MAX_FULL_HISTORY) {
    return history;
  }

  // Split: older messages get summarized, recent ones kept in full
  const older  = history.slice(0, history.length - MAX_FULL_HISTORY);
  const recent = history.slice(-MAX_FULL_HISTORY);

  // Build a one-line summary of older messages
  // Extract topic keywords — titles, genres, questions mentioned
  const olderTopics = older
    .filter(m => m.role === 'user')
    .map(m => m.content.slice(0, 60).trim())
    .join(' | ');

  const summaryMessage = {
    role: 'system',
    content: `Earlier in this session the user discussed: ${olderTopics}. Use this context naturally if relevant.`
  };

  return [summaryMessage, ...recent];
}

// ============================================
// TOOL EXECUTORS
// All fetches are live — no caching anywhere.
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

  const p   = `api_key=${env.TMDB_KEY}&language=en-US`;
  const now = new Date();

  // ── DETAILS: full movie/TV info + cast ────
  if (type === 'details') {
    let detailData = null;
    let mediaType  = 'movie';

    // Try movie first
    const movieSearch = await safeFetch(
      `${TMDB_BASE}/search/movie?${p}&query=${enc(query)}`
    );
    if (movieSearch?.results?.[0]) {
      const id   = movieSearch.results[0].id;
      detailData = await safeFetch(
        `${TMDB_BASE}/movie/${id}?${p}&append_to_response=credits`
      );
      mediaType = 'movie';
    }

    // Fall back to TV if no movie found
    if (!detailData?.id) {
      const tvSearch = await safeFetch(
        `${TMDB_BASE}/search/tv?${p}&query=${enc(query)}`
      );
      if (tvSearch?.results?.[0]) {
        const id   = tvSearch.results[0].id;
        detailData = await safeFetch(
          `${TMDB_BASE}/tv/${id}?${p}&append_to_response=credits`
        );
        mediaType = 'tv';
      }
    }

    if (!detailData?.id) {
      return { results: [], source: 'tmdb', message: 'Title not found on TMDB' };
    }

    const releaseDate = detailData.release_date || detailData.first_air_date || '';
    const cast        = (detailData.credits?.cast  || [])
      .slice(0, 7)
      .map(c => c.name)
      .join(', ');
    const director    = (detailData.credits?.crew  || [])
      .find(c => c.job === 'Director')?.name || '';
    const creators    = (detailData.created_by     || [])
      .map(c => c.name).join(', ');
    const genres      = (detailData.genres         || [])
      .map(g => g.name).join(', ');

    return {
      results: [{
        title:        detailData.title || detailData.name || '',
        year:         releaseDate.slice(0, 4),
        release_date: releaseDate,
        released:     releaseDate ? new Date(releaseDate) <= now : true,
        rating:       detailData.vote_average
                        ? Number(detailData.vote_average).toFixed(1)
                        : null,
        vote_count:   detailData.vote_count  || 0,
        overview:     (detailData.overview   || '').slice(0, 600),
        tagline:      detailData.tagline     || '',
        genres,
        director:     director || creators,
        cast,
        runtime:      detailData.runtime
                        || detailData.episode_run_time?.[0]
                        || null,
        type:         mediaType,
        status:       detailData.status      || '',
      }],
      source: 'tmdb'
    };
  }

  // ── TRENDING ─────────────────────────────
  if (type === 'trending') {
    const data = await safeFetch(`${TMDB_BASE}/trending/all/week?${p}`);
    return { results: buildBasicResults(data?.results || [], now), source: 'tmdb' };
  }

  // ── RECOMMEND ────────────────────────────
  if (type === 'recommend') {
    const search = await safeFetch(
      `${TMDB_BASE}/search/movie?${p}&query=${enc(query)}`
    );
    const first = search?.results?.[0];
    if (!first) {
      return { results: [], source: 'tmdb', message: 'No matching title found' };
    }
    const data = await safeFetch(
      `${TMDB_BASE}/movie/${first.id}/recommendations?${p}`
    );
    return { results: buildBasicResults(data?.results || [], now), source: 'tmdb' };
  }

  // ── SEARCH (general / fallback) ──────────
  const data = await safeFetch(
    `${TMDB_BASE}/search/multi?${p}&query=${enc(query)}`
  );
  return { results: buildBasicResults(data?.results || [], now), source: 'tmdb' };
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

  const url  = `${NEWS_URL}?apikey=${env.NEWS_KEY}&q=${enc(query)}&language=en&category=entertainment`;
  const data = await safeFetch(url);

  return {
    results: (data?.results || []).slice(0, 5).map(a => ({
      title:       a.title        || '',
      description: (a.description || '').slice(0, 250),
      source:      a.source_id    || '',
      date:        a.pubDate      || ''
    })),
    source: 'newsdata'
  };
}

// ── Wikipedia ────────────────────────────────
async function toolWikipedia(args) {
  const { query } = args;
  const data = await safeFetch(`${WIKI_URL}/${enc(query)}`);
  if (!data?.extract) {
    return { error: 'Not found on Wikipedia', source: 'wikipedia' };
  }
  return {
    title:   data.title || query,
    summary: (data.extract || '').replace(/\[\d+\]/g, '').slice(0, 800),
    source:  'wikipedia'
  };
}

// ============================================
// TOOL RESULT VALIDATOR
// Checks that at least one tool returned
// something useful. Receives already-parsed
// objects — no double-parsing.
// ============================================
function hasUsefulResults(parsedResults) {
  for (const r of parsedResults) {
    if (!r || r.error) continue;
    if (Array.isArray(r.results) && r.results.length > 0) return true;
    if (typeof r.summary === 'string' && r.summary.length > 0) return true;
  }
  return false;
}

// ============================================
// TOOL CALL VALIDATOR
// Ensures the model filled all required fields
// before we attempt execution.
// ============================================
function validateToolCall(tc) {
  try {
    if (!tc?.function?.name)      return false;
    if (!tc?.function?.arguments) return false;
    const args    = JSON.parse(tc.function.arguments);
    const toolDef = TOOLS.find(t => t.function.name === tc.function.name);
    if (!toolDef) return false;
    const required = toolDef.function.parameters.required || [];
    return required.every(
      r => args[r] !== undefined && args[r] !== null && String(args[r]).trim() !== ''
    );
  } catch { return false; }
}

// ============================================
// GREETING / NO-TOOL DETECTOR
//
// Catches pure conversational messages that
// have no movie content — greetings, reactions,
// casual check-ins. These skip tool calls
// entirely since there is nothing to search for.
//
// Hybrid sentences like "Hey, what about Dune?"
// do NOT match — they still get tools.
// ============================================
const NO_TOOL_PATTERN = /^(hi+|hello+|hey+|yo+|sup|hiya|howdy|greetings|what'?s\s*up|how\s*are\s*you|how\s*r\s*u|how\s*is\s*it\s*going|thanks?|thank\s*you|ty|thx|lol|lmao|haha|ok+|okay|cool|nice|great|wow|sure|yep|nope|bye|cya|see\s*ya|later|k|good\s*morning|good\s*night|good\s*evening|👍|🙏|😊|🎬)[\s!?.]*$/i;

function skipTools(msg) {
  return NO_TOOL_PATTERN.test(msg.trim());
}

// ============================================
// RESPONSE CLEANUP
// Strips all markup/citation artifacts that
// can leak from LLM output.
// ============================================
function cleanResponse(text) {
  if (!text) return '';
  return text
    // Complete citation blocks [cite: 1, 2]
    .replace(/\[cite:\s*[\d,\s]+\]/gi, '')
    // Truncated [cite at end of string
    .replace(/\[cite[^\]]*$/gi, '')
    // Numeric citations [1] [2,3]
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    // Tool call artifacts
    .replace(/<function[\s\S]*?<\/function>/gi, '')
    .replace(/\{["']?(?:query|function)["']?:[\s\S]*?\}/g, '')
    // Bold markdown **text** → text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // Bullet * at line start → remove marker only
    .replace(/(^|\n)\s*\*\s+/g, '$1')
    // Collapse extra whitespace
    .replace(/  +/g, ' ')
    .trim();
}

// ============================================
// FETCH HELPERS
// ============================================

// For external APIs (TMDB, Wiki, News) — 8s timeout
// Returns parsed JSON or null, never throws
async function safeFetch(url, options = {}) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res   = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// For Firebase — 5s timeout, returns raw Response or null
async function firebaseFetch(url, options = {}) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res   = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch { return null; }
}

// For Groq/Gemini LLM calls — 20s timeout (LLM latency)
// Returns raw Response or null, never throws
async function llmFetch(url, options = {}) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res   = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch { return null; }
}

function enc(str) { return encodeURIComponent(str); }

// ============================================
// RATE LIMITING (Firebase only)
// The only Firebase interaction in v5.1.
// Protects Groq API credits from abuse.
// ============================================
async function checkRateLimit(ip, env) {
  try {
    const key  = `rate_${ip.replace(/[.:#]/g, '_')}`;
    const url  = `${FIREBASE_BASE}/rate_limits/${key}.json${env.FIREBASE_SECRET ? `?auth=${env.FIREBASE_SECRET}` : ''}`;

    const getRes  = await firebaseFetch(url);
    const data    = getRes?.ok ? await getRes.json().catch(() => null) : null;
    const now     = Date.now();

    if (data && (now - data.window_start) < (RATE_WINDOW * 1000)) {
      if (data.count >= RATE_MAX) return false;
      firebaseFetch(url, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ count: data.count + 1, window_start: data.window_start })
      }).catch(() => {});
    } else {
      firebaseFetch(url, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ count: 1, window_start: now })
      }).catch(() => {});
    }
    return true;
  } catch { return true; /* fail open — don't block on Firebase errors */ }
}

// ============================================
// GROQ API CALLER
// Shared helper — returns { ok, data, error }
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
    const errType = text.includes('tool_use_failed') ? 'tool_fail' : 'http';
    return { ok: false, error: errType, status: res.status };
  }

  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, error: 'parse' };

  return { ok: true, data };
}

// ============================================
// GEMINI FALLBACK
// Used when Groq fails or tool results empty.
// Has live Google Search — handles very recent
// titles that Groq may not know about.
// ============================================
async function geminiFallback(messages, env) {
  if (!env.GEMINI_API_KEY) {
    return "Something went sideways on my end — give it another shot! 🎬";
  }

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

  if (!res?.ok) return "Something went sideways on my end — give it another shot! 🎬";

  const data = await res.json().catch(() => null);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return cleanResponse(text) || "Something went sideways on my end — give it another shot! 🎬";
}

// ============================================
// MAIN ORCHESTRATION
//
// Flow:
// 1. Build context window from session history
// 2. Send to Groq with tools (unless pure greeting)
// 3a. Tool calls returned → validate → execute → final Groq call
// 3b. Direct reply → return it
// 4. Any failure → Gemini fallback
//
// No Firebase reads or writes except rate limit.
// No caching. All data is fetched live every time.
// ============================================
async function orchestrate(userMessage, history, env) {
  const systemPrompt = buildSystemPrompt();

  // Build smart context window — compresses old history
  const contextHistory = buildContextWindow(history);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...contextHistory,
    { role: 'user', content: userMessage }
  ];

  // Pure greetings skip tools — nothing to search for
  const useTools    = !skipTools(userMessage);
  const toolPayload = useTools
    ? { tools: TOOLS, tool_choice: 'auto' }
    : {};

  // ── Step 1: Initial Groq call ─────────────
  const step1 = await callGroq({
    model:       GROQ_MODEL,
    messages,
    max_tokens:  800,
    temperature: 0.72,
    ...toolPayload
  }, env);

  // Groq failed entirely
  if (!step1.ok) {
    // tool_use_failed: retry without tools before Gemini
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

  // ── No tool calls ─────────────────────────
  if (validCalls.length === 0) {
    // Model attempted tools but ALL were malformed → retry without tools
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

    // Genuine direct reply (greeting, opinion, casual response)
    const direct = assistantMsg.content;
    if (direct) return cleanResponse(direct);
    return geminiFallback(messages, env);
  }

  // ── Step 2: Execute valid tool calls ──────
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

  // Parse results — done ONCE here, not inside hasUsefulResults
  const parsedResults = toolResults.map(r => {
    try { return JSON.parse(r.content); } catch { return {}; }
  });

  // If no useful data came back → Gemini has live search, better for this
  if (!hasUsefulResults(parsedResults)) {
    return geminiFallback(messages, env);
  }

  // ── Step 3: Final Groq call with tool data ─
  const step3 = await callGroq({
    model:       GROQ_MODEL,
    messages:    [...messages, assistantMsg, ...toolResults],
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
      return jsonRes({ status: 'Clappy v5.1 🎬', ok: true }, 200, origin);
    }

    // Main chat endpoint
    if (request.method === 'POST' && url.pathname === '/') {
      if (!origin) return jsonRes({ error: 'Forbidden' }, 403, null);

      // Rate limit check
      const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await checkRateLimit(ip, env);
      if (!allowed) {
        return jsonRes({ error: 'Too many requests — slow down a little.' }, 429, origin);
      }

      // Parse request body
      let body;
      try { body = await request.json(); }
      catch { return jsonRes({ error: 'Invalid JSON body' }, 400, origin); }

      const { messages } = body;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return jsonRes({ error: 'messages array is required' }, 400, origin);
      }

      const userMessage = messages[messages.length - 1]?.content?.trim();
      if (!userMessage) return jsonRes({ error: 'Empty message' }, 400, origin);

      // History = everything before the current message
      // sessionMemory param is intentionally dropped — v5.1 uses no stored memory
      const history = messages.slice(0, -1).map(m => ({
        role: m.role, content: m.content
      }));

      try {
        const reply = await orchestrate(userMessage, history, env);
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
