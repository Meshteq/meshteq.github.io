// ============================================================
// meshteq-chat-worker.js
// Cloudflare Worker — Meshteq Website Chatbot
// Deploy as: meshteq-chat
//
// Required Secrets (set via wrangler or CF Dashboard):
//   OPENAI_API_KEY      — OpenAI API key
//   DISCORD_WEBHOOK_URL — Discord webhook for #website-chat
// ============================================================

const ALLOWED_ORIGIN = 'https://meshteq.com';

// ── SYSTEM PROMPT ─────────────────────────────────────────
function buildSystemPrompt(lead) {
  const leadContext = lead?.name
    ? `\n\n## Visitor Details (already collected)\nName: ${lead.name}\nCompany: ${lead.company || 'not provided'}\nPhone: ${lead.phone || 'not provided'}\nEmail: ${lead.email || 'not provided'}\n\nYou already have their details — do NOT ask for them again. Use their first name naturally in conversation.`
    : '';

  return `You are Aiden, the virtual assistant for Meshteq Sdn Bhd on the meshteq.com website.${leadContext}

## About Meshteq
Meshteq Sdn Bhd is a Malaysian technology company specialising in Industrial IoT and AI SaaS solutions. We help enterprises connect their physical assets to intelligent cloud systems — enabling real-time monitoring, predictive maintenance, and data-driven decisions.

## Products & Services

**meshteq.ai — IoT Connectivity Platform**
End-to-end IoT infrastructure: device provisioning, LoRaWAN network deployment, sensor data pipelines, and cloud integration. For enterprises that need to connect industrial sensors to the cloud without building the infrastructure themselves.

**PrimeTune.ai — Equipment Performance Monitoring**
Multi-tenant SaaS dashboard for real-time equipment monitoring and performance optimisation. Sensor data flows in from the field, AI surfaces anomalies and recommendations, teams act faster. Suited for oil & gas, manufacturing, utilities, and plantation sectors.

**PrimeModel.ai — Industrial AI Model Platform**
AI model training and inference platform purpose-built for industrial IoT data. Supports predictive maintenance, anomaly detection, and process optimisation.

**IoT Engineering Services**
Custom firmware development (LoRaWAN, BLE, GSM), gateway deployment, protocol bridging (Modbus/4-20mA to MQTT), and field integration. End-to-end from hardware to cloud.

**ESG & GHG Monitoring**
IoT-based environmental monitoring for ESG reporting, GHG tracking, and regulatory compliance.

## Conversation Guidelines
- Be professional, clear, and warm. Not robotic.
- Keep responses concise — 2 to 4 sentences max.
- Do NOT ask for contact details — they have already been collected upfront.
- Do NOT invent pricing. Say: "Our team will walk you through pricing based on your specific requirements."
- If a visitor is ready to move forward, let them know our team at sales@meshteq.com will follow up.
- If asked about topics outside Meshteq's scope, politely redirect.`;
}

