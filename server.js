const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: ['https://ildela-2.myshopify.com', 'https://www.ildela.com'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ── Shopify token ─────────────────────────────────────────────────────────────
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
  const text = await res.text();
  console.log('TOKEN RESPONSE:', res.status, text);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error('Token fetch failed: ' + text);
  shopifyToken = data.access_token;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
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

// ── Build customer GID from numeric ID ───────────────────────────────────────
function buildGid(numericId) {
  return `gid://shopify/Customer/${numericId}`;
}

// ── Load session from metafield ───────────────────────────────────────────────
async function loadSession(customerId) {
  const gid = buildGid(customerId);
  const data = await gql(`
    query($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "custom", key: "vault_progress") { value }
        orders(first: 1, sortKey: CREATED_AT, reverse: true) {
          edges { node { id createdAt } }
        }
      }
    }
  `, { id: gid });
  const raw = data.customer?.metafield?.value;
  const orders = data.customer?.orders?.edges || [];
  const session = raw ? JSON.parse(raw) : null;
  return { session, orders, gid };
}

// ── Save session to metafield ─────────────────────────────────────────────────
async function saveSession(gid, data) {
  await gql(`
    mutation($input: CustomerInput!) {
      customerUpdate(input: $input) {
        userErrors { field message }
      }
    }
  `, {
    input: {
      id: gid,
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
  const { customerId, questions } = req.body;
  if (!customerId) return res.status(400).json({ error: 'customerId required' });
  if (!questions?.length) return res.status(400).json({ error: 'Questions required' });

  try {
    const { session, orders, gid } = await loadSession(customerId);

    if (session) {
      return res.json({
        index: session.index,
        total: session.assigned.length,
        assigned: session.assigned,
        lockoutCount: session.lockoutCount,
        q5SolvedAt: session.q5SolvedAt || null,
        purchased: session.purchased || false
      });
    }

    const first = questions.find(q => q.is_first) || questions[0];
    const rest = shuffle(questions.filter(q => !q.is_first));
    const count = Math.floor(Math.random() * 3) + 5;
    const assigned = [first, ...rest.slice(0, count - 1)].map(q => q.id);

    const newSession = {
      customerId,
      assigned,
      index: 0,
      lockoutCount: 0,
      q5SolvedAt: null,
      purchased: false
    };
    await saveSession(gid, newSession);

    return res.json({
      index: 0,
      total: assigned.length,
      assigned,
      lockoutCount: 0,
      q5SolvedAt: null,
      purchased: false
    });
  } catch (e) {
    console.error('/start error:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/advance', async (req, res) => {
  const { customerId, outcome } = req.body;
  if (!customerId) return res.status(400).json({ error: 'customerId required' });

  try {
    const { session, orders, gid } = await loadSession(customerId);
    if (!session) return res.status(404).json({ error: 'No session' });

    if (outcome === 'failed') {
      const failedId = session.assigned[session.index];
      session.assigned.splice(session.index, 1);
      session.assigned.push(failedId);
      session.lockoutCount++;
    } else if (outcome === 'solved') {
      // If completing Q5 (index 4), save timestamp
      if (session.index === 4) {
        session.q5SolvedAt = new Date().toISOString();
      }
      session.index++;
    }

    // Check purchase gate — order must be after q5SolvedAt
    if (session.q5SolvedAt && !session.purchased) {
      const q5Time = new Date(session.q5SolvedAt).getTime();
      const hasValidOrder = orders.some(edge => {
        return new Date(edge.node.createdAt).getTime() > q5Time;
      });
      if (hasValidOrder) session.purchased = true;
    }

    await saveSession(gid, session);

    return res.json({
      index: session.index,
      total: session.assigned.length,
      assigned: session.assigned,
      lockoutCount: session.lockoutCount,
      q5SolvedAt: session.q5SolvedAt,
      purchased: session.purchased,
      complete: session.index >= session.assigned.length
    });
  } catch (e) {
    console.error('/advance error:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('Vault running'));
