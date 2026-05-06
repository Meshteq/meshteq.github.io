// ============================================================
// meshteq-chat-worker.js — v5
// Cloudflare Worker — Meshteq Website Chatbot
//
// Required Secrets:
//   OPENAI_API_KEY      — OpenAI API key
//   DISCORD_WEBHOOK_URL — Discord webhook for #website-chat
//
// Request types handled:
//   chat (no type field) → call OpenAI, return reply. No Discord.
//   summary              → visitor ended chat. ONE Discord message:
//                          lead info + visitor questions + AI summary.
//                          Bot answers are never sent to Discord.
// ============================================================

const ALLOWED_ORIGIN = 'https://meshteq.com';

function buildSystemPrompt(lead) {
  const ctx = lead?.name
    ? `\n\n## Visitor context (already collected — do NOT ask again)\nName: ${lead.name}\nCompany: ${lead.company || '—'}\nPhone: ${lead.phone || '—'}\nEmail: ${lead.email || '—'}\nUse their first name naturally in conversation.`
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
- Do NOT end replies with "Is there anything else I can help you with?" — the widget handles follow-up prompts automatically.
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
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return cors(null, 204, origin);
    if (request.method !== 'POST')    return cors(JSON.stringify({ error: 'Method not allowed' }), 405, origin);

    let body;
    try {
      body = await request.json();
    } catch {
      return cors(JSON.stringify({ error: 'Invalid JSON' }), 400, origin);
    }

    const { type, message, history = [], lead = {}, sessionId = '' } = body;

    try {

      // ── SUMMARY ───────────────────────────────────────────
      // Triggered once: visitor clicks "End chat" or closes widget.
      // Sends ONE Discord embed: lead + visitor questions + AI summary.
      // Bot replies are intentionally excluded.
      if (type === 'summary') {
        const userMessages = Array.isArray(history)
          ? history.filter(m => m.role === 'user')
          : [];

        if (userMessages.length === 0) {
          return cors(JSON.stringify({ ok: true }), 200, origin);
        }

        // Numbered question list — stays within Discord 1024 char field limit
        let questionsText = '';
        for (let i = 0; i < userMessages.length; i++) {
          const line = `${i + 1}. ${userMessages[i].content.trim()}`;
          const candidate = questionsText ? `${questionsText}\n${line}` : line;
          if (candidate.length > 980) {
            const remaining = userMessages.length - i;
            questionsText += `\n_...${remaining} more question${remaining > 1 ? 's' : ''} not shown_`;
            break;
          }
          questionsText = candidate;
        }

        // AI summary of the full conversation
        let summary = 'Summary unavailable';
        try {
          summary = await aiSummary(env.OPENAI_API_KEY, history);
        } catch (e) {
          console.error('aiSummary failed:', e);
        }

        await discord(env.DISCORD_WEBHOOK_URL, {
          title:     '🔚  Chat Summary — meshteq.com',
          desc:      'A visitor has completed their chat session.',
          color:     0xf0b440,
          lead,
          sessionId,
          fields: [
            {
              name:   '💡  What They Want',
              value:  summary.slice(0, 1000) || '—',
              inline: false
            },
            {
              name:   `❓  Questions Asked (${userMessages.length})`,
              value:  questionsText.trim() || '—',
              inline: false
            }
          ]
        });

        return cors(JSON.stringify({ ok: true }), 200, origin);
      }

      // ── CHAT ─────────────────────────────────────────────
      // Normal conversation turn. Calls OpenAI, returns reply.
      // No Discord posting at this stage.
      if (!message || typeof message !== 'string' || !message.trim())
        return cors(JSON.stringify({ error: 'Message required' }), 400, origin);
      if (message.length > 1000)
        return cors(JSON.stringify({ error: 'Message too long' }), 400, origin);

      const msgs = [
        { role: 'system', content: buildSystemPrompt(lead) },
        ...history.slice(-12),
        { role: 'user',   content: message.trim() }
      ];

      const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model:       'gpt-4o-mini',
          messages:    msgs,
          max_tokens:  450,
          temperature: 0.65
        })
      });

      if (!oaiRes.ok) {
        console.error('OpenAI error:', oaiRes.status, await oaiRes.text());
        return cors(JSON.stringify({
          reply: "I'm having trouble right now. Please email sales@meshteq.com."
        }), 200, origin);
      }

      const oaiData = await oaiRes.json();
      const reply   = oaiData.choices?.[0]?.message?.content?.trim() || "Could you rephrase that?";

      return cors(JSON.stringify({ reply }), 200, origin);

    } catch (err) {
      console.error('Worker error:', err);
      return cors(JSON.stringify({
        reply: "Something went wrong. Please email sales@meshteq.com."
      }), 200, origin);
    }
  }
};

// ── AI summary ───────────────────────────────────────────────
async function aiSummary(apiKey, history) {
  const text = history
    .slice(-10)
    .map(m => `${m.role === 'user' ? 'Visitor' : 'Aiden'}: ${m.content}`)
    .join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model:    'gpt-4o-mini',
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user',   content: text }
      ],
      max_tokens:  60,
      temperature: 0.3
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || 'Interest not yet determined';
}

// ── Discord embed ─────────────────────────────────────────────
async function discord(webhookUrl, { title, desc, color, lead, sessionId, fields }) {
  if (!webhookUrl) { console.warn('DISCORD_WEBHOOK_URL not set'); return; }

  const leadFields = [
    { name: '👤  Name',    value: lead?.name    || '—', inline: true },
    { name: '🏢  Company', value: lead?.company || '—', inline: true },
    { name: '\u200B',      value: '\u200B',              inline: true },
    { name: '📧  Email',   value: lead?.email   || '—', inline: true },
    { name: '📞  Phone',   value: lead?.phone   || '—', inline: true },
    { name: '\u200B',      value: '\u200B',              inline: true }
  ];

  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username:   'Meshteq Chat',
      avatar_url: 'https://meshteq.com/favicon.ico',
      embeds: [{
        title,
        description: desc,
        color,
        fields:    [...leadFields, ...fields],
        footer:    { text: `meshteq.com · Chat${sessionId ? ` · ${sessionId.slice(0, 8)}` : ''}` },
        timestamp: new Date().toISOString()
      }]
    })
  });

  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}

// ── CORS ─────────────────────────────────────────────────────
function cors(body, status, origin) {
  const allow = origin === ALLOWED_ORIGIN
    ? ALLOWED_ORIGIN
    : (origin.includes('localhost') ? origin : ALLOWED_ORIGIN);

  return new Response(body, {
    status,
    headers: {
      'Content-Type':                 'application/json',
      'Access-Control-Allow-Origin':  allow,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age':       '86400'
    }
  });
}
