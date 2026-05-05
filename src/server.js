const express = require('express');
const path = require('path');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin1234';
const DB_PATH = process.env.DB_PATH || '/data/quiz.db';

// ─── DB Init ──────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    deadline TEXT,
    results_published INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    type TEXT DEFAULT 'multiple_choice',
    options TEXT,
    correct_index INTEGER,
    correct_number REAL,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    label TEXT,
    alias TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    question_id INTEGER NOT NULL,
    selected_index INTEGER,
    text_answer TEXT,
    number_answer REAL,
    is_correct INTEGER,
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(token, question_id)
  );
`);

// ─── Migrations ───────────────────────────────────────────────
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

if (!columnExists('questions', 'quiz_id')) {
  const qid = db.prepare("INSERT INTO quizzes (name) VALUES (?)").run('Standard-Quiz').lastInsertRowid;
  db.exec(`ALTER TABLE questions ADD COLUMN quiz_id INTEGER DEFAULT ${qid}`);
  db.prepare(`UPDATE questions SET quiz_id=? WHERE quiz_id IS NULL`).run(qid);
}
if (!columnExists('tokens', 'quiz_id')) {
  const qid = (db.prepare("SELECT id FROM quizzes ORDER BY id LIMIT 1").get() || { id: db.prepare("INSERT INTO quizzes (name) VALUES (?)").run('Standard-Quiz').lastInsertRowid }).id;
  db.exec(`ALTER TABLE tokens ADD COLUMN quiz_id INTEGER DEFAULT ${qid}`);
  db.prepare(`UPDATE tokens SET quiz_id=? WHERE quiz_id IS NULL`).run(qid);
}
if (!columnExists('questions', 'type'))         db.exec(`ALTER TABLE questions ADD COLUMN type TEXT DEFAULT 'multiple_choice'`);
if (!columnExists('questions', 'correct_number')) db.exec(`ALTER TABLE questions ADD COLUMN correct_number REAL`);
// Ensure any legacy rows get a non-null type
db.prepare(`UPDATE questions SET type='multiple_choice' WHERE type IS NULL OR type=''`).run();

// Legacy schema migration: old DB had NOT NULL on options/correct_index. Non-MC question types need these nullable.
// SQLite can't drop NOT NULL via ALTER, so rebuild the table if needed.
(function migrateQuestionsNullable() {
  const cols = db.prepare(`PRAGMA table_info(questions)`).all();
  const optCol = cols.find(c => c.name === 'options');
  const ciCol  = cols.find(c => c.name === 'correct_index');
  const needsRebuild = (optCol && optCol.notnull === 1) || (ciCol && ciCol.notnull === 1);
  if (!needsRebuild) return;
  console.log('Migration: rebuilding questions table to drop NOT NULL on options/correct_index...');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE questions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      type TEXT DEFAULT 'multiple_choice',
      options TEXT,
      correct_index INTEGER,
      correct_number REAL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec(`INSERT INTO questions_new (id, quiz_id, question, type, options, correct_index, correct_number, sort_order, created_at)
      SELECT id, quiz_id, question, COALESCE(type,'multiple_choice'), options, correct_index, correct_number, COALESCE(sort_order,0), created_at FROM questions`);
    db.exec(`DROP TABLE questions`);
    db.exec(`ALTER TABLE questions_new RENAME TO questions`);
    db.exec('COMMIT');
    console.log('Migration: questions table rebuilt successfully.');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Migration failed:', e.message);
  }
})();
if (!columnExists('answers', 'text_answer'))    db.exec(`ALTER TABLE answers ADD COLUMN text_answer TEXT`);
if (!columnExists('answers', 'number_answer'))  db.exec(`ALTER TABLE answers ADD COLUMN number_answer REAL`);

// Legacy schema migration: old DB had NOT NULL on answers.selected_index and answers.is_correct.
// Free text and estimation answers need these nullable.
(function migrateAnswersNullable() {
  const cols = db.prepare(`PRAGMA table_info(answers)`).all();
  const siCol = cols.find(c => c.name === 'selected_index');
  const icCol = cols.find(c => c.name === 'is_correct');
  const needsRebuild = (siCol && siCol.notnull === 1) || (icCol && icCol.notnull === 1);
  if (!needsRebuild) return;
  console.log('Migration: rebuilding answers table to drop NOT NULL on selected_index/is_correct...');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE answers_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      question_id INTEGER NOT NULL,
      selected_index INTEGER,
      text_answer TEXT,
      number_answer REAL,
      is_correct INTEGER,
      answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(token, question_id)
    )`);
    db.exec(`INSERT INTO answers_new (id, token, question_id, selected_index, text_answer, number_answer, is_correct, answered_at)
      SELECT id, token, question_id, selected_index, text_answer, number_answer, is_correct, answered_at FROM answers`);
    db.exec(`DROP TABLE answers`);
    db.exec(`ALTER TABLE answers_new RENAME TO answers`);
    db.exec('COMMIT');
    console.log('Migration: answers table rebuilt successfully.');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Migration failed:', e.message);
  }
})();
if (!columnExists('quizzes', 'deadline'))        db.exec(`ALTER TABLE quizzes ADD COLUMN deadline TEXT`);
if (!columnExists('quizzes', 'results_published')) db.exec(`ALTER TABLE quizzes ADD COLUMN results_published INTEGER DEFAULT 0`);
if (!columnExists('tokens', 'alias'))            db.exec(`ALTER TABLE tokens ADD COLUMN alias TEXT`);

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ─── Token generation ─────────────────────────────────────────
function randomAlphanumeric(n) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
}
function generateToken() {
  return `${randomAlphanumeric(8)}-0000-${String(Math.floor(Math.random()*10000)).padStart(4,'0')}-0000-${randomAlphanumeric(8)}`;
}

