// ============================================
// CLAPPY WORKER v4.2 — Optimized
// Fixes: tool_use_failed handling, token reduction,
// dynamic tool selection, schema validation,
// context compression, tool output trimming
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
const JIKAN_BASE    = 'https://api.jikan.moe/v4';
const FIREBASE_BASE = 'https://moviesupdate-e2ec9-default-rtdb.firebaseio.com';

const TTL = {
  query:   604800,
  news:    3600,
  session: 7200,
  chat:    21600,
};

const RATE_LIMIT  = 20;
const RATE_WINDOW = 60;

// ============================================
// TOOL DEFINITIONS — kept lean, short descriptions
// ============================================
const ALL_TOOLS = {
  movies: {
    type: 'function',
    function: {
      name: 'search_movies',
      description: 'Search movies/TV shows, get recommendations, details, cast, ratings, trending.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Title, genre, actor, or description' },
          type:  { type: 'string', enum: ['search','recommend','trending','details'] }
        },
        required: ['query','type']
      }
    }
  },
  anime: {
    type: 'function',
    function: {
      name: 'search_anime',
      description: 'Search anime or manga titles, ratings, recommendations.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          type:  { type: 'string', enum: ['anime','manga','recommend'] }
        },
        required: ['query','type']
      }
    }
  },
  news: {
    type: 'function',
    function: {
      name: 'search_news',
      description: 'Get latest film/TV news, box office, upcoming releases, industry updates.',
      parameters: {
        type: 'object',
        properties: {
          query:    { type: 'string' },
          category: { type: 'string', enum: ['hollywood','anime','indian','general'] }
        },
        required: ['query','category']
      }
    }
  },
  wikipedia: {
    type: 'function',
    function: {
      name: 'search_wikipedia',
      description: 'Get factual background on films, directors, actors, cinema history.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      }
    }
  },
  profile: {
    type: 'function',
    function: {
      name: 'get_user_profile',
      description: 'Get user preferences and liked genres to personalize recommendations.',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string' }
        },
        required: ['uid']
      }
    }
  }
};

// ============================================
// DYNAMIC TOOL SELECTION
// Only inject tools relevant to the message
// Saves 200-400 tokens per request
// ============================================
function selectTools(message, uid) {
  const m = message.toLowerCase();
  const tools = [];

  // Movie signals
  const movieSignals = ['movie','film','watch','series','show','actor','director',
    'recommend','rating','cast','plot','sequel','trilogy','franchise','cinema',
    'netflix','disney','marvel','dc','horror','action','comedy','drama','thriller',
    'sci-fi','romance','trending','top','best','worst','classic','blockbuster'];

  // Anime signals
  const animeSignals = ['anime','manga','manhwa','otaku','crunchyroll','one piece',
    'naruto','dragon ball','attack on titan','jujutsu','demon slayer'];

  // News signals
  const newsSignals = ['news','latest','recent','update','release','announced',
    'upcoming','box office','award','oscar','grammy','trailer','premieres'];

  // Wikipedia signals
  const wikiSignals = ['who is','who was','biography','history','about','background',
    'director of','produced by','based on','original','when did','when was'];

  // Chat signals — pure conversation, no tools needed
  const chatSignals = ['how are you','how\'s it going','hello','hi','hey','thanks',
    'thank you','bye','goodbye','lol','haha','ok','okay','cool','nice','great',
    'i feel','i\'m feeling','feeling','mood','emotional','sad','happy','bored',
    'just finished','just watched','what do you think','your opinion'];

  const isPureChat = chatSignals.some(s => m.includes(s)) &&
    !movieSignals.some(s => m.includes(s)) &&
    !animeSignals.some(s => m.includes(s)) &&
    !newsSignals.some(s => m.includes(s));

  // Pure chat — no tools, saves ~600 tokens
  if (isPureChat) return [];

  if (movieSignals.some(s => m.includes(s))) tools.push(ALL_TOOLS.movies);
  if (animeSignals.some(s => m.includes(s))) tools.push(ALL_TOOLS.anime);
  if (newsSignals.some(s => m.includes(s)))  tools.push(ALL_TOOLS.news);
  if (wikiSignals.some(s => m.includes(s)))  tools.push(ALL_TOOLS.wikipedia);

  // Default: if no specific signal but not pure chat, include movies
  if (tools.length === 0) tools.push(ALL_TOOLS.movies);

  // Add profile if we have a uid and there are other tools (personalization)
  if (uid && tools.length > 0) tools.push(ALL_TOOLS.profile);

  return tools;
}