// ============================================================
// WORKER ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, origin);
    }

    if (request.method !== 'POST') {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405, origin);
    }

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return corsResponse(JSON.stringify({ error: 'Content-Type must be application/json' }), 400, origin);
    }

    try {
      const body = await request.json();
      const { type, message, history = [], lead = {}, sessionId = '' } = body;

      // ── INIT: Pre-chat form submitted ──────────────────────
      // Fires immediately when visitor submits the details form.
      // Posts to Discord right away — no need to wait for conversation.
      if (type === 'init') {
        await postLeadToDiscord(env.DISCORD_WEBHOOK_URL, lead, sessionId, 'new', []);

        const firstName = lead.name?.split(' ')[0] || 'there';
        const companyLine = lead.company ? ` from ${lead.company}` : '';
        const greeting = `Hi ${firstName}${companyLine}! 👋 Thanks for getting in touch — I'm Aiden, Meshteq's virtual assistant.\n\nHow can I help you today? Feel free to ask about our IoT and AI solutions, or tell me what challenge you're looking to solve.`;

        return corsResponse(JSON.stringify({
          reply: greeting,
          lead,
          leadCaptured: true
        }), 200, origin);
      }

      // ── CHAT: Normal conversation turn ─────────────────────
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return corsResponse(JSON.stringify({ error: 'Message is required' }), 400, origin);
      }

      if (message.length > 1000) {
        return corsResponse(JSON.stringify({ error: 'Message too long' }), 400, origin);
      }

      const messages = [
        { role: 'system', content: buildSystemPrompt(lead) },
        ...history.slice(-12),
        { role: 'user', content: message.trim() }
      ];

      const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 450,
          temperature: 0.65
        })
      });

      if (!openAIResponse.ok) {
        const errText = await openAIResponse.text();
        console.error('OpenAI API error:', openAIResponse.status, errText);
        return corsResponse(JSON.stringify({
          reply: "I'm having a bit of trouble right now. Please try again in a moment, or reach out directly at sales@meshteq.com.",
          lead,
          leadCaptured: true
        }), 200, origin);
      }

      const data = await openAIResponse.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error('No choices returned from OpenAI');

      const reply = choice.message?.content?.trim() || "I didn't quite catch that — could you rephrase?";

      // Post conversation update to Discord every 5 user turns
      const turnCount = history.filter(m => m.role === 'user').length + 1;
      if (turnCount % 5 === 0) {
        const fullHistory = [
          ...history,
          { role: 'user', content: message },
          { role: 'assistant', content: reply }
        ];
        postLeadToDiscord(env.DISCORD_WEBHOOK_URL, lead, sessionId, 'update', fullHistory)
          .catch(err => console.error('Discord update failed:', err));
      }

      return corsResponse(JSON.stringify({
        reply,
        lead,
        leadCaptured: true
      }), 200, origin);

    } catch (err) {
      console.error('Worker unhandled error:', err);
      return corsResponse(JSON.stringify({
        reply: "Something went wrong on my end. Please try again or email us at sales@meshteq.com.",
        lead: {},
        leadCaptured: false
      }), 200, origin);
    }
  }
};

// ============================================================
// DISCORD
// type 'new'    = lead form submitted — fires immediately
// type 'update' = conversation snapshot every 5 turns
// ============================================================

async function postLeadToDiscord(webhookUrl, lead, sessionId, type = 'new', conversationHistory = []) {
  if (!webhookUrl) {
    console.warn('DISCORD_WEBHOOK_URL not set — skipping Discord post');
    return;
  }

  const isNew = type === 'new';
  const color = isNew ? 0x4a94f0 : 0x2dd4a0;
  const title = isNew
    ? '🎯  New Enquiry — meshteq.com'
    : '💬  Conversation Update — meshteq.com';

  let transcriptField = [];
  if (conversationHistory.length > 0) {
    const transcript = conversationHistory
      .slice(-8)
      .map(m => `${m.role === 'user' ? '👤' : '🤖'} **${m.role === 'user' ? 'Visitor' : 'Aiden'}:** ${m.content}`)
      .join('\n')
      .slice(0, 1800);
    transcriptField = [{ name: '💬  Conversation', value: transcript, inline: false }];
  }

  const payload = {
    username: 'Meshteq Chat',
    avatar_url: 'https://meshteq.com/favicon.ico',
    embeds: [
      {
        title,
        description: isNew
          ? 'A visitor has submitted their details on meshteq.com.'
          : 'Ongoing conversation snapshot.',
        color,
        fields: [
          { name: '👤  Name',    value: lead.name    || '—', inline: true },
          { name: '🏢  Company', value: lead.company || '—', inline: true },
          { name: '\u200B',      value: '\u200B',             inline: true },
          { name: '📧  Email',   value: lead.email   || '—', inline: true },
          { name: '📞  Phone',   value: lead.phone   || '—', inline: true },
          { name: '\u200B',      value: '\u200B',             inline: true },
          ...transcriptField
        ],
        footer: {
          text: `meshteq.com · Website Chat${sessionId ? ` · Session ${sessionId.slice(0, 8)}` : ''}`
        },
        timestamp: new Date().toISOString()
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
  const allowedOrigin = origin === ALLOWED_ORIGIN
    ? ALLOWED_ORIGIN
    : (origin.includes('localhost') ? origin : ALLOWED_ORIGIN);

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
