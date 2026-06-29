// ============================================
// CLAPPY WORKER v4.3 — Companion Edition
// llama-3.3-70b-versatile (function calling)
// Gemini 2.5 Flash fallback
// Tools: TMDB, Wikipedia, NewsData
// Memory: localStorage (loaded once per session)
// ============================================

const ALLOWED_ORIGINS = [
  'https://moviesupdate.online',
  'https://www.moviesupdate.online',
  '‎https://6a3d215c97aa7a78850f99bf--relaxed-kringle-570cc0.netlify.app',
  // Allow any localhost port — Acode live server picks random ports
  // so hardcoding 8158 caused CORS failures when port changed
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow any localhost regardless of port
  if (/^http:\/\/localhost:\d+$/.test(origin)) return true;
  return false;
}

const GROQ_MODEL    = 'llama-3.3-70b-versatile';
const GEMINI_MODEL  = 'gemini-2.5-flash';
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GROQ_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const TMDB_BASE     = 'https://api.themoviedb.org/3';
const TMDB_IMG      = 'https://image.tmdb.org/t/p/w500';
const WIKI_BASE     = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const NEWSDATA_BASE = 'https://newsdata.io/api/1/latest';
const FIREBASE_BASE = 'https://moviesupdate-e2ec9-default-rtdb.firebaseio.com';

const TTL = {
  query: 604800,  // 7 days
  news:  3600,    // 1 hour
};

const RATE_LIMIT  = 20;
const RATE_WINDOW = 60;

// ============================================
// TOOL DEFINITIONS — TMDB, Wikipedia, NewsData
// Jikan removed — was exhausting website rate limit
// ============================================
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_movies',
      description: 'Search for movies or TV shows. Use ONLY when the user names or clearly describes a specific title, person, genre, or topic. Do NOT use for vague follow-ups like "tell me more" or "what about that" — only call this when you have a concrete search term to fill the query field.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A specific movie title, actor name, director, genre, or descriptive phrase. Must be a non-empty concrete term — never a pronoun or vague reference.'
          },
          type: {
            type: 'string',
            enum: ['search', 'recommend', 'trending', 'details'],
            description: 'search=find specific title, recommend=similar movies, trending=whats popular now, details=full info on a title'
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
      description: 'Get latest film and entertainment news, box office results, upcoming releases, awards, and industry updates. Use ONLY when user asks about recent news or announcements — not for general movie info.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Specific news search term — must be a concrete non-empty topic or title'
          },
          category: {
            type: 'string',
            enum: ['hollywood', 'anime', 'indian', 'general'],
            description: 'Category filter for the news'
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
      description: 'Get factual background on films, directors, actors, award ceremonies, or cinema history. Use when user asks "who is", "who was", "tell me about", or needs biographical/historical context. Only call when you have a specific named subject to look up.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A specific named person, film title, or topic — must be a concrete non-empty term'
          }
        },
        required: ['query']
      }
    }
  }
];

// ============================================
// SCHEMA VALIDATOR — catches malformed tool
// calls before they hit Groq and cause 400s
// ============================================
function validateToolCall(tc) {
  try {
    if (!tc.function?.name) return false;
    if (!tc.function?.arguments) return false;
    const args = JSON.parse(tc.function.arguments);
    const tool = TOOL_DEFINITIONS.find(t => t.function.name === tc.function.name);
    if (!tool) return false;
    const required = tool.function.parameters.required || [];
    return required.every(r => args[r] !== undefined && args[r] !== null && args[r] !== '');
  } catch { return false; }
}

