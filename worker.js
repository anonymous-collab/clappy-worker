// Clappy Worker v3
// Routes:
//   POST /          -> Groq proxy (existing Clappy chat)
//   GET  /gemini-search?q=... -> Gemini grounded search fallback
//   GET  /          -> health check
//   OPTIONS *       -> CORS preflight

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- CORS preflight (all routes) ----
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // ---- Gemini grounded-search fallback ----
    // GET /gemini-search?q=<url-encoded query>
    // Called by ai.js only when TMDb + Wikipedia + News all came back
    // empty for a likely-2025/2026 title. Holds the Gemini key server-side.
    if (request.method === 'GET' && url.pathname === '/gemini-search') {
      const query = url.searchParams.get('q');

      if (!query || query.trim().length < 2) {
        return jsonRes({ text: '' }, 400);
      }

      const apiKey = env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error('GEMINI_API_KEY secret is not set on this worker.');
        return jsonRes({ text: '' }, 200);
      }

      const prompt =
        `You are a movie/TV database assistant. Search for accurate, current ` +
        `information about: "${query}". ` +
        `Respond with a concise factual summary (2-4 sentences): confirm whether ` +
        `this title exists, and if so give its release date/status, a brief plot ` +
        `summary, and any notable cast/crew. If you cannot find reliable ` +
        `information confirming this title exists, say so clearly and briefly — ` +
        `do not guess or invent details.`;

      const GEMINI_MODEL = 'gemini-2.5-flash';
      const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

      try {
        const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role:  'user',
                parts: [{ text: prompt }],
              },
            ],
            tools: [{ googleSearch: {} }],
            generationConfig: {
              temperature:     0.2,
              maxOutputTokens: 300,
            },
          }),
        });

        if (!geminiRes.ok) {
          const errBody = await geminiRes.text().catch(() => '');
          console.warn('Gemini non-OK:', geminiRes.status, errBody.slice(0, 200));
          return jsonRes({ text: '' }, 200);
        }

        const data = await geminiRes.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return jsonRes({ text: text.trim() });

      } catch (err) {
        console.error('Gemini fallback error:', err.message || err);
        return jsonRes({ text: '' }, 200);
      }
    }

    // ---- Health check ----
    if (request.method === 'GET') {
      return jsonRes({ status: 'Clappy Worker running! 🎬' });
    }

    // ---- Main Groq chat endpoint ----
    if (request.method === 'POST') {
      try {
        const body     = await request.json();
        const messages = body.messages;

        if (!messages) {
          return jsonRes({ error: 'No messages provided' }, 400);
        }

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${env.GROQ_KEY}`,
          },
          body: JSON.stringify({
            model:       'llama-3.1-8b-instant',
            max_tokens:  250,
            temperature: 0.82,
            messages:    messages,
          }),
        });

        const data = await groqResponse.json();

        if (data.error) {
          return jsonRes({ error: data.error.message }, 500);
        }

        const reply = data?.choices?.[0]?.message?.content;

        if (!reply) {
          return jsonRes({ error: 'No reply from Groq' }, 500);
        }

        return jsonRes({ reply });

      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }
  },
};

// ---- shared helper ----
function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
        }
            
