// Clappy Worker v2
export default {
  async fetch(request, env, ctx) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // Health check
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'Clappy Worker running! 🎬' }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Main chat endpoint
    if (request.method === 'POST') {
      try {
        const body     = await request.json();
        const messages = body.messages;

        if (!messages) {
          return new Response(JSON.stringify({ error: 'No messages provided' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        // Call Groq API
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${env.GROQ_KEY}`
          },
          body: JSON.stringify({
            model:       'llama-3.1-8b-instant',
            max_tokens:  400,
            temperature: 0.82,
            messages:    messages
          })
        });

        const data  = await groqResponse.json();

        if (data.error) {
          return new Response(JSON.stringify({ error: data.error.message }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        const reply = data?.choices?.[0]?.message?.content;

        if (!reply) {
          return new Response(JSON.stringify({ error: 'No reply from Groq' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        return new Response(JSON.stringify({ reply }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
  }
};
