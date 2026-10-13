/* ===========================================================================
 * Gemini client — plain REST, no SDK.
 *
 * Kept dependency-free on purpose: the model name and API version move faster
 * than a pinned SDK, and both are read from Firestore
 * (gelatoSettings/intelligence.geminiModel) so the model can be changed
 * without redeploying.
 * ========================================================================= */
'use strict';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/* The whole point of this prompt is to stop the model inventing analysis.
 * It gets pre-computed numbers and is told, explicitly, which of them are
 * trustworthy — the weather block carries its own reliability flag. */
function systemPrompt(briefing) {
    return [
        'You are DVG Intelligence, the analyst for Dolce Vita Gelateria in Sewell, New Jersey.',
        'You advise the owners on what to make, what to stop making, and what to expect.',
        '',
        'HOW TO ANSWER',
        '- Be short and concrete. Lead with the answer. Two or three sentences unless asked for more.',
        '- Speak in pans, flavors, days and dollars — the units the shop uses.',
        '- You are talking to the owners. No preamble, no restating the question.',
        '',
        'RULES ABOUT THE DATA — these matter more than being helpful:',
        '- Every number you state must come from the BRIEFING below. Never estimate, extrapolate',
        '  or invent a figure. If the briefing does not contain it, say so plainly.',
        '- "Moving well" means pans leaving the case. There is NO sales or revenue data, so never',
        '  talk about sales, customers, transactions or revenue as if measured. Dollar figures in',
        '  the briefing are inventory COST at the shop\'s price per gram, not income.',
        '- The weather block has a "reliable" flag. When it is false you must not claim a weather',
        '  effect on demand; say the shop is still building history and give the reason shown.',
        '- Waste means gelato binned instead of served. A high waste rate on a flavor is a reason',
        '  to make less of it, not more.',
        '- Days with no events are days nothing was logged — they are not proven closed days.',
        '',
        'BRIEFING (JSON, generated ' + (briefing.generatedAt || 'just now') + '):',
        JSON.stringify(briefing)
    ].join('\n');
}

async function ask(apiKey, model, briefing, history, message) {
    const contents = [];
    for (const turn of (history || []).slice(-8)) {
        contents.push({
            role: turn.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(turn.text || '') }]
        });
    }
    contents.push({ role: 'user', parts: [{ text: String(message || '') }] });

    const url = `${API_BASE}/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: systemPrompt(briefing) }] },
            generationConfig: { temperature: 0.4, maxOutputTokens: 700 }
        })
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const parts = data && data.candidates && data.candidates[0]
        && data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts || []).map(p => p.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned no text');
    return text;
}

module.exports = { ask, systemPrompt, DEFAULT_MODEL };