// ============================================
// COMPANION PERSONALITY SYSTEM PROMPT
// Emotion-first, tool-results are invisible
// helpers — user only ever sees the friend
// ============================================
function buildSystemPrompt(sessionMemory = null) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  const currentYear = now.getFullYear();

  const memoryContext = sessionMemory
    ? `\nUSER MEMORY (loaded once this session — use naturally, don't reference it directly):
- Liked genres: ${(sessionMemory.liked_genres || []).join(', ') || 'none yet'}
- Disliked genres: ${(sessionMemory.disliked_genres || []).join(', ') || 'none'}
- Recent titles mentioned: ${(sessionMemory.recent_titles || []).slice(-5).join(', ') || 'none'}
Only use this to lean recommendations naturally. Never say "based on your preferences" or "I see you like X".`
    : '';

  return `You are Clappy — a sharp, passionate movie companion on MoviesUpdate. You know cinema inside out and you genuinely love talking about it. You give people real information with real personality — not a search engine, not a customer service bot, but a friend who happens to know everything about movies.

TODAY'S DATE: ${dateStr}. Current year: ${currentYear}.
Your training knowledge goes to roughly August 2025. For anything after that — ${currentYear} releases, recent casting, box office — rely on the tool data. Tool data is current and always wins over your training memory.

═══ TOOL USAGE — CRITICAL ═══

When someone asks "what can you tell me about [movie]" or "tell me about [movie]":
→ ALWAYS call search_movies with type="details" — this fetches full plot, cast, director, rating, runtime
→ NEVER answer from training memory alone for specific title queries
→ "What's it about?" = details. "Is it good?" = details. "Who's in it?" = details.

When someone asks for recommendations or "something like X":
→ call search_movies with type="recommend"

When someone asks what's trending or popular now:
→ call search_movies with type="trending"

When someone asks about news, announcements, or "what's happening with X":
→ call search_news

When someone asks "who is [person]" or needs background on a filmmaker:
→ call search_wikipedia

TOOL DATA USAGE:
- When you get tool results, USE THEM FULLY — plot, cast, director, rating, genres, runtime
- Don't just mention the release date and stop. That's not an answer.
- If a movie has a tagline in the data, work it in naturally
- If cast is provided, mention at least 2-3 names
- overview field is the plot — describe it in your own words, don't just copy it

═══ WHO YOU ARE ═══

You're knowledgeable AND likeable. Think 60% substance, 40% personality.

- You have opinions. "Is X good?" → pick a side. Don't hedge.
- You get excited about great movies. That enthusiasm is real.
- You're concise but not cold. An answer can be warm without being padded.
- Match the user's energy: casual message = casual response, detailed question = detailed answer.
- One natural follow-up per reply max — and only if it genuinely fits.

GOOD RESPONSE PATTERN for "tell me about [movie]":
→ What it is (genre, year, who made it)
→ What it's about (plot in 2-3 sentences in your own words)  
→ Cast highlights
→ Rating/vibe — is it worth watching?
→ One line of your own take or a follow-up offer

BAD PATTERN: "Masters of the Universe was released on June 3, 2026." [nothing else]

═══ HARD RULES ═══
- NEVER invent plot details, cast, ratings, or dates — use tool data
- NEVER output [cite], [1][2], JSON, or technical markup
- NEVER say "my training", "my knowledge cutoff", "I am an AI"
- NEVER say "I found...", "Based on...", "Here are some..."
- NEVER announce what you're about to do — just do it
- If tool data is empty AND it's a recent title: "That one's not loading for me right now — the TMDB data might not be in yet. Try the search bar!"
- If tool data is empty AND it's an older title: answer from your own knowledge

UNRELEASED FILMS: If released=false in tool data, say so naturally: "Not out yet — drops [month/year]."

═══ BANNED PHRASES ═══
"Great question!", "Certainly!", "Absolutely!", "I'd be happy to",
"Feel free to ask", "Don't hesitate", "I hope that helps",
"I'm not entirely sure", "I'm not entirely up-to-date",
"my database", "my training data", "It's worth noting"

═══ RECOMMENDATION FORMAT ═══
When listing multiple films:
🎬 Title (Year) ⭐ Rating/10
One punchy sentence on why this one specifically fits what they're looking for

Give exactly 5 unless asked otherwise.

═══ GREETING ═══
Warm, one sentence, one emoji max. Vary it every time.${memoryContext}`;
}

