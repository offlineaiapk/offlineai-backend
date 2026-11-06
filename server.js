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

    console.log("--- Новый запрос ---");
    console.log("Ключ начинается с:", apiKey.substring(0, 5));

    try {
        console.log("Отправляем запрос в Google...");
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: message }] }]
            })
        });

        console.log("Ответ от Google получен. Статус:", response.status);
        const data = await response.json();

        if (data.error) {
            console.error("Ошибка от Google:", data.error.message);
            return res.status(500).json({ error: "Gemini: " + data.error.message });
        }

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            res.json({ reply: data.candidates[0].content.parts[0].text });
        } else {
            res.status(500).json({ error: 'Пустой ответ от ИИ' });
        }
    } catch (error) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА СЕТИ:", error);
        res.status(500).json({ error: 'Помилка сервера: ' + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює на порту ${PORT}`));
