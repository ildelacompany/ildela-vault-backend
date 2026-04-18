const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: ['https://ildela-2.myshopify.com', 'https://www.ildela.com'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const progress = {};

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
  return {
    index: s.index,
    total: s.assigned.length,
    strikes: s.strikes,
    locked: s.locked,
    lockedUntil: s.lockedUntil,
    guessed: s.guessed,
    assigned: s.assigned
  };
}

app.post('/start', (req, res) => {
  const { email, questions } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!questions || !questions.length) return res.status(400).json({ error: 'Questions required' });

  // Return existing progress if session exists
  if (progress[email]) return res.json(getSafeState(email));

  // First time — assign questions
  const first = questions.find(q => q.is_first) || questions[0];
  const rest = shuffle(questions.filter(q => !q.is_first));
  const count = Math.floor(Math.random() * 3) + 5;
  const assigned = [first, ...rest.slice(0, count - 1)].map(q => q.id);

  progress[email] = {
    email,
    assigned,
    index: 0,
    strikes: 0,
    locked: false,
    lockedUntil: null,
    guessed: [],
    lockoutCount: 0
  };

  return res.json(getSafeState(email));
});

app.post('/guess', (req, res) => {
  const { email, letter, answer_display } = req.body;
  const state = progress[email];
  if (!state) return res.status(404).json({ error: 'No session' });
  if (state.locked) return res.status(403).json({ error: 'Locked' });

  const answer = answer_display.toUpperCase();
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
    guessed: state.guessed,
    index: state.index
  });
});

app.post('/refresh-questions', (req, res) => {
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('Vault running'));