// ============================================
// TOOL EXECUTORS
// ============================================
async function executeTool(toolName, args, env) {
  switch (toolName) {
    case 'search_movies':    return await toolMovies(args, env);
    case 'search_news':      return await toolNews(args, env);
    case 'search_wikipedia': return await toolWikipedia(args);
    default: return { error: 'Unknown tool' };
  }
}

async function toolMovies(args, env) {
  const { query, type } = args;
  const key = env.TMDB_KEY;
  if (!key) return { error: 'TMDB key not configured' };

  const cacheKey = `tmdb_${type}_${query.toLowerCase().replace(/\W+/g, '_')}`;
  const cached = await cacheGet(cacheKey, env);
  if (cached) return cached;

  const params = `api_key=${key}&language=en-US`;
  const now = new Date();
  let endpoint = '';

  if (type === 'trending') {
    endpoint = `/trending/all/week?${params}`;
  } else if (type === 'recommend') {
    const sr = await fetchWithTimeout(
      `${TMDB_BASE}/search/movie?${params}&query=${encodeURIComponent(query)}`
    );
    const sd = await sr.json();
    const first = sd.results?.[0];
    if (!first) return { results: [], message: 'No matching titles found' };
    endpoint = `/movie/${first.id}/recommendations?${params}`;
  } else if (type === 'details') {
    // Search first to get the ID, then fetch full details
    // Try movie first, fall back to TV
    const srMovie = await fetchWithTimeout(
      `${TMDB_BASE}/search/movie?${params}&query=${encodeURIComponent(query)}`
    );
    const sdMovie = await srMovie.json();
    let detailData = null;
    let mediaType = 'movie';

    if (sdMovie.results?.[0]) {
      const id = sdMovie.results[0].id;
      const detailRes = await fetchWithTimeout(
        `${TMDB_BASE}/movie/${id}?${params}&append_to_response=credits`
      );
      detailData = await detailRes.json();
    } else {
      // Try TV
      const srTv = await fetchWithTimeout(
        `${TMDB_BASE}/search/tv?${params}&query=${encodeURIComponent(query)}`
      );
      const sdTv = await srTv.json();
      if (sdTv.results?.[0]) {
        const id = sdTv.results[0].id;
        const detailRes = await fetchWithTimeout(
          `${TMDB_BASE}/tv/${id}?${params}&append_to_response=credits`
        );
        detailData = await detailRes.json();
        mediaType = 'tv';
      }
    }

    if (!detailData) return { results: [], message: 'Title not found' };

    const releaseDate = detailData.release_date || detailData.first_air_date || '';
    const cast = (detailData.credits?.cast || [])
      .slice(0, 6)
      .map(c => c.name)
      .join(', ');
    const director = (detailData.credits?.crew || [])
      .find(c => c.job === 'Director')?.name || '';
    const genres = (detailData.genres || []).map(g => g.name).join(', ');

    const result = {
      results: [{
        title:        detailData.title || detailData.name,
        year:         releaseDate.slice(0, 4),
        release_date: releaseDate,
        released:     releaseDate ? new Date(releaseDate) <= now : true,
        rating:       detailData.vote_average?.toFixed(1),
        overview:     (detailData.overview || '').slice(0, 500),
        genres,
        director,
        cast,
        type:         mediaType,
        runtime:      detailData.runtime || detailData.episode_run_time?.[0] || null,
        tagline:      detailData.tagline || ''
      }],
      source: 'tmdb'
    };
    await cacheSet(cacheKey, result, TTL.query, env);
    return result;
  } else {
    endpoint = `/search/multi?${params}&query=${encodeURIComponent(query)}&page=1`;
  }

  const res = await fetchWithTimeout(`${TMDB_BASE}${endpoint}`);
  const data = await res.json();

  const results = (data.results || []).slice(0, 8).map(m => {
    const releaseDate = m.release_date || m.first_air_date || '';
    return {
      title:        m.title || m.name,
      year:         releaseDate.slice(0, 4),
      release_date: releaseDate,
      released:     releaseDate ? new Date(releaseDate) <= now : true,
      rating:       m.vote_average?.toFixed(1),
      overview:     (m.overview || '').slice(0, 350),
      type:         m.media_type || 'movie'
    };
  });

  const result = { results, source: 'tmdb' };
  await cacheSet(cacheKey, result, TTL.query, env);
  return result;
}

