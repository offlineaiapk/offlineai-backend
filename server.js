const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@libsql/client');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.options('*', cors());

// === НАСТРОЙКИ БЕЗОПАСНОСТИ ===
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_offlineai_key_2026';
const TURSO_URL = process.env.TURSO_DB_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
    console.error("КРИТИЧЕСКАЯ ОШИБКА: Не заданы TURSO_DB_URL и TURSO_AUTH_TOKEN в Render!");
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// Инициализация таблиц
async function initDB() {
    await db.batch([
        `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`,
        `CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, messages TEXT)`
    ]);
    console.log("БД инициализирована");
}
initDB().catch(console.error);

// Мидлвар для проверки токена
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// === АВТОРИЗАЦИЯ ===
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Введіть логін та пароль' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль має бути мінімум 6 символів' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.execute({
            sql: 'INSERT INTO users (username, password) VALUES (?, ?)',
            args: [username, hashedPassword]
        });
        res.json({ message: 'Успішна реєстрація' });
    } catch (e) {
        res.status(400).json({ error: 'Користувач вже існує' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
        const user = result.rows[0];
        
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: 'Невірний логін або пароль' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, username: user.username });
    } catch (e) {
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// === ЧАТ ===
app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Повідомлення порожнє' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API ключ не налаштований' });

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'openai/gpt-oss-120b',
                messages: [
                    { role: 'system', content: 'You are OfflineAI... (промпт оставь свой)' },
                    { role: 'user', content: message }
                ]
            })
        });

        const data = await response.json();
        if (data.error) return res.status(500).json({ error: 'Groq: ' + data.error.message });
        res.json({ reply: data.choices[0].message.content });

    } catch (error) {
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер на порту ${PORT}`));