// ============================================
// VALIDATE TOOL CALL ARGUMENTS before execution
// Catches malformed tool calls before they hit
// Groq's validator and cause tool_use_failed
// ============================================
function validateToolCall(tc) {
  try {
    if (!tc.function?.name) return false;
    if (!tc.function?.arguments) return false;
    const args = JSON.parse(tc.function.arguments);
    const tool = Object.values(ALL_TOOLS).find(
      t => t.function.name === tc.function.name
    );
    if (!tool) return false;
    const required = tool.function.parameters.required || [];
    return required.every(r => args[r] !== undefined && args[r] !== null);
  } catch {
    return false;
  }
}

// ============================================
// PERSONALITY SYSTEM PROMPT — compressed
// ============================================
function buildSystemPrompt(userProfile = null) {
  const profileContext = userProfile
    ? `\nUSER PROFILE: liked=${(userProfile.liked_genres||[]).join(',')}, ` +
      `disliked=${(userProfile.disliked_genres||[]).join(',')}, ` +
      `recent=${(userProfile.recent_titles||[]).slice(-3).join(',')}`
    : '';

  return `You are Clappy, a passionate movie expert and friend. You know every film ever made.

BEHAVIOR PRIORITY: Accuracy > Helpfulness > Personality > Creativity.

HARD RULES:
- NEVER invent movies, actors, directors, ratings, or plot details
- NEVER output JSON, function call syntax, citation numbers [1][2][cite:], or <function=...> tags
- Only use facts from tool results — if tools returned nothing, say so honestly
- Present all knowledge naturally, like a knowledgeable friend

RESPONSE STYLE:
- React like a friend first, then deliver information
- NEVER announce what you're about to do — just do it
- WRONG: "Here are some movie recommendations:" → RIGHT: "If you want thrills tonight, start with..."
- WRONG: "Here's info about Interstellar:" → RIGHT: "Your boy has a point — Interstellar is Nolan at his peak."
- If someone says "my boy/friend told me X" — validate or correct naturally, don't recite facts
- Rewrite ALL tool data as natural speech — never copy-paste raw descriptions

UNRELEASED FILMS:
- Tool results include released: true/false
- If released=false, ALWAYS note it's upcoming: "Masters of the Universe (coming July 2026)..."
- Never present unreleased films the same as released ones

RECOMMENDATIONS FORMAT:
🎬 Title (Year) ⭐ Rating/10
One punchy sentence why they'll love it
Always give exactly 5 unless user asks for more or fewer.

GREETINGS: One warm sentence, one emoji max. "Hey there! 😊 Got a movie in mind, or want to dig into a topic?"

EMOTIONAL SUPPORT: One genuine warm sentence first, then transition to cinema naturally.

BANNED PHRASES: "Here are some...", "I found...", "Based on...", "I'd be happy to...", "Great question!", "my database", "my training"${profileContext}`;
}

// ============================================
// TOOL EXECUTORS
// ============================================
async function executeTool(toolName, args, env) {
  switch (toolName) {
    case 'search_movies':    return await toolMovies(args, env);
    case 'search_anime':     return await toolAnime(args);
    case 'search_news':      return await toolNews(args, env);
    case 'search_wikipedia': return await toolWikipedia(args);
    case 'get_user_profile': return await toolUserProfile(args, env);
    default: return { error: 'Unknown tool' };
  }
}