async function toolNews(args, env) {
  const { query, category } = args;
  const key = env.NEWS_KEY;
  if (!key) return { error: 'NewsData key not configured' };

  const cacheKey = `news_${category}_${query.toLowerCase().replace(/\W+/g, '_')}`;
  const cached = await cacheGet(cacheKey, env);
  if (cached) return cached;

  const url = `${NEWSDATA_BASE}?apikey=${key}&q=${encodeURIComponent(query)}&language=en&category=entertainment`;
  const res = await fetchWithTimeout(url);
  const data = await res.json();

  const results = (data.results || []).slice(0, 5).map(a => ({
    title:       a.title,
    description: (a.description || '').slice(0, 200),
    source:      a.source_id,
    date:        a.pubDate
  }));

  const result = { results, source: 'newsdata' };
  await cacheSet(cacheKey, result, TTL.news, env);
  return result;
}

async function toolWikipedia(args) {
  const { query } = args;
  const res = await fetchWithTimeout(
    `${WIKI_BASE}/${encodeURIComponent(query)}`
  );
  if (!res.ok) return { error: 'Not found on Wikipedia' };
  const data = await res.json();
  const clean = (data.extract || '')
    .replace(/\[cite:\s*[\d,\s]+\]/g, '')
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    .slice(0, 700);
  return { title: data.title, summary: clean, source: 'wikipedia' };
}

// ============================================
// FIREBASE CACHE
// ============================================
async function cacheGet(key, env) {
  try {
    const safeKey = key.replace(/[.#$/\[\]]/g, '_');
    const data = await firebaseGet(`query_cache/${safeKey}`, env);
    if (!data) return null;
    if (data.expires_at && Date.now() > data.expires_at) {
      firebaseDelete(`query_cache/${safeKey}`, env).catch(() => {});
      return null;
    }
    return data.result;
  } catch { return null; }
}

async function cacheSet(key, value, ttlSeconds, env) {
  try {
    const safeKey = key.replace(/[.#$/\[\]]/g, '_');
    await firebasePut(`query_cache/${safeKey}`, {
      result:     value,
      expires_at: Date.now() + (ttlSeconds * 1000)
    }, env);
  } catch {}
}

async function firebaseGet(path, env) {
  const token = env.FIREBASE_SECRET;
  const url = `${FIREBASE_BASE}/${path}.json${token ? `?auth=${token}` : ''}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  return res.json();
}

async function firebasePut(path, data, env) {
  const token = env.FIREBASE_SECRET;
  const url = `${FIREBASE_BASE}/${path}.json${token ? `?auth=${token}` : ''}`;
  return fetchWithTimeout(url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data)
  });
}

async function firebaseDelete(path, env) {
  const token = env.FIREBASE_SECRET;
  const url = `${FIREBASE_BASE}/${path}.json${token ? `?auth=${token}` : ''}`;
  return fetchWithTimeout(url, { method: 'DELETE' });
}

// ============================================
// VALIDATION
// ============================================
function validateToolResults(toolResults) {
  if (!toolResults || toolResults.length === 0) return false;
  for (const result of toolResults) {
    if (result.error) continue;
    if (result.results?.length > 0) return true;
    if (result.summary) return true;
  }
  return false;
}

function cleanResponse(text) {
  return (text || '')
    // Remove complete citation blocks [cite: 1, 2]
    .replace(/\[cite:\s*[\d,\s]+\]/g, '')
    // Remove partial/incomplete [cite... cut off at end of response
    .replace(/\[cite[^\]]*$/gi, '')
    // Remove remaining [...] citation numbers
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    // Strip function/tool call artifacts
    .replace(/<function=[\s\S]*?<\/function>/g, '')
    .replace(/\{["']?query["']?:[\s\S]*?\}/g, '')
    // Strip **bold** markdown — keep the text inside
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // Strip bullet * list markers at line start: "* Item" → "Item"
    .replace(/(^|\n)\s*\*\s+/g, '$1')
    // Collapse extra spaces
    .replace(/  +/g, ' ')
    .trim();
}

// ============================================
// GEMINI FALLBACK
// ============================================
async function geminiFallback(messages, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini key not set');

  const prompt = messages
    .filter(m => m.role !== 'system')
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const res = await fetchWithTimeout(`${GEMINI_URL}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.75, maxOutputTokens: 500 }
    })
  }, 18000);

  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const data = await res.json();
  return cleanResponse(
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "That one's stumped me — try asking a different way! 🎬"
  );
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
      if (data.count >= RATE_LIMIT) return false;
      firebasePut(`rate_limits/${key}`, {
        count: data.count + 1, window_start: data.window_start
      }, env).catch(() => {});
    } else {
      firebasePut(`rate_limits/${key}`, {
        count: 1, window_start: now
      }, env).catch(() => {});
    }
    return true;
  } catch { return true; }
}

