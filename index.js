require('dotenv').config()
const express = require('express')
const cors = require('cors')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const OpenAI = require('openai')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const nodemailer = require('nodemailer')

// 1. Инициализация
const prisma = new PrismaClient()
const app = express()

// Динамические URL для работы в продакшене (Render / Vercel)
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;

// 2. Настройка почты (Nodemailer)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
})

// Настройка хранилища для файлов
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// 3. Middleware
app.use(cors())
app.use(express.json())
app.use('/uploads', express.static('uploads'));

// Настройка ИИ (Groq через OpenAI SDK)
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
})

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ message: 'Нет токена' })
  const token = authHeader.split(' ')[1]
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = decoded
    next()
  } catch (error) {
    return res.status(401).json({ message: 'Неверный токен' })
  }
}

// === РОУТЫ АВТЕНТИФИКАЦИИ ===

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body
    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (existingUser) return res.status(400).json({ message: 'Пользователь уже существует' })
    const hashedPassword = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({ data: { name, email, password: hashedPassword } })
    res.json({ id: user.id, name: user.name, email: user.email })
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return res.status(400).json({ message: 'Пользователь не найден' })
    const validPassword = await bcrypt.compare(password, user.password)
    if (!validPassword) return res.status(400).json({ message: 'Неверный пароль' })
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } })
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, name: true, email: true, group: true }
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// === ВОССТАНОВЛЕНИЕ ПАРОЛЯ ===

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000);

    await prisma.user.update({
      where: { email },
      data: {
        resetToken: token,
        resetTokenExp: expires
      }
    });

    const resetLink = `${FRONTEND_URL}/reset-password?token=${token}`;

    await transporter.sendMail({
      from: `"Aura Portal" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Восстановление пароля',
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #4f7cff;">Сброс пароля</h2>
          <p>Привет, ${user.name}! Нажми на кнопку ниже, чтобы изменить пароль. Ссылка активна 1 час.</p>
          <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background: #4f7cff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Сбросить пароль</a>
          <p style="color: #777; font-size: 12px; margin-top: 20px;">Если вы не запрашивали сброс, просто проигнорируйте это письмо.</p>
        </div>
      `
    });

    res.json({ message: 'Ссылка отправлена на почту' });
  } catch (error) {
    console.error("Mail Error:", error);
    res.status(500).json({ message: 'Ошибка при отправке письма' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExp: { gt: new Date() }
      }
    });

    if (!user) {
      return res.status(400).json({ message: 'Токен недействителен или просрочен' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExp: null
      }
    });

    res.json({ message: 'Пароль успешно обновлен' });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// === ИИ И ФАЙЛЫ ===

app.post('/api/ai/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).send('Файл не выбран');
    res.json({ 
      url: `${BACKEND_URL}/uploads/${file.filename}`,
      name: file.originalname 
    });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).send('Ошибка при загрузке');
  }
});

app.post('/api/ai/chat', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    const userId = req.user.userId;

    // Сохраняем сообщение пользователя
    await prisma.chatMessage.create({ data: { role: 'user', content: message, userId } });

    // Запрос к ИИ (используем актуальную модель llama-3.3)
    const completion = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'Ты AURA — помощник академического портала. Отвечай кратко и по делу на русском языке.' }, 
        { role: 'user', content: message }
      ],
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content;

    // Сохраняем ответ ИИ
    await prisma.chatMessage.create({ data: { role: 'assistant', content: reply, userId } });

    res.json({ reply });
  } catch (error) {
    console.error("AI Error Details:", error); 
    res.status(500).json({ message: 'Ошибка ИИ', error: error.message });
  }
});

app.get('/api/ai/history', authMiddleware, async (req, res) => {
  try {
    const history = await prisma.chatMessage.findMany({ 
      where: { userId: req.user.userId }, 
      orderBy: { createdAt: 'asc' } 
    });
    res.json(history);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки истории' });
  }
});

app.delete('/api/ai/history', authMiddleware, async (req, res) => {
  try {
    await prisma.chatMessage.deleteMany({
      where: { userId: req.user.userId }
    });
    res.json({ message: 'История очищена' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Ошибка при удалении' });
  }
});

// === ДАШБОРД (Заглушка для диплома) ===

app.get('/api/dashboard/summary', authMiddleware, async (req, res) => {
  try {
    const summary = { gpa: 3.87, attendance: 94, credits: 128, totalCredits: 180 };
    const deadlines = [
      { id: 1, title: 'Лабораторная №5', subject: 'Базы данных', date: '25 апр' },
      { id: 2, title: 'Курсовой проект', subject: 'Веб-технологии', date: '30 апр' }
    ];
    res.json({ summary, deadlines });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { 
  console.log(`Server started on ${BACKEND_URL}`);
});