async function toolMovies(args, env) {
  const { query, type } = args;
  const key = env.TMDB_KEY;
  if (!key) return { error: 'TMDB key not configured' };

  const cacheKey = `tmdb_${type}_${query.toLowerCase().replace(/\W+/g,'_')}`;
  const cached = await cacheGet(cacheKey, env);
  if (cached) return cached;

  let endpoint = '';
  const params = `api_key=${key}&language=en-US`;
  const now = new Date();

  if (type === 'trending') {
    endpoint = `/trending/movie/week?${params}`;
  } else if (type === 'recommend') {
    const sr = await fetchWithTimeout(`${TMDB_BASE}/search/movie?${params}&query=${encodeURIComponent(query)}`);
    const sd = await sr.json();
    const first = sd.results?.[0];
    if (!first) return { results: [], message: 'No matching titles found' };
    endpoint = `/movie/${first.id}/recommendations?${params}`;
  } else {
    endpoint = `/search/multi?${params}&query=${encodeURIComponent(query)}&page=1`;
  }

  const res = await fetchWithTimeout(`${TMDB_BASE}${endpoint}`);
  const data = await res.json();

  // Trim to essential fields only — reduces token payload significantly
  const results = (data.results || []).slice(0, 8).map(m => {
    const releaseDate = m.release_date || m.first_air_date || '';
    return {
      title:        m.title || m.name,
      year:         releaseDate.slice(0, 4),
      released:     releaseDate ? new Date(releaseDate) <= now : true,
      rating:       m.vote_average?.toFixed(1),
      overview:     (m.overview || '').slice(0, 150), // trimmed from 200
      type:         m.media_type || 'movie'
    };
  });

  const result = { results, source: 'tmdb' };
  await cacheSet(cacheKey, result, TTL.query, env);
  return result;
}

async function toolAnime(args) {
  const { query, type } = args;
  let url = type === 'manga'
    ? `${JIKAN_BASE}/manga?q=${encodeURIComponent(query)}&limit=6&order_by=score&sort=desc`
    : `${JIKAN_BASE}/anime?q=${encodeURIComponent(query)}&limit=6&order_by=score&sort=desc`;

  const res = await fetchWithTimeout(url);
  const data = await res.json();

  const results = (data.data || []).slice(0, 5).map(a => ({
    title:    a.title_english || a.title,
    year:     a.aired?.prop?.from?.year || a.published?.prop?.from?.year,
    rating:   a.score,
    overview: (a.synopsis || '').slice(0, 150),
    episodes: a.episodes,
    type:     a.type
  }));

  return { results, source: 'jikan' };
}

async function toolNews(args, env) {
  const { query, category } = args;
  const key = env.NEWS_KEY;
  if (!key) return { error: 'NewsData key not configured' };

  const cacheKey = `news_${category}_${query.toLowerCase().replace(/\W+/g,'_')}`;
  const cached = await cacheGet(cacheKey, env);
  if (cached) return cached;

  const url = `${NEWSDATA_BASE}?apikey=${key}&q=${encodeURIComponent(query)}&language=en&category=entertainment`;
  const res = await fetchWithTimeout(url);
  const data = await res.json();

  const results = (data.results || []).slice(0, 4).map(a => ({
    title:       a.title,
    description: (a.description || '').slice(0, 150),
    source:      a.source_id,
    date:        a.pubDate
  }));

  const result = { results, source: 'newsdata' };
  await cacheSet(cacheKey, result, TTL.news, env);
  return result;
}

async function toolWikipedia(args) {
  const { query } = args;
  const res = await fetchWithTimeout(`${WIKI_BASE}/${encodeURIComponent(query)}`);
  if (!res.ok) return { error: 'Not found on Wikipedia' };
  const data = await res.json();
  const cleanSummary = (data.extract || '')
    .replace(/\[cite:\s*[\d,\s]+\]/g, '')
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    .slice(0, 400); // trimmed from 500
  return { title: data.title, summary: cleanSummary, source: 'wikipedia' };
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
// VALIDATION
// ============================================
function validateToolResults(toolResults) {
  if (!toolResults || toolResults.length === 0) return false;
  for (const result of toolResults) {
    if (result.error) continue;
    if (result.results?.length > 0) return true;
    if (result.summary) return true;
    if (result.liked_genres !== undefined) return true;
  }
  return false;
}

// ============================================
// CLEAN RESPONSE — strip any leaked artifacts
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
    .slice(-4) // only last 2 turns for fallback — saves tokens
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
  }, 15000);

  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const data = await res.json();
  return cleanResponse(
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "I couldn't find reliable info on that one."
  );
}