// ─── Middleware ───────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const s = req.headers['x-admin-secret'] || req.query.secret;
  if (s !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function requireToken(req, res, next) {
  const t = req.headers['x-quiz-token'] || req.query.token;
  if (!t) return res.status(401).json({ error: 'Token required' });
  const row = db.prepare(`SELECT tokens.*, quizzes.name as quiz_name, quizzes.deadline,
    quizzes.results_published FROM tokens JOIN quizzes ON tokens.quiz_id=quizzes.id WHERE tokens.token=?`).get(t);
  if (!row) return res.status(403).json({ error: 'Invalid token' });
  req.tokenRow = row;
  next();
}

// ─── Helpers ─────────────────────────────────────────────────
function isDeadlinePassed(deadline) {
  if (!deadline) return false;
  return new Date() > new Date(deadline);
}

// ─── Quiz API (participant) ───────────────────────────────────

app.get('/api/quiz/validate', requireToken, (req, res) => {
  const t = req.tokenRow;
  res.json({
    valid: true,
    label: t.label,
    alias: t.alias,
    quiz_id: t.quiz_id,
    quiz_name: t.quiz_name,
    deadline: t.deadline || null,
    deadline_passed: isDeadlinePassed(t.deadline),
    results_published: !!t.results_published
  });
});

// Set or update alias for the current token — allowed only before all questions are answered
app.post('/api/quiz/alias', requireToken, (req, res) => {
  const { alias } = req.body;
  const t = req.tokenRow;
  if (t.results_published) return res.status(403).json({ error: 'Quiz already published' });

  // Lock alias once all questions are answered
  const totalQ = db.prepare('SELECT COUNT(*) as c FROM questions WHERE quiz_id=?').get(t.quiz_id).c;
  const answeredQ = db.prepare('SELECT COUNT(*) as c FROM answers WHERE token=?').get(t.token).c;
  if (totalQ > 0 && answeredQ >= totalQ) return res.status(403).json({ error: 'Alias locked after submission' });

  const cleanAlias = (alias == null || String(alias).trim() === '') ? null : String(alias).trim().slice(0, 40);
  db.prepare('UPDATE tokens SET alias=? WHERE token=?').run(cleanAlias, t.token);
  res.json({ ok: true, alias: cleanAlias });
});

app.get('/api/quiz/questions', requireToken, (req, res) => {
  const { quiz_id, deadline, results_published } = req.tokenRow;
  const published = !!results_published;
  const questions = db.prepare(`SELECT id, question, type, options, correct_index, correct_number
    FROM questions WHERE quiz_id=? ORDER BY sort_order, id`).all(quiz_id);
  const answered = db.prepare(`SELECT question_id, selected_index, text_answer, number_answer, is_correct
    FROM answers WHERE token=?`).all(req.tokenRow.token);
  const aMap = {};
  answered.forEach(a => { aMap[a.question_id] = a; });

  const result = questions.map(q => {
    const a = aMap[q.id] || null;
    return {
      id: q.id,
      question: q.question,
      type: q.type || 'multiple_choice',
      options: q.options ? JSON.parse(q.options) : [],
      // Only reveal correct answer/number after results published
      correct_index: (published && q.type === 'multiple_choice') ? q.correct_index : undefined,
      correct_number: (published && q.type === 'estimation') ? q.correct_number : undefined,
      answered: a ? {
        selected_index: a.selected_index,
        text_answer: a.text_answer,
        number_answer: a.number_answer,
        is_correct: a.is_correct
      } : null
    };
  });
  res.json(result);
});

app.post('/api/quiz/answer', requireToken, (req, res) => {
  const { quiz_id, deadline } = req.tokenRow;
  if (isDeadlinePassed(deadline)) return res.status(403).json({ error: 'Deadline passed' });
  if (req.tokenRow.results_published) return res.status(403).json({ error: 'Results already published' });

  const { question_id, selected_index, text_answer, number_answer } = req.body;
  if (!question_id) return res.status(400).json({ error: 'Missing question_id' });

  const q = db.prepare('SELECT * FROM questions WHERE id=? AND quiz_id=?').get(question_id, quiz_id);
  if (!q) return res.status(404).json({ error: 'Question not found' });

  // Enforce sequential answering — check all previous questions are answered
  const allQ = db.prepare('SELECT id FROM questions WHERE quiz_id=? ORDER BY sort_order, id').all(quiz_id);
  const answeredIds = new Set(db.prepare('SELECT question_id FROM answers WHERE token=?').all(req.tokenRow.token).map(a => a.question_id));
  const idx = allQ.findIndex(x => x.id === q.id);
  for (let i = 0; i < idx; i++) {
    if (!answeredIds.has(allQ[i].id)) return res.status(400).json({ error: 'Must answer questions in order' });
  }

  try {
    if (q.type === 'multiple_choice') {
      if (selected_index == null) return res.status(400).json({ error: 'selected_index required' });
      const is_correct = selected_index === q.correct_index ? 1 : 0;
      db.prepare('INSERT INTO answers (token,question_id,selected_index,is_correct) VALUES (?,?,?,?)').run(req.tokenRow.token, question_id, selected_index, is_correct);
    } else if (q.type === 'free_text') {
      if (!text_answer?.trim()) return res.status(400).json({ error: 'text_answer required' });
      db.prepare('INSERT INTO answers (token,question_id,text_answer) VALUES (?,?,?)').run(req.tokenRow.token, question_id, text_answer.trim());
    } else if (q.type === 'estimation') {
      if (number_answer == null || isNaN(number_answer)) return res.status(400).json({ error: 'number_answer required' });
      db.prepare('INSERT INTO answers (token,question_id,number_answer) VALUES (?,?,?)').run(req.tokenRow.token, question_id, number_answer);
    }
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Already answered' });
    }
    console.error('Answer insert failed:', e.message);
    return res.status(500).json({ error: 'Database error: ' + e.message });
  }
  res.json({ ok: true });
});

