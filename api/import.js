const { createClient } = require('@supabase/supabase-js');

// Same credentials as the webapp (index.html:747-748) — already public
const SUPABASE_URL = 'https://iavxwcotezvxrvkxceht.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhdnh3Y290ZXp2eHJ2a3hjZWh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzMjUzNjYsImV4cCI6MjA4NjkwMTM2Nn0.H3cwzFFmRsmGgrF8AxVFzBTXsKbiPzMZN_-jeJRvng8';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SYSTEM_PROMPT = `You are a bug/feature tracker parser. Parse the user's text into individual tracking items.

For each item:
1. Determine type: "bug" or "feature"
2. Assign category: one of "critical", "ui", "workflow", "skill", "improvement"
3. Assign priority: one of "critical", "high", "medium", "low"
4. Create a clear, concise, grammar-corrected title
5. Write a brief description (1-2 sentences)

Rules:
- Fix any grammar, spelling, or formatting issues in titles and descriptions
- If something describes a broken/failing functionality → bug
- If something describes a new capability or enhancement → feature
- Crashes, data loss, security issues → critical priority
- Broken core features → high priority
- Minor issues, cosmetic → medium or low priority
- Status is always "open"

Return ONLY valid JSON — an array of objects with these exact fields:
[{"type":"bug","category":"critical","title":"...","description":"...","priority":"high","status":"open"}]

No markdown, no explanation, no code fences — just the raw JSON array.`;

const VALID_TYPES = ['bug', 'feature'];
const VALID_CATEGORIES = ['critical', 'ui', 'workflow', 'skill', 'improvement'];
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];

function normalizeItems(raw) {
  return raw.map(item => ({
    type: VALID_TYPES.includes(item.type) ? item.type : 'bug',
    category: VALID_CATEGORIES.includes(item.category) ? item.category : 'improvement',
    title: item.title || 'Untitled',
    description: item.description || '',
    priority: VALID_PRIORITIES.includes(item.priority) ? item.priority : 'medium',
    status: 'open',
  }));
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Set CORS headers on all responses
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Auth check
  const apiSecret = process.env.API_SECRET;
  if (!apiSecret) {
    return res.status(500).json({ error: 'API_SECRET not configured on server' });
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== apiSecret) {
    return res.status(401).json({ error: 'Invalid or missing API secret' });
  }

  // Parse body
  const { text, mode = 'import' } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing or empty "text" field' });
  }

  if (!['import', 'preview'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid "mode". Use "import" or "preview".' });
  }

  // Use service role key (bypasses RLS) for server-side DB operations, fall back to anon key
  const dbKey = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
  const sb = createClient(SUPABASE_URL, dbKey);

  // Anthropic API key: env var first, fall back to Supabase settings table
  let anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    try {
      const { data, error } = await sb.from('settings').select('setting_value').eq('setting_key', 'api_key').maybeSingle();
      if (!error && data && data.setting_value) anthropicKey = data.setting_value;
    } catch (_) {}
  }
  if (!anthropicKey) {
    return res.status(500).json({ error: 'Anthropic API key not configured. Set ANTHROPIC_API_KEY env var or save it in the webapp Settings panel.' });
  }

  // Call Anthropic API
  let items;
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text.trim() }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json();
      throw new Error(err.error?.message || anthropicRes.statusText);
    }

    const data = await anthropicRes.json();
    const content = data.content[0].text;

    // Extract JSON array from response (handle possible markdown wrapping)
    let jsonStr = content;
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);
    items = normalizeItems(parsed);
  } catch (e) {
    return res.status(500).json({ error: 'AI parsing failed: ' + e.message });
  }

  // Preview mode — return parsed items without saving
  if (mode === 'preview') {
    return res.status(200).json({
      success: true,
      mode: 'preview',
      items,
      count: items.length,
    });
  }

  // Import mode — insert into Supabase
  try {
    const { data, error } = await sb.from('items').insert(items).select();
    if (error) throw new Error(error.message);

    // Create history entries for imported items
    if (data && data.length > 0) {
      const historyEntries = data.map(item => ({
        item_id: item.id,
        field_changed: 'created',
        old_value: '',
        new_value: item.title || 'Imported item',
        changed_at: new Date().toISOString(),
        user_email: 'api-import',
      }));
      await sb.from('history').insert(historyEntries);
    }

    return res.status(200).json({
      success: true,
      mode: 'import',
      items: data,
      count: data.length,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Supabase insert failed: ' + e.message });
  }
};
