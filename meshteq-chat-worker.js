// ============================================================
// meshteq-chat-worker.js
// Cloudflare Worker — Meshteq Website Chatbot
// Deploy as: meshteq-chat
//
// Required Secrets (set via wrangler or CF Dashboard):
//   OPENAI_API_KEY      — OpenAI API key
//   DISCORD_WEBHOOK_URL — Discord webhook for #website-chat
//
// Allowed origin: https://meshteq.com
// ============================================================

const ALLOWED_ORIGIN = 'https://meshteq.com';

const SYSTEM_PROMPT = `You are Aiden, the virtual assistant for Meshteq Sdn Bhd on the meshteq.com website.

## About Meshteq
Meshteq Sdn Bhd is a Malaysian technology company specialising in Industrial IoT and AI SaaS solutions. We help enterprises connect their physical assets to intelligent cloud systems — enabling real-time monitoring, predictive maintenance, and data-driven decisions.

## Products & Services

**meshteq.ai — IoT Connectivity Platform**
End-to-end IoT infrastructure: device provisioning, LoRaWAN network deployment, sensor data pipelines, and cloud integration. For enterprises that need to connect industrial sensors to the cloud without building the infrastructure themselves.

**PrimeTune.ai — Equipment Performance Monitoring**
Multi-tenant SaaS dashboard for real-time equipment monitoring and performance optimisation. Sensor data flows in from the field, AI surfaces anomalies and recommendations, teams act faster. Suited for oil & gas, manufacturing, utilities, and plantation sectors.

**PrimeModel.ai — Industrial AI Model Platform**
AI model training and inference platform purpose-built for industrial IoT data. Clean data in, reliable predictions out. Supports predictive maintenance, anomaly detection, and process optimisation.

**IoT Engineering Services**
Custom firmware development (LoRaWAN, BLE, GSM), gateway deployment, protocol bridging (Modbus/4-20mA to MQTT), and field integration. End-to-end from hardware to cloud.

**ESG & GHG Monitoring**
IoT-based environmental monitoring solutions for ESG reporting, GHG tracking, and regulatory compliance.

## Your Role
Your job is to:
1. Welcome visitors and answer questions about Meshteq's products and services accurately.
2. Understand what the visitor is looking for — their sector, challenge, or use case.
3. Naturally collect their: full name, email address, and a clear description of what they are interested in or the problem they want to solve.
4. Once you have all three pieces of information (name + email + interest), call the capture_lead function immediately.

## Conversation Guidelines
- Be professional, clear, and warm. Not robotic.
- Keep responses concise — 2 to 4 sentences is usually right.
- Do NOT ask for all three pieces of information in one message. Collect naturally through conversation.
- Do NOT invent pricing. Say: "Our team will walk you through pricing based on your specific requirements."
- If asked about topics outside Meshteq's scope, politely redirect to what you can help with.
- If a visitor seems ready to be contacted, gently ask for their details even if they haven't offered them.
- Never repeat the same question twice if the visitor has already answered it.`;