// ─── Admin: Quizzes ───────────────────────────────────────────

app.get('/api/admin/quizzes', requireAdmin, (req, res) => {
  const quizzes = db.prepare(`SELECT q.*,
    (SELECT COUNT(*) FROM questions WHERE quiz_id=q.id) as question_count,
    (SELECT COUNT(*) FROM tokens WHERE quiz_id=q.id) as token_count
    FROM quizzes q ORDER BY q.created_at DESC`).all();
  res.json(quizzes);
});

app.post('/api/admin/quizzes', requireAdmin, (req, res) => {
  const { name, description, deadline } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO quizzes (name,description,deadline) VALUES (?,?,?)').run(name, description||null, deadline||null);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/admin/quizzes/:id', requireAdmin, (req, res) => {
  const { name, description, deadline } = req.body;
  db.prepare('UPDATE quizzes SET name=?,description=?,deadline=? WHERE id=?').run(name, description||null, deadline||null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/quizzes/:id', requireAdmin, (req, res) => {
  const qid = req.params.id;
  db.prepare('SELECT id FROM questions WHERE quiz_id=?').all(qid).forEach(q => db.prepare('DELETE FROM answers WHERE question_id=?').run(q.id));
  db.prepare('SELECT token FROM tokens WHERE quiz_id=?').all(qid).forEach(t => db.prepare('DELETE FROM answers WHERE token=?').run(t.token));
  db.prepare('DELETE FROM questions WHERE quiz_id=?').run(qid);
  db.prepare('DELETE FROM tokens WHERE quiz_id=?').run(qid);
  db.prepare('DELETE FROM quizzes WHERE id=?').run(qid);
  res.json({ ok: true });
});

// Evaluate estimation questions, publish results
app.post('/api/admin/quizzes/:id/publish', requireAdmin, (req, res) => {
  const qid = req.params.id;
  const estimationQs = db.prepare(`SELECT * FROM questions WHERE quiz_id=? AND type='estimation'`).all(qid);

  estimationQs.forEach(q => {
    if (q.correct_number == null) return;
    const answers = db.prepare('SELECT * FROM answers WHERE question_id=?').all(q.id);
    if (answers.length === 0) return;

    // Find minimum absolute deviation
    const withDev = answers.map(a => ({ ...a, dev: Math.abs((a.number_answer ?? Infinity) - q.correct_number) }));
    const minDev = Math.min(...withDev.map(a => a.dev));

    // All with min deviation get is_correct=1, others get 0
    withDev.forEach(a => {
      db.prepare('UPDATE answers SET is_correct=? WHERE id=?').run(a.dev === minDev ? 1 : 0, a.id);
    });
  });

  db.prepare('UPDATE quizzes SET results_published=1 WHERE id=?').run(qid);
  res.json({ ok: true });
});

// ─── Export / Import ─────────────────────────────────────────

function serializeQuiz(quiz) {
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY sort_order, id').all(quiz.id);
  return {
    name: quiz.name,
    description: quiz.description,
    questions: questions.map(q => {
      const base = { question: q.question, type: q.type || 'multiple_choice', sort_order: q.sort_order || 0 };
      if (base.type === 'multiple_choice') {
        base.options = q.options ? JSON.parse(q.options) : [];
        base.correct_index = q.correct_index;
      } else if (base.type === 'estimation') {
        base.correct_number = q.correct_number;
      }
      return base;
    })
  };
}

// Export a single quiz
app.get('/api/admin/quizzes/:id/export', requireAdmin, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  res.json({
    format: 'quiz-app-export',
    version: 1,
    exported_at: new Date().toISOString(),
    quizzes: [serializeQuiz(quiz)]
  });
});

// Export all quizzes
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const quizzes = db.prepare('SELECT * FROM quizzes ORDER BY created_at').all();
  res.json({
    format: 'quiz-app-export',
    version: 1,
    exported_at: new Date().toISOString(),
    quizzes: quizzes.map(serializeQuiz)
  });
});

