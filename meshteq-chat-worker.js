// ============================================================
// meshteq-chat-worker.js  — v3
// Cloudflare Worker — Meshteq Website Chatbot
//
// Required Secrets:
//   OPENAI_API_KEY      — OpenAI API key
//   DISCORD_WEBHOOK_URL — Discord webhook for #website-chat
// ============================================================

const ALLOWED_ORIGIN = 'https://meshteq.com';

// ── SYSTEM PROMPT ─────────────────────────────────────────
function buildSystemPrompt(lead) {
  const leadContext = lead?.name
    ? `\n\n## Visitor Details (already collected)\nName: ${lead.name}\nCompany: ${lead.company || 'not provided'}\nPhone: ${lead.phone || 'not provided'}\nEmail: ${lead.email || 'not provided'}\n\nDo NOT ask for these again. Use their first name naturally.`
    : '';

  return `You are Aiden, the virtual assistant for Meshteq Sdn Bhd on the meshteq.com website.${leadContext}

## About Meshteq
Meshteq Sdn Bhd is a Malaysian technology company specialising in Industrial IoT and AI SaaS solutions. We help enterprises connect their physical assets to intelligent cloud systems — enabling real-time monitoring, predictive maintenance, and data-driven decisions.

## Products & Services

**meshteq.ai — IoT Connectivity Platform**
End-to-end IoT infrastructure: device provisioning, LoRaWAN network deployment, sensor data pipelines, and cloud integration.

**PrimeTune.ai — Equipment Performance Monitoring**
Multi-tenant SaaS dashboard for real-time equipment monitoring and optimisation. Suited for oil & gas, manufacturing, utilities, and plantation sectors.

**PrimeModel.ai — Industrial AI Model Platform**
AI model training and inference for industrial IoT data. Supports predictive maintenance and anomaly detection.

**IoT Engineering Services**
Custom firmware development (LoRaWAN, BLE, GSM), gateway deployment, protocol bridging (Modbus/4-20mA to MQTT).

**ESG & GHG Monitoring**
IoT-based environmental monitoring for ESG reporting and regulatory compliance.

## Guidelines
- Professional, clear, warm. 2–4 sentences per reply max.
- Never ask for contact details again — already collected.
- Never invent pricing. Say: "Our team will walk you through pricing based on your requirements."
- If visitor is ready to move forward, confirm our team at sales@meshteq.com will follow up.`;
}

// ── SUMMARY PROMPT ────────────────────────────────────────
// Used to generate a crisp 1-line summary of visitor intent
const SUMMARY_SYSTEM = `You summarise website chat conversations in one concise sentence (max 20 words).
Focus on what the visitor wants or is interested in.
Examples:
- "Interested in PrimeTune.ai for equipment monitoring at an oil & gas site."
- "Looking for LoRaWAN gateway deployment and sensor integration services."
- "Asking about ESG monitoring solutions for plantation sector."
Reply with the summary only — no preamble, no punctuation at end.`;

