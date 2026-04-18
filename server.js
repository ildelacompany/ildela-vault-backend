const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: ['https://ildela-2.myshopify.com', 'https://www.ildela.com'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ── Shopify token (refreshed every 23 hours) ──────────────────────────────────
let shopifyToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (shopifyToken && Date.now() < tokenExpiry) return shopifyToken;
  const res = await fetch('https://ildela-2.myshopify.com/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token fetch failed: ' + JSON.stringify(data));
  shopifyToken = data.access_token;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // refresh before 24h expiry
  return shopifyToken;
}

// ── Shopify GraphQL helper ────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const token = await getToken();
  const res = await fetch('https://ildela-2.myshopify.com/admin/api/2025-01/graphql.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ── Find customer GID by email ────────────────────────────────────────────────
async function getCustomerGid(email) {
  const data = await gql(`
    query($q: String!) {
      customers(first: 1, query: $q) {
        edges { node { id } }
      }
    }
  `, { q: `email:${email}` });
  return data.customers.edges[0]?.node?.id || null;
}

// ── Load session from metafield ───────────────────────────────────────────────
async function loadSession(email) {
  const gid = await getCustomerGid(email);
  if (!gid) return null;
  const data = await gql(`
    query($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "custom", key: "vault_progress") { value }
      }
    }
  `, { id: gid });
  const raw = data.customer?.metafield?.value;
  if (!raw) return null;
  const session = JSON.parse(raw);
  session._gid = gid;
  return session;
}

// ── Save session to metafield ─────────────────────────────────────────────────
async function saveSession(session) {
  const { _gid, ...data } = session;
  await gql(`
    mutation($input: CustomerInput!) {
      customerUpdate(input: $input) {
        userErrors { field message }
      }
    }
  `, {
    input: {
      id: _gid,
      metafields: [{
        namespace: 'custom',
        key: 'vault_progress',
        type: 'json',
        value: JSON.stringify(data)
      }]
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/start', async (req, res) => {
  const { email, questions } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!questions?.length) return res.status(400).json({ error: 'Questions required' });

  try {
    const existing = await loadSession(email);
    if (existing) {
      return res.json({
        index: existing.index,
        total: existing.assigned.length,
        assigned: existing.assigned,
        lockoutCount: existing.lockoutCount
      });
    }

    const gid = await getCustomerGid(email);
    if (!gid) return res.status(404).json({ error: 'Customer not found in Shopify' });

    const first = questions.find(q => q.is_first) || questions[0];
    const rest = shuffle(questions.filter(q => !q.is_first));
    const count = Math.floor(Math.random() * 3) + 5;
    const assigned = [first, ...rest.slice(0, count - 1)].map(q => q.id);

    const session = { email, assigned, index: 0, lockoutCount: 0, _gid: gid };
    await saveSession(session);

    return res.json({ index: 0, total: assigned.length, assigned, lockoutCount: 0 });
  } catch (e) {
    console.error('/start error:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/advance', async (req, res) => {
  const { email, outcome } = req.body;

  try {
    const s = await loadSession(email);
    if (!s) return res.status(404).json({ error: 'No session' });

    if (outcome === 'failed') {
      const failedId = s.assigned[s.index];
      s.assigned.splice(s.index, 1);
      s.assigned.push(failedId);
      s.lockoutCount++;
    } else {
      s.index++;
    }

    await saveSession(s);

    const complete = s.index >= s.assigned.length;
    return res.json({
      index: s.index,
      total: s.assigned.length,
      assigned: s.assigned,
      lockoutCount: s.lockoutCount,
      complete
    });
  } catch (e) {
    console.error('/advance error:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('Vault running'));