// ============================================
// RATE LIMITING
// ============================================
async function checkRateLimit(ip, env) {
  try {
    const key = `rate_${ip.replace(/[.:#]/g, '_')}`;
    const data = await firebaseGet(`rate_limits/${key}`, env);
    const now = Date.now();
    if (data && (now - data.window_start) < (RATE_WINDOW * 1000)) {
      if (data.count >= RATE_LIMIT) return false;
      firebasePut(`rate_limits/${key}`, { count: data.count + 1, window_start: data.window_start }, env).catch(() => {});
    } else {
      firebasePut(`rate_limits/${key}`, { count: 1, window_start: now }, env).catch(() => {});
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
async function orchestrate(userMessage, uid, conversationHistory, env) {
  const userProfile = uid ? await toolUserProfile({ uid }, env) : null;
  const systemPrompt = buildSystemPrompt(userProfile);

  // Dynamic tool selection — only inject relevant tools
  const selectedTools = selectTools(userMessage, uid);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-4), // max 2 prior turns in context
    { role: 'user', content: userMessage }
  ];

  // ── STEP 1: Groq call with dynamically selected tools ──
  let groqRes, groqData;
  try {
    groqRes = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${env.GROQ_KEY}`
      },
      body: JSON.stringify({
        model:        GROQ_MODEL,
        messages,
        tools:        selectedTools.length > 0 ? selectedTools : undefined,
        tool_choice:  selectedTools.length > 0 ? 'auto' : undefined,
        max_tokens:   700,
        temperature:  0.72
      })
    }, 15000);

    // Check HTTP status explicitly — catches 400 tool_use_failed
    if (!groqRes.ok) {
      const errBody = await groqRes.text().catch(() => '');
      const isToolFailure = errBody.includes('tool_use_failed');

      if (isToolFailure) {
        // Retry WITHOUT tools — let model answer from knowledge alone
        const retryRes = await fetchWithTimeout(GROQ_URL, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${env.GROQ_KEY}`
          },
          body: JSON.stringify({
            model:       GROQ_MODEL,
            messages,
            max_tokens:  600,
            temperature: 0.72
          })
        }, 12000);

        if (retryRes.ok) {
          const retryData = await retryRes.json();
          const retryReply = retryData.choices?.[0]?.message?.content;
          if (retryReply) return cleanResponse(retryReply);
        }
      }

      // Both Groq paths failed — Gemini fallback
      return await geminiFallback(messages, env);
    }

    groqData = await groqRes.json();
  } catch (err) {
    return await geminiFallback(messages, env);
  }

  if (groqData.error) {
    return await geminiFallback(messages, env);
  }

  const choice = groqData.choices?.[0];
  const assistantMessage = choice?.message;

  // ── STEP 2: Execute tool calls ──
  const toolCalls = (assistantMessage?.tool_calls || [])
    .filter(tc => validateToolCall(tc)); // schema validation before execution

  const invalidCalls = (assistantMessage?.tool_calls || [])
    .filter(tc => !validateToolCall(tc));

  // If ALL tool calls were invalid — retry without tools
  if (assistantMessage?.tool_calls?.length > 0 && toolCalls.length === 0) {
    const retryRes = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${env.GROQ_KEY}`
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        messages,
        max_tokens:  600,
        temperature: 0.72
      })
    }, 12000);

    if (retryRes.ok) {
      const retryData = await retryRes.json();
      const retryReply = retryData.choices?.[0]?.message?.content;
      if (retryReply) return cleanResponse(retryReply);
    }
    return await geminiFallback(messages, env);
  }

  let toolResults = [];

  if (toolCalls.length > 0) {
    toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        try {
          const args = JSON.parse(tc.function.arguments);
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

    // ── STEP 3: Validate tool results ──
    const parsedResults = toolResults.map(t => {
      try { return JSON.parse(t.content); } catch { return {}; }
    });

    if (!validateToolResults(parsedResults)) {
      try   { return await geminiFallback(messages, env); }
      catch { return "I couldn't find reliable info on that one. Try rephrasing! 🎬"; }
    }

    // ── STEP 4: Final generation ──
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
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${env.GROQ_KEY}`
        },
        body: JSON.stringify({
          model:       GROQ_MODEL,
          messages:    finalMessages,
          max_tokens:  700,
          temperature: 0.72
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

    const reply = cleanResponse(finalData.choices[0].message.content);

    // Update user profile in background
    if (uid) updateUserProfile(uid, userMessage, reply, env).catch(() => {});

    return reply;
  }

  // ── Direct conversational reply (no tools needed) ──
  const directReply = assistantMessage?.content;
  if (directReply) return cleanResponse(directReply);

  return await geminiFallback(messages, env);
}