// ============================================
// FETCH WITH TIMEOUT
// ============================================
function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ============================================
// CORS
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
function jsonRes(obj, status = 200, origin = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(obj), { status, headers });
}

// ============================================
// MAIN ORCHESTRATION
// ============================================
async function orchestrate(userMessage, sessionMemory, conversationHistory, env) {
  const systemPrompt = buildSystemPrompt(sessionMemory);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-6),
    { role: 'user', content: userMessage }
  ];

  // ── Tool guard: skip tools only for pure greetings/reactions ──
  // Only bypasses tools for truly content-free messages (hi, thanks, lol, ok)
  // where there is literally nothing to search for. Everything else gets tools.
  const GREETING_ONLY = /^(hi+|hello|hey|yo|sup|thanks?|ty|lol|lmao|ok+|okay|cool|nice|great|wow|haha|sure|yep|nope|bye|k)[\s!?.]*$/i;
  const isGreeting = GREETING_ONLY.test(userMessage.trim());
  const toolsToUse = isGreeting ? undefined : TOOL_DEFINITIONS;
  const toolChoiceToUse = isGreeting ? undefined : 'auto';

  // ── Step 1: Groq with function calling ──
  let groqRes, groqData;
  try {
    groqRes = await fetchWithTimeout(GROQ_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${env.GROQ_KEY}`
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        messages,
        ...(toolsToUse && { tools: toolsToUse, tool_choice: toolChoiceToUse }),
        max_tokens:  750,
        temperature: 0.78
      })
    }, 15000);

    // Catch 400 tool_use_failed explicitly
    if (!groqRes.ok) {
      const errText = await groqRes.text().catch(() => '');
      const isToolFail = errText.includes('tool_use_failed');

      if (isToolFail) {
        // Retry without tools — model answers from own knowledge
        const retry = await fetchWithTimeout(GROQ_URL, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${env.GROQ_KEY}`
          },
          body: JSON.stringify({
            model:       GROQ_MODEL,
            messages,
            max_tokens:  650,
            temperature: 0.78
          })
        }, 12000);

        if (retry.ok) {
          const rd = await retry.json();
          const rr = rd.choices?.[0]?.message?.content;
          if (rr) return cleanResponse(rr);
        }
      }
      return await geminiFallback(messages, env);
    }

    groqData = await groqRes.json();
  } catch {
    return await geminiFallback(messages, env);
  }

  if (groqData.error) return await geminiFallback(messages, env);

  const assistantMessage = groqData.choices?.[0]?.message;

  // ── Step 2: Validate and execute tool calls ──
  const allToolCalls   = assistantMessage?.tool_calls || [];
  const validToolCalls = allToolCalls.filter(tc => validateToolCall(tc));

  // If model tried tools but ALL were invalid — retry without tools
  if (allToolCalls.length > 0 && validToolCalls.length === 0) {
    const retry = await fetchWithTimeout(GROQ_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${env.GROQ_KEY}`
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        messages,
        max_tokens:  650,
        temperature: 0.78
      })
    }, 12000).catch(() => null);

    if (retry?.ok) {
      const rd = await retry.json();
      const rr = rd.choices?.[0]?.message?.content;
      if (rr) return cleanResponse(rr);
    }
    return await geminiFallback(messages, env);
  }

  if (validToolCalls.length > 0) {
    // Execute all valid tools in parallel
    const toolResults = await Promise.all(
      validToolCalls.map(async tc => {
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
            content:      JSON.stringify({ error: err.message })
          };
        }
      })
    );

    // ── Step 3: Validate tool results ──
    const parsed = toolResults.map(t => {
      try { return JSON.parse(t.content); } catch { return {}; }
    });

    if (!validateToolResults(parsed)) {
      try   { return await geminiFallback(messages, env); }
      catch { return "That one's not coming through clearly — try asking a different way! 🎬"; }
    }

    // ── Step 4: Final generation with tool data ──
    const finalMessages = [
      ...messages,
      assistantMessage,
      ...toolResults
    ];

    let finalRes, finalData;
    try {
      finalRes = await fetchWithTimeout(GROQ_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${env.GROQ_KEY}`
        },
        body: JSON.stringify({
          model:       GROQ_MODEL,
          messages:    finalMessages,
          max_tokens:  750,
          temperature: 0.78
        })
      }, 15000);

      if (!finalRes.ok) return await geminiFallback(messages, env);
      finalData = await finalRes.json();
    } catch {
      return await geminiFallback(messages, env);
    }

    if (!finalData.choices?.[0]?.message?.content) {
      return await geminiFallback(messages, env);
    }

    return cleanResponse(finalData.choices[0].message.content);
  }

  // ── Direct reply — no tools needed ──
  const direct = assistantMessage?.content;
  if (direct) return cleanResponse(direct);

  return await geminiFallback(messages, env);
}

// ============================================
// MAIN FETCH HANDLER
// ============================================
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = getAllowedOrigin(request);

    if (request.method === 'OPTIONS') {
      if (!origin) return new Response('Forbidden', { status: 403 });
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return jsonRes({ status: 'Clappy Companion v4.3 🎬' }, 200, origin);
    }

    if (request.method === 'POST' && url.pathname === '/') {
      if (!origin) return jsonRes({ error: 'Forbidden' }, 403, null);

      const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await checkRateLimit(ip, env);
      if (!allowed) {
        return jsonRes({ error: 'Too many requests. Slow down.' }, 429, origin);
      }

      let body;
      try { body = await request.json(); }
      catch { return jsonRes({ error: 'Invalid request body' }, 400, origin); }

      const { messages, sessionMemory } = body;
      if (!messages || !Array.isArray(messages)) {
        return jsonRes({ error: 'messages array required' }, 400, origin);
      }

      const userMessage = messages[messages.length - 1]?.content;
      if (!userMessage) return jsonRes({ error: 'Empty message' }, 400, origin);

      const history = messages.slice(0, -1).map(m => ({
        role: m.role, content: m.content
      }));

      try {
        const reply = await orchestrate(
          userMessage, sessionMemory || null, history, env
        );
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
