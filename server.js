const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: ['https://ildela-2.myshopify.com', 'https://www.ildela.com'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const sessions = {};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Start or resume session
app.post('/start', (req, res) => {
  const { email, questions } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!questions || !questions.length) return res.status(400).json({ error: 'Questions required' });

  if (sessions[email]) {
    const s = sessions[email];
    return res.json({ index: s.index, total: s.assigned.length, assigned: s.assigned, lockoutCount: s.lockoutCount });
  }

  const first = questions.find(q => q.is_first) || questions[0];
  const rest = shuffle(questions.filter(q => !q.is_first));
  const count = Math.floor(Math.random() * 3) + 5;
  const assigned = [first, ...rest.slice(0, count - 1)].map(q => q.id);

  sessions[email] = { email, assigned, index: 0, lockoutCount: 0 };
  return res.json({ index: 0, total: assigned.length, assigned, lockoutCount: 0 });
});

// Called only when a question is solved or failed
app.post('/advance', (req, res) => {
  const { email, outcome } = req.body; // outcome: 'solved' | 'failed'
  const s = sessions[email];
  if (!s) return res.status(404).json({ error: 'No session' });

  if (outcome === 'failed') {
    // Move failed question to end of queue
    const failedId = s.assigned[s.index];
    s.assigned.splice(s.index, 1);
    s.assigned.push(failedId);
    s.lockoutCount++;
  } else {
    // Solved — advance index
    s.index++;
  }

  const complete = s.index >= s.assigned.length;
  return res.json({ index: s.index, total: s.assigned.length, assigned: s.assigned, lockoutCount: s.lockoutCount, complete });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('Vault running'));