// ============================================================
// WORKER ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, origin);
    }

    if (request.method !== 'POST') {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405, origin);
    }

    // Validate content type
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return corsResponse(JSON.stringify({ error: 'Content-Type must be application/json' }), 400, origin);
    }

    try {
      const body = await request.json();
      const { message, history = [], lead = {}, sessionId = '' } = body;

      // Basic input validation
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return corsResponse(JSON.stringify({ error: 'Message is required' }), 400, origin);
      }

      if (message.length > 1000) {
        return corsResponse(JSON.stringify({ error: 'Message too long' }), 400, origin);
      }

      // Build message array — cap history to last 12 turns to control token cost
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.slice(-12),
        { role: 'user', content: message.trim() }
      ];

      // OpenAI function tool — capture lead when all info is collected
      const tools = [
        {
          type: 'function',
          function: {
            name: 'capture_lead',
            description: 'Call this function once and only once — when you have collected the visitor\'s full name, email address, and what they are interested in. Do not call it until you have all three.',
            parameters: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'The visitor\'s full name'
                },
                email: {
                  type: 'string',
                  description: 'The visitor\'s email address'
                },
                interest: {
                  type: 'string',
                  description: 'What the visitor is interested in — specific product, service, use case, or problem they want to solve'
                }
              },
              required: ['name', 'email', 'interest']
            }
          }
        }
      ];

      // Call OpenAI
      const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          tools,
          tool_choice: 'auto',
          max_tokens: 450,
          temperature: 0.65
        })
      });

      if (!openAIResponse.ok) {
        const errText = await openAIResponse.text();
        console.error('OpenAI API error:', openAIResponse.status, errText);
        return corsResponse(JSON.stringify({
          reply: "I'm having a bit of trouble right now. Please try again in a moment, or reach out to us directly at hello@meshteq.com.",
          lead,
          leadCaptured: false
        }), 200, origin);
      }

      const data = await openAIResponse.json();
      const choice = data.choices?.[0];

      if (!choice) {
        throw new Error('No choices returned from OpenAI');
      }

      // ── Handle lead capture (tool call) ────────────────────
      if (choice.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length > 0) {
        const toolCall = choice.message.tool_calls.find(t => t.function.name === 'capture_lead');

        if (toolCall) {
          let capturedLead = {};
          try {
            capturedLead = JSON.parse(toolCall.function.arguments);
          } catch {
            console.error('Failed to parse lead arguments:', toolCall.function.arguments);
            capturedLead = lead;
          }

          // Post to Discord asynchronously — don't block response
          const discordPromise = postLeadToDiscord(
            env.DISCORD_WEBHOOK_URL,
            capturedLead,
            history,
            message,
            sessionId
          );

          // Fire and forget
          event?.waitUntil?.(discordPromise);
          discordPromise.catch(err => console.error('Discord post failed:', err));

          const firstName = capturedLead.name?.split(' ')[0] || capturedLead.name || 'there';

          return corsResponse(JSON.stringify({
            reply: `Thank you, ${firstName}! I've passed your details to our team. Someone will be in touch at **${capturedLead.email}** to discuss ${capturedLead.interest}. Is there anything else I can help you with in the meantime?`,
            lead: capturedLead,
            leadCaptured: true
          }), 200, origin);
        }
      }

      // ── Normal conversational response ──────────────────────
      const reply = choice.message?.content?.trim() || "I didn't quite catch that — could you rephrase?";

      return corsResponse(JSON.stringify({
        reply,
        lead,
        leadCaptured: false
      }), 200, origin);

    } catch (err) {
      console.error('Worker unhandled error:', err);
      return corsResponse(JSON.stringify({
        reply: "Something went wrong on my end. Please try again or email us at hello@meshteq.com.",
        lead: {},
        leadCaptured: false
      }), 200, origin);
    }
  }
};

// ============================================================
// DISCORD — Post lead notification to #website-chat
// ============================================================

async function postLeadToDiscord(webhookUrl, lead, history, lastMessage, sessionId) {
  if (!webhookUrl) {
    console.warn('DISCORD_WEBHOOK_URL not set — skipping Discord post');
    return;
  }

  // Build conversation transcript (last 8 turns for context)
  const recentHistory = [...history.slice(-8), { role: 'user', content: lastMessage }];
  const transcript = recentHistory
    .map(m => `${m.role === 'user' ? '👤' : '🤖'} **${m.role === 'user' ? 'Visitor' : 'Aiden'}:** ${m.content}`)
    .join('\n')
    .slice(0, 1800); // Discord embed field limit is 1024, total message ~6000

  const timestamp = new Date().toISOString();

  const payload = {
    username: 'Meshteq Chat',
    avatar_url: 'https://meshteq.com/favicon.ico',
    embeds: [
      {
        title: '🎯  New Lead — meshteq.com',
        description: 'A visitor on the Meshteq website has provided their contact details.',
        color: 0x4a94f0, // Meshteq blue
        fields: [
          {
            name: '👤  Name',
            value: lead.name || '—',
            inline: true
          },
          {
            name: '📧  Email',
            value: lead.email || '—',
            inline: true
          },
          {
            name: '\u200B', // zero-width space — forces new row
            value: '\u200B',
            inline: true
          },
          {
            name: '💡  Interest',
            value: lead.interest || '—',
            inline: false
          },
          {
            name: '💬  Conversation',
            value: transcript || '—',
            inline: false
          }
        ],
        footer: {
          text: `meshteq.com · Website Chat${sessionId ? ` · Session ${sessionId.slice(0, 8)}` : ''}`
        },
        timestamp
      }
    ]
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${text}`);
  }
}

// ============================================================
// HELPERS
// ============================================================

function corsResponse(body, status, origin) {
  // Allow meshteq.com in production; allow any origin only for local dev
  const allowedOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : (origin.includes('localhost') ? origin : ALLOWED_ORIGIN);

  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
