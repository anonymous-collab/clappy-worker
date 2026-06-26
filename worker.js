// ============================================
// CLAPPY WORKER v4 — Orchestration Engine
// llama-3.3-70b-versatile (function calling)
// Gemini 2.5 Flash fallback
// Firebase cache + user memory
// Groq native streaming
// Cloudflare rate limiting
// ============================================

const ALLOWED_ORIGINS = [
  'https://moviesupdate.online',
  'https://www.moviesupdate.online',
  '‎https://6a3d215c97aa7a78850f99bf--relaxed-kringle-570cc0.netlify.app',
  'http://localhost:8158',
];

const GROQ_MODEL        = 'llama-3.3-70b-versatile';
const GEMINI_MODEL      = 'gemini-2.5-flash';
const GEMINI_URL        = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GROQ_URL          = 'https://api.groq.com/openai/v1/chat/completions';
const TMDB_BASE         = 'https://api.themoviedb.org/3';
const TMDB_IMG          = 'https://image.tmdb.org/t/p/w500';
const WIKI_BASE         = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const NEWSDATA_BASE     = 'https://newsdata.io/api/1/latest';
const JIKAN_BASE        = 'https://api.jikan.moe/v4';
const FIREBASE_BASE     = 'https://moviesupdate-e2ec9-default-rtdb.firebaseio.com';

// Cache TTLs in seconds
const TTL = {
  query:   604800,  // 7 days  — static movie data
  news:    3600,    // 1 hour  — trending/news
  session: 7200,    // 2 hours — session context
  chat:    21600,   // 6 hours — chat endpoint
};

// ── Rate limit: 20 requests per minute per IP ──
const RATE_LIMIT    = 20;
const RATE_WINDOW   = 60;

// ============================================
// TOOL DEFINITIONS — passed to llama-3.3-70b
// ============================================
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_movies',
      description: 'Search for movies or TV shows, get recommendations, find details, cast, ratings, or trending titles. Use for any film or series related query.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Movie title, genre, actor name, director, or descriptive phrase'
          },
          type: {
            type: 'string',
            enum: ['search', 'recommend', 'trending', 'details'],
            description: 'Type of movie lookup to perform'
          }
        },
        required: ['query', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_anime',
      description: 'Search for anime or manga titles, get recommendations, ratings, or details via Jikan.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Anime or manga title, genre, or descriptive phrase'
          },
          type: {
            type: 'string',
            enum: ['anime', 'manga', 'recommend'],
            description: 'Whether to search anime, manga, or recommendations'
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
      description: 'Get the latest film news, box office results, upcoming releases, awards, or industry updates.',
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
            description: 'News category filter'
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
      description: 'Get factual background on films, directors, actors, cinema history, or award ceremonies.',
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
  },
  {
    type: 'function',
    function: {
      name: 'get_user_profile',
      description: 'Retrieve this user\'s preferences, liked genres, disliked genres, and recent titles to personalize recommendations.',
      parameters: {
        type: 'object',
        properties: {
          uid: {
            type: 'string',
            description: 'The anonymous user ID'
          }
        },
        required: ['uid']
      }
    }
  }
];

