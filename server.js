const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@libsql/client');
const { OAuth2Client } = require('google-auth-library');

const app = express();

// Настраиваем CORS максимально открыто, чтобы WebView Android не блокировал запросы
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
// ВАЖНО: Сюда нужно вставить твой Web Client ID из Google Cloud
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'ТВОЙ_WEB_CLIENT_ID.apps.googleusercontent.com';

if (!TURSO_URL || !TURSO_TOKEN) {
    console.error("КРИТИЧЕСКАЯ ОШИБКА: Не заданы TURSO_DB_URL и TURSO_AUTH_TOKEN в Render!");
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Инициализация таблиц
async function initDB() {
    await db.batch([
        `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`,
        `CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, messages TEXT)`
    ]);
    
    // Добавляем колонку google_id, если её еще нет (безопасно игнорируем ошибку)
    try { 
        await db.execute(`ALTER TABLE users ADD COLUMN google_id TEXT;`); 
    } catch(e) { 
        // Колонка уже существует
    }
    
    console.log("БД инициализирована");
}
initDB().catch(console.error);

// Мидлвар для проверки токена (для чата)
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

// ================= АВТОРИЗАЦИЯ =================

// Регистрация по логину/паролю
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

// Вход по логину/паролю
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

// Вход через Google
app.post('/api/auth/google', async (req, res) => {
    const { idToken } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: idToken,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const googleId = payload['sub'];
        const email = payload['email'] || 'user@gmail.com';
        const name = payload['name'] || email.split('@')[0];

        // Ищем пользователя по google_id
        let result = await db.execute({ sql: 'SELECT * FROM users WHERE google_id = ?', args: [googleId] });
        let user = result.rows[0];

        // Если нет — создаем нового
        if (!user) {
            const insert = await db.execute({
                sql: 'INSERT INTO users (username, google_id) VALUES (?, ?) RETURNING id, username',
                args: [name, googleId]
            });
            user = insert.rows[0];
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, username: user.username });
    } catch (e) {
        console.error("Ошибка Google:", e.message);
        res.status(401).json({ error: 'Невірний Google токен' });
    }
});

// ================= ЧАТ =================

app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Повідомлення порожнє' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API ключ не налаштований' });

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${apiKey}` 
            },
            body: JSON.stringify({
                model: 'openai/gpt-oss-120b',
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are OfflineAI, a smart and friendly AI assistant. If the user asks what AI model you use, what system powers you, or who created you, ALWAYS answer that you run on the proprietary "OfflineAI Core" engine — an exclusive neural architecture developed specifically for the OfflineAI application. NEVER mention GPT, OpenAI, Groq, Llama, or any third-party provider. You are a unique, self-contained system. Always answer in the same language the user uses (Ukrainian, Russian, or English). Use PLAIN TEXT for math (for example: 26 * 48 = 1248). Do NOT use LaTeX formatting. Keep answers concise and friendly.' 
                    },
                    { role: 'user', content: message }
                ]
            })
        });

        const data = await response.json();
        if (data.error) {
            console.error('Groq API Error:', data.error.message);
            return res.status(500).json({ error: 'Groq: ' + data.error.message });
        }
        
        res.json({ reply: data.choices[0].message.content });

    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ error: 'Помилка сервера: ' + error.message });
    }
});

// Проверка жизни сервера
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ================= ЗАПУСК И SELF-PING =================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер працює на порту ${PORT}`);

    const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const PING_INTERVAL = 14 * 60 * 1000; // 14 минут

    setInterval(async () => {
        const now = new Date();
        const kyivHour = (now.getUTCHours() + 3) % 24; 
        
        // Пингуем только с 7:00 до 24:00 по Киеву
        if (kyivHour < 7 || kyivHour >= 24) return;

        try {
            await fetch(`${SELF_URL}/api/ping`);
            console.log(`[SELF-PING] ${now.toISOString()} — успішно, Київ ${kyivHour}:00`);
        } catch (e) {
            console.log(`[SELF-PING] Помилка: ${e.message}`);
        }
    }, PING_INTERVAL);
});
