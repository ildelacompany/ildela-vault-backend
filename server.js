const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: 'https://ildela-2.myshopify.com' }));
app.use(express.json());

const progress = {};
let cachedQuestions = null;

async function fetchQuestions() {
  if (cachedQuestions) return cachedQuestions;
  const query = `{
    metaobjects(type: "vault_question", first: 100) {
      edges {
        node {
          id
          fields { key value }
        }
      }
    }
  }`;
  const res = await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query })
  });
  const json = await res.json();
  const questions = json.data.metaobjects.edges.map((e, i) => {
    const f = {};
    e.node.fields.forEach(field => f[field.key] = field.value);
    f.id = i + 1;
    f.is_first = f.is_first === 'true';
    f.answer_length = parseInt(f.answer_length);
    return f;
  });
  cachedQuestions = questions;
  return questions;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getSafeState(email) {
  const s = progress[email];
  return { index: s.index, total: s.assigned.length, strikes: s.strikes, locked: s.locked, lockedUntil: s.lockedUntil, guessed: s.guessed };
}

app.post('/start', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (progress[email]) return res.json(getSafeState(email));
  const questions = await fetchQuestions();
  const first = questions.find(q => q.is_first) || questions[0];
  const rest = shuffle(questions.filter(q => !q.is_first));
  const count = Math.floor(Math.random() * 3) + 5;
  const assigned = [first, ...rest.slice(0, count - 1)].map(q => q.id);
  progress[email] = { email, assigned, index: 0, strikes: 0, locked: false, lockedUntil: null, guessed: [], lockoutCount: 0 };
  return res.json(getSafeState(email));
});

app.post('/question', async (req, res) => {
  const { email } = req.body;
  const state = progress[email];
  if (!state) return res.status(404).json({ error: 'No session' });
  if (state.index >= state.assigned.length) return res.json({ complete: true });
  const questions = await fetchQuestions();
  const q = questions.find(q => q.id === state.assigned[state.index]);
  res.json({
    display_text: q.display_text,
    answer_length: q.answer_length,
    guessed: state.guessed,
    strikes: state.strikes,
    index: state.index,
    total: state.assigned.length,
    locked: state.locked,
    lockedUntil: state.lockedUntil
  });
});

app.post('/guess', async (req, res) => {
  const { email, letter } = req.body;
  const state = progress[email];
  if (!state) return res.status(404).json({ error: 'No session' });
  if (state.locked) return res.status(403).json({ error: 'Locked' });
  const questions = await fetchQuestions();
  const q = questions.find(q => q.id === state.assigned[state.index]);
  const answer = q.answer_display.toUpperCase();
  const L = letter.toUpperCase();
  const isCorrect = answer.includes(L);
  state.guessed.push(L);
  if (!isCorrect) state.strikes++;
  const won = answer.split('').every(ch => ch === ' ' || state.guessed.includes(ch));
  if (state.strikes >= 5) {
    const failed = state.assigned[state.index];
    state.assigned.splice(state.index, 1);
    state.assigned.push(failed);
    state.guessed = [];
    state.strikes = 0;
    state.locked = true;
    state.lockedUntil = Date.now() + 30000;
    state.lockoutCount = (state.lockoutCount || 0) + 1;
  } else if (won) {
    state.index++;
    state.guessed = [];
    state.strikes = 0;
  }
  res.json({
    correct: isCorrect,
    win: won,
    complete: state.index >= state.assigned.length,
    locked: state.locked,
    lockedUntil: state.lockedUntil,
    strikes: state.strikes,
    guessed: state.guessed
  });
});

// Call this to force refresh questions cache after adding new ones
app.post('/refresh-questions', (req, res) => {
  cachedQuestions = null;
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('Vault running'));