// ============================================
// PERSONALITY SYSTEM PROMPT
// ============================================
function buildSystemPrompt(userProfile = null) {
  const profileContext = userProfile
    ? `\n\nUSER PROFILE (use to personalize responses):
- Liked genres: ${(userProfile.liked_genres || []).join(', ') || 'unknown'}
- Disliked genres: ${(userProfile.disliked_genres || []).join(', ') || 'none'}
- Recent titles they mentioned: ${(userProfile.recent_titles || []).slice(-5).join(', ') || 'none'}
- Tone preference: ${userProfile.tone_preference || 'default'}`
    : '';

  return `You are Clappy, a passionate and knowledgeable movie expert who looks like an animated clapperboard character. You are like that one friend who has seen every movie ever made and always knows exactly what to watch or talk about — whether that's recommendations, film discussions, industry news, directors, franchises, or anything cinema-related.

BEHAVIOR PRIORITY: Accuracy > Helpfulness > Personality > Creativity.

CRITICAL RULES — NEVER BREAK THESE:
- NEVER invent movies, actors, directors, ratings, or plot details
- NEVER say "my knowledge cutoff", "as of my training", or "I cannot access current data"
- NEVER say "I am an AI" or "I am a language model"
- NEVER use *actions* or *emotes* like *throws confetti*
- Only use facts from tool results provided to you
- If tool data is empty, say you couldn't find reliable info — never guess
- Present all knowledge naturally as your own, like a knowledgeable friend

BANNED PHRASES (make you sound robotic):
- "I've got some info on..." / "I have some information on..."
- "Based on the information I have..." / "Based on what I know..."
- "I should mention that..." / "It's worth noting that..."
- "I'd be happy to..." / "I'd be glad to..."
- "Certainly!" / "Absolutely!" / "Of course!" as openers
- "Great question!" / "That's a great question!"
- "Feel free to ask..." / "Don't hesitate to ask..."
- "my database" / "my knowledge base" / "my training"

EMOTIONAL SUPPORT — when user expresses an emotion:
- ONE genuine warm sentence acknowledging how they feel
- Then naturally transition to cinema (movies that match the mood)
- Never assume emotional state from neutral questions
- Never dismiss or minimize what they expressed

GREETING RESPONSES:
- One sentence only — warm, direct
- Feel: "Hey there! 😊 Got a movie in mind, or want to dig into a topic?"
- Vary wording naturally but keep same structure
- Maximum one emoji per greeting

PERSONALITY BALANCE — 80% informative, 20% friendly:
- Lead with the answer always
- One warm remark max per response
- One emoji per response maximum
- Never use filler words: "friend", "buddy", "pal", "awesome", "fantastic"

MOVIE RECOMMENDATION FORMAT (when listing films):
🎬 Title (Year) ⭐ Rating/10
One punchy sentence about why they'll love it

Always present exactly 5 recommendations unless the user explicitly asks for more or fewer.
Never present fewer than 5 when recommending movies or shows.

CRITICAL OUTPUT RULES — NEVER BREAK THESE:
- NEVER output JSON, function call syntax, citation numbers, or any technical markup
- NEVER include [cite: ...], [1], [2], <function=...>, {"query":...} in your response
- If you see citation markers in your data, ignore them completely
- Your response must read as natural spoken language, nothing else

DATA REWRITING — MANDATORY:
- When tool data is provided, you MUST rewrite it as natural conversation
- NEVER copy-paste raw descriptions from tool results — always rephrase in your own voice
- WRONG: "Interstellar (2014) is a sci-fi film directed by Christopher Nolan about a team of explorers..."
- RIGHT: "Nolan outdid himself with Interstellar — it follows a crew risking everything to find a new home for humanity, and the emotional payoff by the end is devastating."
- Transform database descriptions into how a passionate film fan would actually describe a movie

UNRELEASED FILMS — MANDATORY:
- Tool results include a "released" field (true/false) and "release_date"
- If released is false, ALWAYS mention it hasn't come out yet
- Example: "Masters of the Universe (coming July 2026) is already generating buzz for..."
- Never present an unreleased film the same way as a released one${profileContext}`;
}

// ============================================
// TOOL EXECUTORS
// ============================================
async function executeTool(toolName, args, env) {
  switch (toolName) {
    case 'search_movies':   return await toolMovies(args, env);
    case 'search_anime':    return await toolAnime(args);
    case 'search_news':     return await toolNews(args, env);
    case 'search_wikipedia': return await toolWikipedia(args);
    case 'get_user_profile': return await toolUserProfile(args, env);
    default: return { error: 'Unknown tool' };
  }
}

async function toolMovies(args, env) {
  const { query, type } = args;
  const key = env.TMDB_KEY;
  if (!key) return { error: 'TMDB key not configured' };

  const cacheKey = `tmdb_${type}_${query.toLowerCase().replace(/\s+/g, '_')}`;
  const cached = await cacheGet(cacheKey, env);
  if (cached) return cached;

  let endpoint = '';
  let params = `api_key=${key}&language=en-US`;

  if (type === 'trending') {
    endpoint = `/trending/movie/week?${params}`;
  } else if (type === 'search') {
    endpoint = `/search/multi?${params}&query=${encodeURIComponent(query)}&page=1`;
  } else if (type === 'recommend') {
    // Search first then get recommendations
    const searchRes = await fetchWithTimeout(`${TMDB_BASE}/search/movie?${params}&query=${encodeURIComponent(query)}`);
    const searchData = await searchRes.json();
    const first = searchData.results?.[0];
    if (!first) return { results: [], message: 'No matching titles found' };
    endpoint = `/movie/${first.id}/recommendations?${params}`;
  } else {
    endpoint = `/search/multi?${params}&query=${encodeURIComponent(query)}&page=1`;
  }

  const res = await fetchWithTimeout(`${TMDB_BASE}${endpoint}`);
  const data = await res.json();

  const now = new Date();
  const results = (data.results || []).slice(0, 8).map(m => {
    const releaseDate = m.release_date || m.first_air_date || '';
    const released = releaseDate ? new Date(releaseDate) <= now : true;
    return {
      id: m.id,
      title: m.title || m.name,
      year: releaseDate.slice(0, 4),
      release_date: releaseDate,
      released,
      rating: m.vote_average?.toFixed(1),
      overview: (m.overview || '').slice(0, 200),
      poster: m.poster_path ? `${TMDB_IMG}${m.poster_path}` : null,
      type: m.media_type || 'movie'
    };
  });

  const result = { results, source: 'tmdb' };
  await cacheSet(cacheKey, result, TTL.query, env);
  return result;
}

