// ============================================================
// meshteq-chat-worker.js — v4
// Cloudflare Worker — Meshteq Website Chatbot
//
// Required Secrets:
//   OPENAI_API_KEY      — OpenAI API key
//   DISCORD_WEBHOOK_URL — Discord webhook for #website-chat
//
// Request types handled:
//   init                → form submitted, post 🎯 New Visitor to Discord
//   chat (no type)      → normal message, post after turn 1 + every 3 turns
//   summary             → page close beacon, post 🔚 Session Ended + AI summary
// ============================================================

const ALLOWED_ORIGIN = 'https://meshteq.com';

function buildSystemPrompt(lead) {
  const ctx = lead?.name
    ? `\n\n## Visitor (already collected — do NOT ask again)\nName: ${lead.name}\nCompany: ${lead.company || '—'}\nPhone: ${lead.phone || '—'}\nEmail: ${lead.email || '—'}\nUse their first name naturally in conversation.`
    : '';

  return `You are Aiden, the virtual assistant for Meshteq Sdn Bhd on meshteq.com.${ctx}

## About Meshteq
Malaysian technology company specialising in Industrial IoT and AI SaaS. We connect physical assets to intelligent cloud systems — real-time monitoring, predictive maintenance, data-driven decisions.

## Products & Services
- **meshteq.ai** — IoT Connectivity Platform: device provisioning, LoRaWAN deployment, sensor data pipelines.
- **PrimeTune.ai** — Equipment Performance Monitoring SaaS: real-time dashboards, AI anomaly detection. Oil & gas, manufacturing, utilities, plantation.
- **PrimeModel.ai** — Industrial AI model training and inference: predictive maintenance, process optimisation.
- **IoT Engineering Services** — Firmware (LoRaWAN, BLE, GSM), protocol bridging (Modbus/4-20mA to MQTT), field integration.
- **ESG & GHG Monitoring** — IoT environmental monitoring for ESG reporting and regulatory compliance.

## Guidelines
- Professional, warm, concise — 2 to 4 sentences per reply.
- Never ask for contact details — already collected.
- Never invent pricing. Say: "Our team will walk you through pricing based on your requirements."
- If visitor is ready to move forward, confirm that sales@meshteq.com will follow up.`;
}

const SUMMARY_SYSTEM = `Summarise this website chat in ONE sentence (max 20 words).
Focus on what the visitor wants or is interested in.
Examples:
- "Interested in PrimeTune.ai for equipment monitoring at an oil and gas site"
- "Looking for LoRaWAN gateway deployment and sensor integration services"
Reply with the summary only — no preamble, no full stop.`;

