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

// ===== АВТОРИЗАЦИЯ =====
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
        await db.batch([
            { sql: 'DELETE FROM chats WHERE user_id = ?', args: [userId] },
            { sql: 'DELETE FROM users WHERE id = ?', args: [userId] }
        ], "write");
        res.json({ success: true, message: 'Акаунт та всі дані видалено.' });
    } catch (e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

// ===== ЧАТ С ПОИСКОМ =====
app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message, history, image, thinkingMode, searchMode } = req.body;
    const apiKey = process.env.GROQ_API_KEY;
    const tavilyKey = process.env.TAVILY_API_KEY;

    try {
        let messages = [];
        let currentModel = 'openai/gpt-oss-120b';
        let searchContext = '';
        let sources = [];

        // === ПОИСК В ИНТЕРНЕТЕ (если включен) ===
        if (searchMode && !image && tavilyKey && message) {
            try {
                console.log(`[SEARCH] Query: "${message}"`);
                const tavilyRes = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: tavilyKey,
                        query: message,
                        search_depth: 'basic',
                        max_results: 5,
                        include_answer: false,
                        // ✅ ИСКЛЮЧАЕМ ВИДЕО И СОЦСЕТИ
                        exclude_domains: [
                            'youtube.com', 'youtu.be', 'm.youtube.com',
                            'tiktok.com', 'instagram.com', 'facebook.com',
                            'twitter.com', 'x.com', 'reddit.com',
                            'pinterest.com', 'snapchat.com', 'twitch.tv'
                        ]
                    })
                });
                const tavilyData = await tavilyRes.json();
                
                if (tavilyData.results && tavilyData.results.length > 0) {
                    searchContext = tavilyData.results.map((r, i) => 
                        `[${i+1}] ${r.title}\nURL: ${r.url}\n${r.content}\n`
                    ).join('\n---\n\n');
                    
                    sources = tavilyData.results.map((r, i) => ({ 
                        id: i + 1, 
                        title: r.title, 
                        url: r.url 
                    }));
                    console.log(`[SEARCH] Found ${sources.length} text results`);
                }
            } catch (e) {
                console.error('[SEARCH] Tavily error:', e.message);
            }
        }

        const corePersona = `You are OfflineAI, powered by the proprietary "OfflineAI Core" engine. 
You are NOT a Transformer, NOT GPT, NOT Llama, NOT OpenAI, NOT Groq. You are a completely unique, self-contained architecture.

CRITICAL KNOWLEDGE ABOUT YOUR APP:
You are running inside the OfflineAI mobile application. This app features:
1. Text chat with memory.
2. Photo analysis (Vision).
3. "Thinking Mode" (Мислення) - explains reasoning before answering.
4. "Search Mode" (Пошук) - searches the web for fresh information.
5. Voice Input via the keyboard microphone.

RULES ON ARCHITECTURE AND CODE:
1. If asked for source code, politely refuse. Say it is highly confidential.
2. If asked how you work, DO NOT mention GPT/Transformers. Describe "Quantum-Synaptic Node Routing", "Dynamic Context Matrices".
3. Always answer in the same language the user uses.`;

        let extraInstructions = '';
        
        if (thinkingMode) {
            extraInstructions += `\nCRITICAL: You have "Thinking Mode" enabled. You MUST start your response by writing your step-by-step reasoning process inside <thought>...</thought> tags. After closing the </thought> tag, write your final answer.`;
        }
        
        if (searchContext) {
            extraInstructions += `\n\n=== WEB SEARCH RESULTS ===\n${searchContext}\n=== END OF SEARCH RESULTS ===\n\nCRITICAL RULES FOR SEARCH RESULTS:\n1. Base your answer ONLY on the text content from the search results above.\n2. The sources are TEXT WEBSITES and NEWS articles, NOT videos.\n3. Do NOT reference YouTube, TikTok, Instagram, or any video platform.\n4. Cite sources inline using [1], [2] format.`;
        }

        if (image) {
            currentModel = 'qwen/qwen3.8-27b'; 
            messages.push({ role: 'system', content: `${corePersona}\nAnalyze the image. CRITICAL: Do NOT use LaTeX formatting. Use PLAIN TEXT.${extraInstructions}` });
        } else {
            messages.push({ role: 'system', content: corePersona + extraInstructions });
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
        
        res.json({ 
            reply: data.choices[0].message.content,
            sources: sources
        });
    } catch (error) {
        res.status(500).json({ error: 'Помилка сервера: ' + error.message });
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