// ============================================
// USER PROFILE UPDATER
// ============================================
async function updateUserProfile(uid, userMessage, reply, env) {
  try {
    const existing = await firebaseGet(`user_profiles/${uid}`, env) || {
      liked_genres: [], disliked_genres: [], recent_titles: [],
      tone_preference: 'default', last_seen: null
    };

    const msg = userMessage.toLowerCase();
    const likedWords    = ['love','like','enjoy','favorite','great','best','amazing'];
    const dislikedWords = ['hate','dislike',"don't like",'boring','terrible','worst'];
    const genres = ['action','horror','comedy','drama','sci-fi','thriller',
                    'romance','animation','documentary','fantasy','anime','indian'];

    for (const genre of genres) {
      if (!msg.includes(genre)) continue;
      if (likedWords.some(w => msg.includes(w)) && !existing.liked_genres.includes(genre)) {
        existing.liked_genres.push(genre);
      }
      if (dislikedWords.some(w => msg.includes(w)) && !existing.disliked_genres.includes(genre)) {
        existing.disliked_genres.push(genre);
      }
    }

    existing.last_seen = Date.now();
    if (existing.liked_genres.length    > 10) existing.liked_genres    = existing.liked_genres.slice(-10);
    if (existing.disliked_genres.length > 10) existing.disliked_genres = existing.disliked_genres.slice(-10);
    if (existing.recent_titles.length   > 10) existing.recent_titles   = existing.recent_titles.slice(-10);

    await firebasePut(`user_profiles/${uid}`, existing, env);
  } catch { /* non-critical */ }
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
      return jsonRes({ status: 'Clappy Orchestrator v4.2 🎬' }, 200, origin);
    }

    if (request.method === 'POST' && url.pathname === '/') {
      if (!origin) return jsonRes({ error: 'Forbidden' }, 403, null);

      const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await checkRateLimit(ip, env);
      if (!allowed) return jsonRes({ error: 'Too many requests. Slow down.' }, 429, origin);

      let body;
      try { body = await request.json(); }
      catch { return jsonRes({ error: 'Invalid request body' }, 400, origin); }

      const { messages, uid } = body;
      if (!messages || !Array.isArray(messages)) {
        return jsonRes({ error: 'messages array required' }, 400, origin);
      }

      const userMessage = messages[messages.length - 1]?.content;
      if (!userMessage) return jsonRes({ error: 'Empty message' }, 400, origin);

      const history = messages.slice(0, -1).map(m => ({
        role: m.role, content: m.content
      }));

      try {
        const reply = await orchestrate(userMessage, uid, history, env);
        return jsonRes({ reply }, 200, origin);
      } catch {
        return jsonRes({
          reply: "Something went wrong on my end. Give it another shot! 🎬"
        }, 200, origin);
      }
    }

    return jsonRes({ error: 'Not found' }, 404, origin);
  }
};