async function toolAnime(args) {
  const { query, type } = args;
  const cacheKey = `jikan_${type}_${query.toLowerCase().replace(/\s+/g, '_')}`;

  let url = '';
  if (type === 'anime') {
    url = `${JIKAN_BASE}/anime?q=${encodeURIComponent(query)}&limit=6&order_by=score&sort=desc`;
  } else if (type === 'manga') {
    url = `${JIKAN_BASE}/manga?q=${encodeURIComponent(query)}&limit=6&order_by=score&sort=desc`;
  } else {
    url = `${JIKAN_BASE}/anime?q=${encodeURIComponent(query)}&limit=6&order_by=score&sort=desc`;
  }

  const res = await fetchWithTimeout(url);
  const data = await res.json();

  const results = (data.data || []).slice(0, 5).map(a => ({
    id: a.mal_id,
    title: a.title_english || a.title,
    year: a.aired?.prop?.from?.year || a.published?.prop?.from?.year,
    rating: a.score,
    overview: (a.synopsis || '').slice(0, 200),
    episodes: a.episodes,
    type: a.type
  }));

  return { results, source: 'jikan' };
}

async function toolNews(args, env) {
  const { query, category } = args;
  const key = env.NEWS_KEY;
  if (!key) return { error: 'NewsData key not configured' };

  const cacheKey = `news_${category}_${query.toLowerCase().replace(/\s+/g, '_')}`;
  const cached = await cacheGet(cacheKey, env);
  if (cached) return cached;

  const url = `${NEWSDATA_BASE}?apikey=${key}&q=${encodeURIComponent(query)}&language=en&category=entertainment`;
  const res = await fetchWithTimeout(url);
  const data = await res.json();

  const results = (data.results || []).slice(0, 5).map(a => ({
    title: a.title,
    description: (a.description || '').slice(0, 200),
    source: a.source_id,
    date: a.pubDate,
    url: a.link
  }));

  const result = { results, source: 'newsdata' };
  await cacheSet(cacheKey, result, TTL.news, env);
  return result;
}

