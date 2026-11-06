const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Повідомлення порожнє' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API ключ не налаштований' });

    try {
        // Используем актуальный алиас gemini-flash-latest для API v1beta
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: message }] }]
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error("Gemini API Error:", data.error.message);
            return res.status(500).json({ error: "Gemini: " + data.error.message });
        }

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            res.json({ reply: data.candidates[0].content.parts[0].text });
        } else {
            res.status(500).json({ error: 'Не вдалося отримати відповідь (Невідомий формат)' });
        }
    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: 'Помилка сервера: ' + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює на порту ${PORT}`));
