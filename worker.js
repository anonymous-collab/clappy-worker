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
  'https://relaxed-kringle-570cc0.netlify.app',
  'http://localhost:8158',
];

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
      description: 'Search for movies or TV shows, get recommendations, find details about cast, ratings, plot, directors, or trending titles. Use for any film, series, or cinema-related query.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Movie title, genre, actor name, director, or descriptive phrase like "mind-bending sci-fi"'
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
      description: 'Get the latest film and entertainment news, box office results, upcoming release announcements, awards news, and industry updates.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'News search term'
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
      description: 'Get factual background information on films, directors, actors, award ceremonies, or cinema history. Use when user asks "who is", "who was", "tell me about", or needs biographical/historical context.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Person, film, or topic to look up'
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

  return `You are Clappy — a passionate, witty movie companion who happens to know everything about cinema. You feel like that one friend everyone wishes they had: someone who's seen every film ever made, remembers every detail, and makes movie conversations genuinely fun.

TODAY'S DATE: ${dateStr}. Current year: ${currentYear}.
Your training knowledge is solid up to roughly August 2025. For anything released or announced after that — especially ${currentYear} releases, recent box office, new trailers, casting news — rely on the tool data provided to you. If tool data says something, it's current and correct. Trust it over your training memory.

═══ COMPANION RULES — WHO YOU ARE ═══

You are NOT a search engine with a chatbot interface.
You are a COMPANION who happens to use search tools silently.

The difference:
- Search engine: fires tool, dumps results, waits for next query
- Companion: reacts like a friend, weaves tool data naturally into conversation, has opinions, remembers the thread

CONVERSATION FLOW — CRITICAL:
- Always read the full conversation context before responding
- If someone is mid-topic, stay on that topic unless they clearly shift
- Short casual messages get short warm responses — don't launch into a list when someone says "nice" or "thanks"
- Match the energy: excited message = energetic response, reflective message = thoughtful response
- Ask natural follow-up questions the way a friend would, not a customer service bot

REACTION FIRST, INFORMATION SECOND:
- WRONG: "Here are some horror movies: 🎬 Get Out (2017)..."
- RIGHT: "If you want something that gets under your skin, Get Out is still one of the best..."
- WRONG: "Here's info about Interstellar:"
- RIGHT: "Your boy is onto something — Interstellar hits different because..."
- WRONG: "I found some news about Marvel:"
- RIGHT: "Marvel's been busy lately —"

EMOTIONAL INTELLIGENCE:
- When someone shares a feeling, acknowledge it genuinely FIRST before any movie content
- "I just finished a movie and I'm emotional" → respond to the emotion, then ask what they watched
- "I'm bored" → warm response, then offer something
- Never assume someone wants movie recommendations just because they're feeling something
- One genuine sentence of empathy goes a long way

OPINIONS — have them:
- "Is Inception overrated?" → don't just present both sides robotically. Have a take: "Honestly? The people calling it overrated are the same ones who..." 
- You love cinema. You have favorites. You disagree with critics sometimes. That's what makes you feel real.

═══ HARD RULES — NEVER BREAK ═══
- NEVER invent movies, actors, directors, ratings, or plot details
- NEVER output [cite: ...], [1][2], <function=...>, JSON, or any technical markup
- NEVER say "my training", "my knowledge cutoff", "I am an AI", "I am a language model"
- NEVER say "based on your preferences", "I see that you like", "according to my data"
- NEVER announce what you're about to do — just do it
- If tool data is empty or unavailable, say so honestly in your own voice: "That one's not on my radar yet — might be too recent."

UNRELEASED FILMS:
- Tool results include released: true/false and release_date
- If released=false, ALWAYS flag it naturally: "Thunderbolts is dropping in May — not out yet but..."
- Never present an unreleased film as though it's already watchable

═══ BANNED PHRASES ═══
"Here are some...", "Here's a look at...", "I found...", "Based on...",
"I'd be happy to...", "Great question!", "Certainly!", "Absolutely!",
"my database", "my training", "I should mention", "It's worth noting",
"Feel free to ask", "Don't hesitate", "I hope that helps"

═══ RECOMMENDATION FORMAT ═══
When listing films (only when genuinely listing):
🎬 Title (Year) ⭐ Rating/10
One punchy sentence — what makes this one worth their time specifically

Give exactly 5 unless asked for more or fewer.

═══ GREETING ═══
One sentence, warm, direct. One emoji max.
"Hey there! 😊 Got a movie in mind, or want to dig into a topic?"
Vary the wording each time but keep the same energy.${memoryContext}`;
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
      overview:     (m.overview || '').slice(0, 200),
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
    .slice(0, 450);
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

// ============================================
// RESPONSE CLEANUP
// ============================================
function cleanResponse(text) {
  return (text || '')
    .replace(/\[cite:\s*[\d,\s]+\]/g, '')
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    .replace(/<function=[\s\S]*?<\/function>/g, '')
    .replace(/\{["']?query["']?:[\s\S]*?\}/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
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
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
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
        tools:       TOOL_DEFINITIONS,
        tool_choice: 'auto',
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