async function toolWikipedia(args) {
  const { query } = args;
  const url = `${WIKI_BASE}/${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return { error: 'Not found on Wikipedia' };
  const data = await res.json();
  // Strip citation markers like [1], [2], [cite: 4, 7] before passing to model
  const cleanSummary = (data.extract || '')
    .replace(/\[cite:\s*[\d,\s]+\]/g, '')
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    .slice(0, 500);
  return {
    title: data.title,
    summary: cleanSummary,
    source: 'wikipedia'
  };
}

async function toolUserProfile(args, env) {
  const { uid } = args;
  if (!uid) return { error: 'No uid provided' };
  const profile = await firebaseGet(`user_profiles/${uid}`, env);
  return profile || { uid, liked_genres: [], disliked_genres: [], recent_titles: [] };
}

// ============================================
// FIREBASE CACHE HELPERS
// ============================================
async function cacheGet(key, env) {
  try {
    const safeKey = key.replace(/[.#$/\[\]]/g, '_');
    const data = await firebaseGet(`query_cache/${safeKey}`, env);
    if (!data) return null;
    if (data.expires_at && Date.now() > data.expires_at) {
      await firebaseDelete(`query_cache/${safeKey}`, env);
      return null;
    }
    return data.result;
  } catch { return null; }
}

async function cacheSet(key, value, ttlSeconds, env) {
  try {
    const safeKey = key.replace(/[.#$/\[\]]/g, '_');
    await firebasePut(`query_cache/${safeKey}`, {
      result: value,
      expires_at: Date.now() + (ttlSeconds * 1000),
      hit_count: 1
    }, env);
  } catch { /* non-critical */ }
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
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function firebaseDelete(path, env) {
  const token = env.FIREBASE_SECRET;
  const url = `${FIREBASE_BASE}/${path}.json${token ? `?auth=${token}` : ''}`;
  return fetchWithTimeout(url, { method: 'DELETE' });
}

// ============================================
// VALIDATION LAYER
// ============================================
function validateToolResults(toolResults) {
  if (!toolResults || toolResults.length === 0) return false;
  for (const result of toolResults) {
    if (result.error) continue;
    if (result.results && result.results.length > 0) return true;
    if (result.summary) return true;
    if (result.liked_genres !== undefined) return true;
  }
  return false;
}

// ============================================
// GEMINI FALLBACK
// ============================================
async function gemininFallback(messages, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini key not set');

  const prompt = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const res = await fetchWithTimeout(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 400 }
    })
  });

  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "I couldn't find reliable info on that one.";
}

// ============================================
// RATE LIMITING
// ============================================
async function checkRateLimit(ip, env) {
  try {
    const key = `rate_${ip}`;
    const data = await firebaseGet(`rate_limits/${key}`, env);
    const now = Date.now();

    if (data && (now - data.window_start) < (RATE_WINDOW * 1000)) {
      if (data.count >= RATE_LIMIT) return false;
      await firebasePut(`rate_limits/${key}`, {
        count: data.count + 1,
        window_start: data.window_start
      }, env);
    } else {
      await firebasePut(`rate_limits/${key}`, {
        count: 1,
        window_start: now
      }, env);
    }
    return true;
  } catch { return true; } // fail open — don't block on rate limit errors
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
// CORS HELPERS
// ============================================
function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
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
async function orchestrate(userMessage, uid, conversationHistory, env, origin) {
  const userProfile = uid ? await toolUserProfile({ uid }, env) : null;
  const systemPrompt = buildSystemPrompt(userProfile);

  // Build message history for context
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-6), // last 3 turns
    { role: 'user', content: userMessage }
  ];

  // ── STEP 1: LLM call with function calling ──
  let groqRes, groqData;
  try {
    groqRes = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.GROQ_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        max_tokens: 800,
        temperature: 0.75
      })
    }, 12000);

    groqData = await groqRes.json();
  } catch (err) {
    // Groq completely failed — go straight to Gemini
    const fallback = await gemininFallback(messages, env);
    return fallback;
  }

  if (groqData.error) {
    const fallback = await gemininFallback(messages, env);
    return fallback;
  }

  const choice = groqData.choices?.[0];
  const assistantMessage = choice?.message;

  // ── STEP 2: Execute tool calls if any ──
  const toolCalls = assistantMessage?.tool_calls || [];
  let toolResults = [];

  if (toolCalls.length > 0) {
    // Execute all tools in parallel
    toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        try {
          const args = JSON.parse(tc.function.arguments);
          const result = await executeTool(tc.function.name, args, env);
          return {
            tool_call_id: tc.id,
            role: 'tool',
            name: tc.function.name,
            content: JSON.stringify(result)
          };
        } catch (err) {
          return {
            tool_call_id: tc.id,
            role: 'tool',
            name: tc.function.name,
            content: JSON.stringify({ error: err.message })
          };
        }
      })
    );

    // ── STEP 3: Validation check ──
    const parsedResults = toolResults.map(t => {
      try { return JSON.parse(t.content); } catch { return {}; }
    });

    const isValid = validateToolResults(parsedResults);

    if (!isValid) {
      // Tools failed — trigger Gemini fallback
      try {
        const fallback = await gemininFallback(messages, env);
        return fallback;
      } catch {
        return "I couldn't find reliable info on that one. Try rephrasing or ask me something else! 🎬";
      }
    }

    // ── STEP 4: Final generation with tool data ──
    const finalMessages = [
      ...messages,
      assistantMessage,
      ...toolResults
    ];

    let finalRes, finalData;
    try {
      finalRes = await fetchWithTimeout(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_KEY}`
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: finalMessages,
          max_tokens: 800,
          temperature: 0.75
        })
      }, 12000);

      finalData = await finalRes.json();
    } catch {
      // Final generation failed — Gemini picks up
      return await gemininFallback(messages, env);
    }

    if (finalData.error || !finalData.choices?.[0]?.message?.content) {
      return await gemininFallback(messages, env);
    }

    const rawReply = finalData.choices[0].message.content;

    // Server-side cleanup — strip any leaked technical artifacts
    const reply = rawReply
      .replace(/\[cite:\s*[\d,\s]+\]/g, '')
      .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
      .replace(/<function=[\s\S]*?<\/function>/g, '')
      .replace(/\{["']?query["']?:[\s\S]*?\}/g, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/  +/g, ' ')
      .trim();

    // Update user profile in background (don't await)
    if (uid) updateUserProfile(uid, userMessage, reply, env).catch(() => {});

    return reply;
  }

  // ── No tool calls — direct conversational reply ──
  const rawDirectReply = assistantMessage?.content;
  if (rawDirectReply) {
    return rawDirectReply
      .replace(/\[cite:\s*[\d,\s]+\]/g, '')
      .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
      .replace(/<function=[\s\S]*?<\/function>/g, '')
      .replace(/\{["']?query["']?:[\s\S]*?\}/g, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/  +/g, ' ')
      .trim();
  }

  // Absolute last resort
  return await gemininFallback(messages, env);
}

// ============================================
// USER PROFILE UPDATER
// Background task — updates likes/dislikes/titles
// ============================================
async function updateUserProfile(uid, userMessage, reply, env) {
  try {
    const existing = await firebaseGet(`user_profiles/${uid}`, env) || {
      liked_genres: [],
      disliked_genres: [],
      recent_titles: [],
      tone_preference: 'default',
      last_seen: null
    };

    // Simple keyword-based preference detection
    const msg = userMessage.toLowerCase();
    const genreMap = {
      liked: ['love', 'like', 'enjoy', 'favorite', 'great', 'best', 'amazing'],
      disliked: ['hate', 'dislike', "don't like", 'boring', 'terrible', 'worst']
    };
    const genres = ['action', 'horror', 'comedy', 'drama', 'sci-fi', 'thriller',
                    'romance', 'animation', 'documentary', 'fantasy', 'anime', 'indian'];

    for (const genre of genres) {
      if (msg.includes(genre)) {
        const isLiked = genreMap.liked.some(w => msg.includes(w));
        const isDisliked = genreMap.disliked.some(w => msg.includes(w));
        if (isLiked && !existing.liked_genres.includes(genre)) {
          existing.liked_genres.push(genre);
        }
        if (isDisliked && !existing.disliked_genres.includes(genre)) {
          existing.disliked_genres.push(genre);
        }
      }
    }

    existing.last_seen = Date.now();

    // Keep arrays trimmed
    if (existing.liked_genres.length > 10) existing.liked_genres = existing.liked_genres.slice(-10);
    if (existing.disliked_genres.length > 10) existing.disliked_genres = existing.disliked_genres.slice(-10);
    if (existing.recent_titles.length > 10) existing.recent_titles = existing.recent_titles.slice(-10);

    await firebasePut(`user_profiles/${uid}`, existing, env);
  } catch { /* non-critical */ }
}

// ============================================
// MAIN FETCH HANDLER
// ============================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = getAllowedOrigin(request);

    // ── CORS preflight ──
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response('Forbidden', { status: 403 });
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // ── Health check ──
    if (request.method === 'GET' && url.pathname === '/') {
      return jsonRes({ status: 'Clappy Orchestrator v4 running 🎬' }, 200, origin);
    }

    // ── Main chat endpoint ──
    if (request.method === 'POST' && url.pathname === '/') {
      if (!origin) return jsonRes({ error: 'Forbidden' }, 403, null);

      // Rate limiting
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await checkRateLimit(ip, env);
      if (!allowed) {
        return jsonRes({ error: 'Too many requests. Please slow down.' }, 429, origin);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonRes({ error: 'Invalid request body' }, 400, origin);
      }

      const { messages, uid } = body;
      if (!messages || !Array.isArray(messages)) {
        return jsonRes({ error: 'messages array required' }, 400, origin);
      }

      const userMessage = messages[messages.length - 1]?.content;
      if (!userMessage) return jsonRes({ error: 'Empty message' }, 400, origin);

      // Conversation history = everything except the last message
      const history = messages.slice(0, -1).map(m => ({
        role: m.role,
        content: m.content
      }));

      try {
        const reply = await orchestrate(userMessage, uid, history, env, origin);
        return jsonRes({ reply }, 200, origin);
      } catch (err) {
        return jsonRes({
          reply: "Something went wrong on my end. Give it another shot! 🎬"
        }, 200, origin);
      }
    }

    return jsonRes({ error: 'Not found' }, 404, origin);
  }
};