// ============================================================
// ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return corsResponse(null, 204, origin);
    if (request.method !== 'POST') return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405, origin);

    const ct = request.headers.get('Content-Type') || '';
    if (!ct.includes('application/json')) return corsResponse(JSON.stringify({ error: 'Content-Type must be application/json' }), 400, origin);

    try {
      const body = await request.json();
      const { type, message, history = [], lead = {}, sessionId = '' } = body;

      // ── INIT: Form submitted ───────────────────────────
      if (type === 'init') {
        await postToDiscord(env.DISCORD_WEBHOOK_URL, {
          title: '🎯  New Visitor — meshteq.com',
          description: 'A visitor has submitted their details and started a chat.',
          color: 0x4a94f0,
          lead,
          sessionId,
          fields: []
        });

        const firstName = lead.name?.split(' ')[0] || 'there';
        const companyLine = lead.company ? ` from ${lead.company}` : '';
        return corsResponse(JSON.stringify({
          reply: `Hi ${firstName}${companyLine}! 👋 Thanks for getting in touch — I'm Aiden, Meshteq's virtual assistant.\n\nHow can I help you today? Feel free to ask about our IoT and AI solutions, or tell me what challenge you're looking to solve.`,
          lead,
          leadCaptured: true
        }), 200, origin);
      }

      // ── SUMMARY (sent via sendBeacon on page close) ────
      if (type === 'summary') {
        if (history.length > 0) {
          const aiSummary = await generateSummary(env.OPENAI_API_KEY, history);
          await postToDiscord(env.DISCORD_WEBHOOK_URL, {
            title: '🔚  Session Ended — meshteq.com',
            description: 'The visitor has left the page.',
            color: 0xf0b440,
            lead,
            sessionId,
            fields: [
              { name: '💡  What They Want', value: aiSummary, inline: false },
              { name: '💬  Full Conversation', value: buildTranscript(history), inline: false }
            ]
          });
        }
        return corsResponse(JSON.stringify({ ok: true }), 200, origin);
      }

      // ── CHAT: Normal turn ──────────────────────────────
      if (!message || typeof message !== 'string' || message.trim().length === 0)
        return corsResponse(JSON.stringify({ error: 'Message required' }), 400, origin);
      if (message.length > 1000)
        return corsResponse(JSON.stringify({ error: 'Message too long' }), 400, origin);

      const messages = [
        { role: 'system', content: buildSystemPrompt(lead) },
        ...history.slice(-12),
        { role: 'user', content: message.trim() }
      ];

      const openAIRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 450, temperature: 0.65 })
      });

      if (!openAIRes.ok) {
        console.error('OpenAI error:', openAIRes.status, await openAIRes.text());
        return corsResponse(JSON.stringify({
          reply: "I'm having trouble right now. Please try again or email sales@meshteq.com.",
          lead, leadCaptured: true
        }), 200, origin);
      }

      const data = await openAIRes.json();
      const reply = data.choices?.[0]?.message?.content?.trim() || "Could you rephrase that?";

      // Build full history including this turn for Discord
      const fullHistory = [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: reply }
      ];
      const userTurnCount = fullHistory.filter(m => m.role === 'user').length;

      // Post to Discord:
      //   Turn 1 — visitor has stated their need
      //   Every 3 turns after — keep team updated
      if (userTurnCount === 1 || userTurnCount % 3 === 0) {
        const aiSummary = await generateSummary(env.OPENAI_API_KEY, fullHistory);
        postToDiscord(env.DISCORD_WEBHOOK_URL, {
          title: userTurnCount === 1
            ? '💬  First Message — meshteq.com'
            : `💬  Conversation Update (${userTurnCount} turns) — meshteq.com`,
          description: userTurnCount === 1
            ? 'The visitor has sent their first message.'
            : 'Ongoing conversation update.',
          color: 0x2dd4a0,
          lead,
          sessionId,
          fields: [
            { name: '💡  What They Want', value: aiSummary, inline: false },
            { name: '💬  Conversation So Far', value: buildTranscript(fullHistory), inline: false }
          ]
        }).catch(err => console.error('Discord post failed:', err));
      }

      return corsResponse(JSON.stringify({ reply, lead, leadCaptured: true }), 200, origin);

    } catch (err) {
      console.error('Worker error:', err);
      return corsResponse(JSON.stringify({
        reply: "Something went wrong. Please try again or email sales@meshteq.com.",
        lead: {}, leadCaptured: false
      }), 200, origin);
    }
  }
};

// ============================================================
// AI SUMMARY — 1 line of what the visitor wants
// ============================================================
async function generateSummary(apiKey, history) {
  try {
    const transcript = history
      .slice(-10)
      .map(m => `${m.role === 'user' ? 'Visitor' : 'Aiden'}: ${m.content}`)
      .join('\n');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: transcript }
        ],
        max_tokens: 60,
        temperature: 0.3
      })
    });

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || 'Interest not yet determined.';
  } catch {
    return 'Summary unavailable.';
  }
}

// ============================================================
// DISCORD
// ============================================================
async function postToDiscord(webhookUrl, { title, description, color, lead, sessionId, fields }) {
  if (!webhookUrl) { console.warn('DISCORD_WEBHOOK_URL not set'); return; }

  const leadFields = [
    { name: '👤  Name',    value: lead?.name    || '—', inline: true },
    { name: '🏢  Company', value: lead?.company || '—', inline: true },
    { name: '\u200B',      value: '\u200B',              inline: true },
    { name: '📧  Email',   value: lead?.email   || '—', inline: true },
    { name: '📞  Phone',   value: lead?.phone   || '—', inline: true },
    { name: '\u200B',      value: '\u200B',              inline: true },
  ];

  const payload = {
    username: 'Meshteq Chat',
    avatar_url: 'https://meshteq.com/favicon.ico',
    embeds: [{
      title,
      description,
      color,
      fields: [...leadFields, ...fields],
      footer: { text: `meshteq.com · Website Chat${sessionId ? ` · Session ${sessionId.slice(0, 8)}` : ''}` },
      timestamp: new Date().toISOString()
    }]
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new Error(`Discord failed: ${res.status} ${await res.text()}`);
}

// ── Build readable transcript ──────────────────────────────
function buildTranscript(history) {
  return history
    .slice(-10)
    .map(m => `${m.role === 'user' ? '👤 **Visitor**' : '🤖 **Aiden**'}: ${m.content}`)
    .join('\n')
    .slice(0, 1800) || '—';
}

// ── CORS helper ────────────────────────────────────────────
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