// ============================================================
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return cors(null, 204, origin);
    if (request.method !== 'POST')    return cors(JSON.stringify({ error: 'Method not allowed' }), 405, origin);

    // sendBeacon may not set Content-Type — accept both cases
    const ct = request.headers.get('Content-Type') || '';
    let body;
    try {
      body = await request.json();
    } catch {
      return cors(JSON.stringify({ error: 'Invalid JSON' }), 400, origin);
    }

    const { type, message, history = [], lead = {}, sessionId = '' } = body;

    try {
      // ── INIT: pre-chat form submitted ─────────────────────
      if (type === 'init') {
        await discord(env.DISCORD_WEBHOOK_URL, {
          title: '🎯  New Visitor — meshteq.com',
          desc:  'A visitor has submitted their details and opened the chat.',
          color: 0x4a94f0,
          lead, sessionId, fields: []
        });

        const first = lead.name?.split(' ')[0] || 'there';
        const co    = lead.company ? ` from ${lead.company}` : '';
        return cors(JSON.stringify({
          reply: `Hi ${first}${co}! 👋 Thanks for reaching out — I'm Aiden, Meshteq's virtual assistant.\n\nHow can I help you today? Tell me what challenge you're looking to solve or ask about any of our solutions.`,
          lead, leadCaptured: true
        }), 200, origin);
      }

      // ── SUMMARY: sendBeacon on page close ─────────────────
      if (type === 'summary') {
        if (Array.isArray(history) && history.length > 0) {
          const summary = await aiSummary(env.OPENAI_API_KEY, history);
          await discord(env.DISCORD_WEBHOOK_URL, {
            title: '🔚  Session Ended — meshteq.com',
            desc:  'The visitor has left the page.',
            color: 0xf0b440,
            lead, sessionId,
            fields: [
              { name: '💡  What They Want',   value: summary,              inline: false },
              { name: '💬  Full Conversation', value: transcript(history),  inline: false }
            ]
          });
        }
        return cors(JSON.stringify({ ok: true }), 200, origin);
      }

      // ── CHAT: normal conversation turn ────────────────────
      if (!message || typeof message !== 'string' || !message.trim())
        return cors(JSON.stringify({ error: 'Message required' }), 400, origin);
      if (message.length > 1000)
        return cors(JSON.stringify({ error: 'Message too long' }), 400, origin);

      const msgs = [
        { role: 'system',    content: buildSystemPrompt(lead) },
        ...history.slice(-12),
        { role: 'user',      content: message.trim() }
      ];

      const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: msgs, max_tokens: 450, temperature: 0.65 })
      });

      if (!oaiRes.ok) {
        console.error('OpenAI error:', oaiRes.status, await oaiRes.text());
        return cors(JSON.stringify({ reply: "I'm having trouble right now. Please email sales@meshteq.com.", lead, leadCaptured: true }), 200, origin);
      }

      const oaiData = await oaiRes.json();
      const reply = oaiData.choices?.[0]?.message?.content?.trim() || "Could you rephrase that?";

      // Full history including this turn
      const full = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];
      const userTurns = full.filter(m => m.role === 'user').length;

      // Post to Discord: after turn 1 (intent clear) and every 3 turns after
      if (userTurns === 1 || userTurns % 3 === 0) {
        const summary = await aiSummary(env.OPENAI_API_KEY, full);
        discord(env.DISCORD_WEBHOOK_URL, {
          title: userTurns === 1
            ? '💬  First Message — meshteq.com'
            : `💬  Conversation Update (${userTurns} turns) — meshteq.com`,
          desc:  userTurns === 1 ? 'The visitor has sent their first message.' : 'Ongoing conversation.',
          color: 0x2dd4a0,
          lead, sessionId,
          fields: [
            { name: '💡  What They Want',      value: summary,             inline: false },
            { name: '💬  Conversation So Far', value: transcript(full),    inline: false }
          ]
        }).catch(e => console.error('Discord post failed:', e));
      }

      return cors(JSON.stringify({ reply, lead, leadCaptured: true }), 200, origin);

    } catch (err) {
      console.error('Worker error:', err);
      return cors(JSON.stringify({ reply: "Something went wrong. Please email sales@meshteq.com.", lead: {}, leadCaptured: false }), 200, origin);
    }
  }
};

// ── AI summary ───────────────────────────────────────────────
async function aiSummary(apiKey, history) {
  try {
    const text = history.slice(-10).map(m => `${m.role === 'user' ? 'Visitor' : 'Aiden'}: ${m.content}`).join('\n');
    const res  = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: text }],
        max_tokens: 60, temperature: 0.3
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || 'Interest not yet determined.';
  } catch { return 'Summary unavailable.'; }
}

// ── Discord post ─────────────────────────────────────────────
async function discord(webhookUrl, { title, desc, color, lead, sessionId, fields }) {
  if (!webhookUrl) { console.warn('DISCORD_WEBHOOK_URL not set'); return; }

  const leadFields = [
    { name: '👤  Name',    value: lead?.name    || '—', inline: true },
    { name: '🏢  Company', value: lead?.company || '—', inline: true },
    { name: '\u200B',      value: '\u200B',              inline: true },
    { name: '📧  Email',   value: lead?.email   || '—', inline: true },
    { name: '📞  Phone',   value: lead?.phone   || '—', inline: true },
    { name: '\u200B',      value: '\u200B',              inline: true },
  ];

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Meshteq Chat',
      avatar_url: 'https://meshteq.com/favicon.ico',
      embeds: [{
        title, description: desc, color,
        fields: [...leadFields, ...fields],
        footer: { text: `meshteq.com · Chat${sessionId ? ` · ${sessionId.slice(0,8)}` : ''}` },
        timestamp: new Date().toISOString()
      }]
    })
  });

  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}

// ── Transcript builder ───────────────────────────────────────
function transcript(history) {
  return history.slice(-10)
    .map(m => `${m.role === 'user' ? '👤 **Visitor**' : '🤖 **Aiden**'}: ${m.content}`)
    .join('\n').slice(0, 1800) || '—';
}

// ── CORS ─────────────────────────────────────────────────────
function cors(body, status, origin) {
  const allow = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : (origin.includes('localhost') ? origin : ALLOWED_ORIGIN);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
