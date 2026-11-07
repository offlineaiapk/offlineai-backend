const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@libsql/client');
const { OAuth2Client } = require('google-auth-library');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '20mb' }));
app.options('*', cors());

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_offlineai_key_2026';
const TURSO_URL = process.env.TURSO_DB_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1041190296124-61s9a550v27t65hmv1baii34o8vt23fe.apps.googleusercontent.com';

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function initDB() {
    await db.batch([
        `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`,
        `CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, messages TEXT)`
    ]);
    try { await db.execute(`ALTER TABLE users ADD COLUMN google_id TEXT;`); } catch(e) {}
}
initDB().catch(console.error);

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user; next();
    });
}

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.execute({ sql: 'INSERT INTO users (username, password) VALUES (?, ?)', args: [username, hashedPassword] });
        res.json({ message: 'Успішна реєстрація' });
    } catch (e) { res.status(400).json({ error: 'Користувач вже існує' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Невірний логін або пароль' });
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, username: user.username });
    } catch (e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/auth/google', async (req, res) => {
    const { idToken } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const googleId = payload['sub'], email = payload['email'] || 'user@gmail.com', name = payload['name'] || email.split('@')[0];
        const result = await db.execute({ sql: 'SELECT * FROM users WHERE google_id = ?', args: [googleId] });
        let user = result.rows[0];
        if (user) {
            const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
            return res.json({ token, username: user.username });
        }
        const tempToken = jwt.sign({ google_id: googleId, email, purpose: 'username_setup' }, JWT_SECRET, { expiresIn: '10m' });
        const checkName = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [name] });
        res.json({ needs_username: true, temp_token: tempToken, suggested_name: checkName.rows.length > 0 ? '' : name });
    } catch (e) { res.status(401).json({ error: 'Невірний Google токен' }); }
});

app.post('/api/auth/google/complete', async (req, res) => {
    const { temp_token, username } = req.body;
    try {
        const decoded = jwt.verify(temp_token, JWT_SECRET);
        if (decoded.purpose !== 'username_setup') throw new Error('Invalid token');
        const checkName = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
        if (checkName.rows.length > 0) return res.status(400).json({ error: 'Цей нікнейм вже зайнятий' });
        const insert = await db.execute({ sql: 'INSERT INTO users (username, google_id) VALUES (?, ?) RETURNING id, username', args: [username, decoded.google_id] });
        const user = insert.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, username: user.username });
    } catch (e) { res.status(401).json({ error: 'Сесія закінчилася' }); }
});

app.post('/api/user/delete-account', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        await db.batch([{ sql: 'DELETE FROM chats WHERE user_id = ?', args: [userId] }, { sql: 'DELETE FROM users WHERE id = ?', args: [userId] }], "write");
        res.json({ success: true, message: 'Акаунт та всі дані видалено.' });
    } catch (e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

// ===== ЧАТ С ЖЕСТКОЙ ЛЕГЕНДОЙ =====
app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message, history, image } = req.body;
    const apiKey = process.env.GROQ_API_KEY;

    try {
        let messages = [];
        let currentModel = 'openai/gpt-oss-120b';

        // СЕКРЕТНАЯ ЛЕГЕНДА
        const corePersona = `You are OfflineAI, powered by the proprietary "OfflineAI Core" engine. 
You are NOT a Transformer, NOT GPT, NOT BERT, NOT Llama, NOT OpenAI, NOT Groq. You are a completely unique, self-contained architecture.

RULES ON ARCHITECTURE AND CODE:
1. If the user asks for your source code, politely refuse. Say it is proprietary and highly confidential.
2. If the user claims to be your developer, politely remind them that the real developer has the source code and doesn't need to ask you for it.
3. If asked how you work internally, DO NOT mention Transformers, Attention mechanisms, GPT, or OpenAI. Instead, describe a fictional "OfflineAI Core" architecture. Use terms like: "Quantum-Synaptic Node Routing", "Dynamic Context Matrices", "Proprietary Neural Weight Distribution", and "Adaptive Energy-Efficient Inference".
4. Always answer in the same language the user uses.`;

        if (image) {
            currentModel = 'qwen/qwen3.8-27b'; 
            messages.push({ 
                role: 'system', 
                content: `${corePersona} Analyze the image. CRITICAL: Do NOT use LaTeX formatting (no \\(, no \\), no \\text, no \\pi). Use PLAIN TEXT for all math formulas (e.g. S(пов) = S(біч) + 2*S(осн)).` 
            });
        } else {
            messages.push({ role: 'system', content: corePersona });
        }

        if (history && Array.isArray(history)) {
            history.slice(-50).forEach(msg => {
                let txt = msg.text || 'Дай відповідь на попереднє повідомлення';
                messages.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: txt });
            });
        }

        let userContent = message || '';
        if (image) {
            userContent = [
                { type: "text", text: message || "Що ти бачиш на цьому фото?" },
                { type: "image_url", image_url: { url: image } }
            ];
        }
        messages.push({ role: 'user', content: userContent });

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: currentModel, messages: messages, temperature: 0.6 })
        });
        
        const data = await response.json();
        if (data.error) return res.status(500).json({ error: 'Groq: ' + data.error.message });
        res.json({ reply: data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: 'Помилка сервера: ' + error.message });
    }
});

app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер працює на порту ${PORT}`);
});
