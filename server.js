const express = require('express');
const cors = require('cors');
const app = express();

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
                        content: 'You are a helpful AI assistant. Always answer in the same language the user uses (Ukrainian, Russian, or English). Use PLAIN TEXT for math (for example: 26 * 48 = 1248). Do NOT use LaTeX formatting, do NOT use markdown code blocks for simple math. Keep answers concise and friendly.' 
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
    // Render автоматически задает переменную RENDER_EXTERNAL_URL
    const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const PING_INTERVAL = 14 * 60 * 1000; // 14 минут (Render спит после 15 минут бездействия)

    setInterval(async () => {
        // Проверяем время: пингуем только с 7:00 до 24:00 по Киеву (UTC+2/3)
        const now = new Date();
        const kyivHour = (now.getUTCHours() + 3) % 24; // UTC+3 для летнего времени
        
        if (kyivHour < 7 || kyivHour >= 24) {
            console.log(`[SELF-PING] ${now.toISOString()} — ніч (Київ ${kyivHour}:00), пропускаємо`);
            return;
        }

        try {
            const res = await fetch(`${SELF_URL}/api/ping`);
            console.log(`[SELF-PING] ${now.toISOString()} — статус ${res.status}, Київ ${kyivHour}:00`);
        } catch (e) {
            console.log(`[SELF-PING] Помилка: ${e.message}`);
        }
    }, PING_INTERVAL);
});
