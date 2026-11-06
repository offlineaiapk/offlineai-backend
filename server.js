const express = require('express');
const cors = require('cors');
const app = express();

// Настраиваем CORS максимально открыто, чтобы WebView Android не блокировал запросы
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.options('*', cors());

// Эндпоинт для пинга (проверка жизни сервера)
app.get('/api/ping', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

app.post('/api/chat', async (req, res) => {
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
                        content: 'You are OfflineAI, a helpful and friendly AI assistant. If the user asks what model you are, tell them you are OfflineAI, powered by a modern open-source GPT-OSS-120B model running via Groq infrastructure. Always answer in the same language the user uses (Ukrainian, Russian, or English). Use PLAIN TEXT for math (for example: 26 * 48 = 1248). Do NOT use LaTeX formatting. Keep answers concise.' 
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

        if (data.choices && data.choices[0] && data.choices[0].message) {
            res.json({ reply: data.choices[0].message.content });
        } else {
            res.status(500).json({ error: 'Не вдалося отримати відповідь' });
        }
    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ error: 'Помилка сервера: ' + error.message });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Сервер працює на порту ${PORT}`);

    // === SELF-PING против засыпания Render ===
    const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const PING_INTERVAL = 14 * 60 * 1000; // 14 минут

    setInterval(async () => {
        const now = new Date();
        const kyivHour = (now.getUTCHours() + 3) % 24; 
        
        // Пингуем только с 7:00 до 24:00 по Киеву
        if (kyivHour < 7 || kyivHour >= 24) {
            return;
        }

        try {
            await fetch(`${SELF_URL}/api/ping`);
            console.log(`[SELF-PING] ${now.toISOString()} — успішно, Київ ${kyivHour}:00`);
        } catch (e) {
            console.log(`[SELF-PING] Помилка: ${e.message}`);
        }
    }, PING_INTERVAL);
});