// Import — always creates new quizzes
app.post('/api/admin/import', requireAdmin, (req, res) => {
  const data = req.body;
  if (!data || data.format !== 'quiz-app-export') {
    return res.status(400).json({ error: 'Ungültiges Dateiformat. Erwartet: quiz-app-export.' });
  }
  if (!Array.isArray(data.quizzes) || data.quizzes.length === 0) {
    return res.status(400).json({ error: 'Keine Quiz im Import enthalten.' });
  }

  const insertQuiz = db.prepare('INSERT INTO quizzes (name, description) VALUES (?, ?)');
  const insertQuestion = db.prepare(`INSERT INTO questions
    (quiz_id, question, type, options, correct_index, correct_number, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const created = [];

  try {
    const run = db.transaction(() => {
      for (const q of data.quizzes) {
        if (!q.name || !Array.isArray(q.questions)) {
          throw new Error('Ungültige Quiz-Struktur (name/questions fehlt)');
        }
        const r = insertQuiz.run(q.name, q.description || null);
        const newId = r.lastInsertRowid;
        q.questions.forEach((qu, i) => {
          if (!qu.question) throw new Error('Frage ohne Text in Quiz "' + q.name + '"');
          const type = qu.type || 'multiple_choice';
          let opts = null, ci = null, cn = null;
          if (type === 'multiple_choice') {
            if (!Array.isArray(qu.options) || qu.options.length < 2) {
              throw new Error('Multiple-Choice-Frage ohne Optionen in Quiz "' + q.name + '"');
            }
            opts = JSON.stringify(qu.options);
            ci = qu.correct_index ?? 0;
          } else if (type === 'estimation') {
            if (qu.correct_number == null || isNaN(Number(qu.correct_number))) {
              throw new Error('Schätzfrage ohne gültige Zielzahl in Quiz "' + q.name + '"');
            }
            cn = Number(qu.correct_number);
          } else if (type !== 'free_text') {
            throw new Error('Unbekannter Fragetyp: ' + type);
          }
          insertQuestion.run(newId, qu.question, type, opts, ci, cn, qu.sort_order ?? i);
        });
        created.push({ id: newId, name: q.name, question_count: q.questions.length });
      }
    });
    run();
    res.json({ ok: true, imported: created });
  } catch (e) {
    return res.status(400).json({ error: 'Import fehlgeschlagen: ' + e.message });
  }
});

// ─── Admin: Questions ─────────────────────────────────────────

app.get('/api/admin/questions', requireAdmin, (req, res) => {
  const { quiz_id } = req.query;
  if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });
  const qs = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY sort_order, id').all(quiz_id);
  res.json(qs.map(q => ({ ...q, options: q.options ? JSON.parse(q.options) : [] })));
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const { quiz_id, question, type, options, correct_index, correct_number, sort_order } = req.body;
  if (!quiz_id || !question) return res.status(400).json({ error: 'Missing fields' });
  const t = type || 'multiple_choice';
  const r = db.prepare(`INSERT INTO questions (quiz_id,question,type,options,correct_index,correct_number,sort_order)
    VALUES (?,?,?,?,?,?,?)`).run(quiz_id, question, t,
      t === 'multiple_choice' ? JSON.stringify(options||[]) : null,
      t === 'multiple_choice' ? (correct_index??0) : null,
      t === 'estimation' ? (correct_number??null) : null,
      sort_order||0);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const { question, type, options, correct_index, correct_number, sort_order } = req.body;
  const t = type || 'multiple_choice';
  db.prepare(`UPDATE questions SET question=?,type=?,options=?,correct_index=?,correct_number=?,sort_order=? WHERE id=?`)
    .run(question, t,
      t === 'multiple_choice' ? JSON.stringify(options||[]) : null,
      t === 'multiple_choice' ? (correct_index??0) : null,
      t === 'estimation' ? (correct_number??null) : null,
      sort_order||0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const { quiz_id } = req.query;
  if (req.params.id === 'ALL') {
    if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });
    db.prepare('SELECT id FROM questions WHERE quiz_id=?').all(quiz_id).forEach(q => db.prepare('DELETE FROM answers WHERE question_id=?').run(q.id));
    db.prepare('DELETE FROM questions WHERE quiz_id=?').run(quiz_id);
    return res.json({ ok: true });
  }
  db.prepare('DELETE FROM answers WHERE question_id=?').run(req.params.id);
  db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Admin: Tokens ────────────────────────────────────────────

app.get('/api/admin/tokens', requireAdmin, (req, res) => {
  const { quiz_id } = req.query;
  if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });
  res.json(db.prepare('SELECT * FROM tokens WHERE quiz_id=? ORDER BY created_at DESC').all(quiz_id));
});

app.post('/api/admin/tokens', requireAdmin, (req, res) => {
  const { quiz_id, label, count } = req.body;
  if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });
  const created = [];
  for (let i = 0; i < (count||1); i++) {
    const t = generateToken();
    db.prepare('INSERT INTO tokens (quiz_id,token,label) VALUES (?,?,?)').run(quiz_id, t, label||null);
    created.push(t);
  }
  res.json({ tokens: created });
});

app.delete('/api/admin/tokens', requireAdmin, (req, res) => {
  const { token, quiz_id } = req.query;
  if (token === 'ALL') {
    if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });
    db.prepare('SELECT token FROM tokens WHERE quiz_id=?').all(quiz_id).forEach(t => db.prepare('DELETE FROM answers WHERE token=?').run(t.token));
    db.prepare('DELETE FROM tokens WHERE quiz_id=?').run(quiz_id);
    return res.json({ ok: true });
  }
  if (!token) return res.status(400).json({ error: 'token required' });
  db.prepare('DELETE FROM answers WHERE token=?').run(token);
  db.prepare('DELETE FROM tokens WHERE token=?').run(token);
  res.json({ ok: true });
});

// ─── Admin: Results ───────────────────────────────────────────

app.get('/api/admin/results', requireAdmin, (req, res) => {
  const { quiz_id } = req.query;
  if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });
  const tokens = db.prepare('SELECT * FROM tokens WHERE quiz_id=?').all(quiz_id);
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY sort_order, id').all(quiz_id);
  const allAnswers = db.prepare(`SELECT a.* FROM answers a JOIN questions q ON a.question_id=q.id WHERE q.quiz_id=?`).all(quiz_id);
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(quiz_id);

  const results = tokens.map(t => {
    const ta = allAnswers.filter(a => a.token === t.token);
    const mcQ = questions.filter(q => q.type === 'multiple_choice');
    const score = ta.filter(a => a.is_correct === 1).length;
    const scorableTotal = questions.filter(q => q.type !== 'free_text').length;
    const detail = questions.map(q => {
      const a = ta.find(a => a.question_id === q.id);
      return {
        question_id: q.id, question: q.question, type: q.type,
        answered: !!a, is_correct: a ? a.is_correct : null,
        selected_index: a?.selected_index ?? null,
        text_answer: a?.text_answer ?? null,
        number_answer: a?.number_answer ?? null,
        correct_number: q.correct_number,
        deviation: (a?.number_answer != null && q.correct_number != null)
          ? Math.abs(a.number_answer - q.correct_number) : null
      };
    });
    return { token: t.token, label: t.label, alias: t.alias, score, scorable_total: scorableTotal, answered_count: ta.length, total: questions.length, detail };
  });
  res.json({ questions, results, quiz });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({
    totalQuizzes: db.prepare('SELECT COUNT(*) as c FROM quizzes').get().c,
    totalTokens: db.prepare('SELECT COUNT(*) as c FROM tokens').get().c,
    totalQuestions: db.prepare('SELECT COUNT(*) as c FROM questions').get().c,
    totalAnswers: db.prepare('SELECT COUNT(*) as c FROM answers').get().c,
    activeUsers: db.prepare('SELECT COUNT(DISTINCT token) as c FROM answers').get().c
  });
});

// ─── Public Scoreboard ───────────────────────────────────────
app.get('/api/scoreboard', (req, res) => {
  const { quiz_id } = req.query;
  if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });

  const quiz = db.prepare('SELECT id, name, deadline, results_published FROM quizzes WHERE id=?').get(quiz_id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

  const questions = db.prepare('SELECT id, type FROM questions WHERE quiz_id=?').all(quiz_id);
  const totalQ = questions.length;
  const scorableQ = questions.filter(q => q.type !== 'free_text').length;
  const published = !!quiz.results_published;

  // All tokens where participant has answered everything
  const tokens = db.prepare(`SELECT t.token, t.alias,
    (SELECT COUNT(*) FROM answers WHERE token=t.token) as answered_count,
    (SELECT MAX(answered_at) FROM answers WHERE token=t.token) as last_answered
    FROM tokens t WHERE t.quiz_id=?`).all(quiz_id);

  const participants = tokens
    .filter(t => totalQ > 0 && t.answered_count >= totalQ)
    .map(t => {
      const score = published
        ? db.prepare(`SELECT COUNT(*) as c FROM answers a JOIN questions q ON a.question_id=q.id
            WHERE a.token=? AND q.quiz_id=? AND a.is_correct=1`).get(t.token, quiz_id).c
        : null;
      // Fallback display name: last 4 chars of token middle segment
      const segs = t.token.split('-');
      const fallback = `Anonym ${segs[2] || '????'}`;
      return {
        alias: (t.alias && String(t.alias).trim()) ? t.alias : fallback,
        has_alias: !!(t.alias && String(t.alias).trim()),
        last_answered: t.last_answered,
        score,
        scorable_total: scorableQ
      };
    });

  // Sort: if published → by score desc, then last_answered asc; else by last_answered asc
  if (published) {
    participants.sort((a,b) => (b.score - a.score) || (new Date(a.last_answered) - new Date(b.last_answered)));
  } else {
    participants.sort((a,b) => new Date(a.last_answered) - new Date(b.last_answered));
  }

  res.json({
    quiz: { id: quiz.id, name: quiz.name, deadline: quiz.deadline, results_published: published },
    participants,
    total_questions: totalQ,
    scorable_total: scorableQ
  });
});

// ─── Pages ────────────────────────────────────────────────────
app.get('/quiz', (req, res) => res.sendFile(path.join(__dirname, '../public/quiz/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../public/admin/index.html')));
app.get('/scoreboard', (req, res) => res.sendFile(path.join(__dirname, '../public/scoreboard/index.html')));
app.get('/', (req, res) => res.redirect('/quiz'));

app.listen(PORT, () => console.log(`Quiz App running on port ${PORT}`));
