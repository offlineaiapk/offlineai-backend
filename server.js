const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@libsql/client');
const { OAuth2Client } = require('google-auth-library');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' })); // Увеличиваем лимит для картинок
app.options('*', cors());

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_offlineai_key_2026';
const TURSO_URL = process.env.TURSO_DB_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1041190296124-61s9a550v27t65hmv1baii34o8vt23fe.apps.googleusercontent.com';

if (!TURSO_URL || !TURSO_TOKEN) console.error("КРИТИЧЕСКАЯ ОШИБКА: Не заданы TURSO_DB_URL и TURSO_AUTH_TOKEN!");

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function initDB() {
    await db.batch([
        `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`,
        `CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, messages TEXT)`
    ]);
    try { await db.execute(`ALTER TABLE users ADD COLUMN google_id TEXT;`); } catch(e) {}
    console.log("БД инициализирована");
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

// ===== РЕГИСТРАЦИЯ И АВТОРИЗАЦИЯ =====
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Введіть логін та пароль' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль має бути мінімум 6 символів' });
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
    if (!username || username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Нікнейм має бути від 3 до 30 символів' });
    if (!/^[a-zA-Zа-яА-ЯёЁіІїЇєЄґҐ0-9_ ]{3,30}$/.test(username)) return res.status(400).json({ error: 'Тільки літери, цифри, пробіл та _' });

    try {
        const decoded = jwt.verify(temp_token, JWT_SECRET);
        if (decoded.purpose !== 'username_setup') throw new Error('Invalid token');
        const checkName = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
        if (checkName.rows.length > 0) return res.status(400).json({ error: 'Цей нікнейм вже зайнятий' });
        
        const insert = await db.execute({ sql: 'INSERT INTO users (username, google_id) VALUES (?, ?) RETURNING id, username', args: [username, decoded.google_id] });
        const user = insert.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, username: user.username });
    } catch (e) { res.status(401).json({ error: 'Сесія закінчилася, спробуйте увійти знову' }); }
});

app.post('/api/user/delete-account', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        await db.batch([
            { sql: 'DELETE FROM chats WHERE user_id = ?', args: [userId] },
            { sql: 'DELETE FROM users WHERE id = ?', args: [userId] }
        ], "write");
        res.json({ success: true, message: 'Акаунт та всі дані видалено.' });
    } catch (e) { res.status(500).json({ error: 'Помилка сервера при видаленні' }); }
});

// ===== ЧАТ С КАРТИНКАМИ (VISION) =====
app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message, history, image } = req.body; // Принимаем image
    if (!message && !image) return res.status(400).json({ error: 'Повідомлення або фото порожнє' });
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API ключ не налаштований' });

    try {
        let messages = [];
        // Для картинок используем другую системную инструкцию (без сложных правил грамматики, т.к. модель вижн)
        if (image) {
            messages.push({ 
                role: 'system', 
                content: 'You are OfflineAI, a helpful vision assistant. Analyze the provided image and answer the user request accurately. Answer in the same language as the user.' 
            });
        } else {
            messages.push({ 
                role: 'system', 
                content: `You are OfflineAI, a smart and professional AI assistant... (ПРОПУСТИЛ ДЛЯ КРАТКОСТИ, ОСТАВЬ СВОЙ ПРОМПТ ЗДЕСЬ)` 
            });
        }

        // Добавляем историю (только текст)
        if (history && Array.isArray(history)) {
            history.slice(-50).forEach(msg => {
                messages.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text });
            });
        }

        // Формируем текущее сообщение
        let currentModel = 'openai/gpt-oss-120b'; // Дефолтная быстрая модель
        let userContent = message || '';

        if (image) {
            currentModel = 'llama-3.2-11b-vision-preview'; // Модель для зрения
            userContent = [
                { type: 'text', text: message || 'Опиши, що ти бачиш на цьому фото.' },
                { type: 'image_url', image_url: { url: image } }
            ];
        }

        messages.push({ role: 'user', content: userContent });

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: currentModel, messages: messages, temperature: 0.5 })
        });
        const data = await response.json();
        if (data.error) return res.status(500).json({ error: 'Groq: ' + data.error.message });
        res.json({ reply: data.choices[0].message.content });
    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер працює на порту ${PORT}`);
    const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(async () => {
        const kyivHour = (new Date().getUTCHours() + 3) % 24;
        if (kyivHour < 7 || kyivHour >= 24) return;
        try { await fetch(`${SELF_URL}/api/ping`); } catch(e) {}
    }, 14 * 60 * 1000);
});
