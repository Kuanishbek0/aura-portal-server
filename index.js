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

app.post('/api/ai/chat', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    // Превращаем userId в число, чтобы Prisma корректно искала в БД
    const userId = Number(req.user.userId);

    console.log(`[AI Chat] Запрос от пользователя ID: ${userId}`);

    // 1. Достаем расписание из базы
    const schedule = await prisma.schedule.findMany({
      where: { userId: userId },
      orderBy: { time: 'asc' }
    });

    console.log(`[AI Chat] Найдено уроков в базе: ${schedule.length}`);

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    // 2. Формируем контекст (используем s.title как в Prisma Studio)
    const scheduleContext = schedule.length > 0 
      ? schedule.map(s => `- ${s.title} в ${s.time} (кабинет ${s.room || 'не указан'})`).join('\n')
      : `Расписание на данный момент не заполнено для ID: ${userId}`;

    const systemPrompt = `Ты AURA — помощник портала. 
      Студент: ${user.name}. Группа: ${user.group || 'не указана'}.
      Данные расписания из твоей базы данных:
      ${scheduleContext}
      
      Отвечай кратко. Если студент спрашивает про уроки, бери данные ТОЛЬКО из текста выше. 
      Если там написано "не заполнено", так и ответь.`;

    // 3. Сохраняем сообщение пользователя в БД
    await prisma.chatMessage.create({ 
      data: { role: 'user', content: message, userId: userId } 
    });

    // 4. Запрос к ИИ
    const completion = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt }, 
        { role: 'user', content: message }
      ],
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content;

    // 5. Сохраняем ответ ИИ в БД
    await prisma.chatMessage.create({ 
      data: { role: 'assistant', content: reply, userId: userId } 
    });

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

app.post('/api/ai/chat', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    const userId = Number(req.user.userId);

    console.log(`[AI Chat] Запрос от пользователя ID: ${userId}`);

    // 1. Достаем пользователя
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    // 2. Достаем расписание из базы
    const schedule = await prisma.schedule.findMany({
      where: { userId },
      orderBy: { id: 'asc' }
    });

    console.log(`[AI Chat] Найдено уроков в базе: ${schedule.length}`);

    const scheduleContext = schedule.length > 0
      ? schedule
          .map((s) => {
            const teacher = s.teacher ? `, преподаватель: ${s.teacher}` : '';
            return `- ${s.title} — ${s.time} (тип: ${s.type || 'не указан'}, кабинет: ${s.room || 'не указан'}${teacher})`;
          })
          .join('\n')
      : `Расписание на данный момент не заполнено для ID: ${userId}`;

    // 3. Достаем оценки и считаем GPA
    const grades = await prisma.grade.findMany({
      where: { userId }
    });

    const gradePoints = {
      'A': 4.0,
      'A-': 3.67,
      'B+': 3.33,
      'B': 3.0,
      'B-': 2.67,
      'C+': 2.33,
      'C': 2.0,
      'C-': 1.67,
      'D+': 1.33,
      'D': 1.0,
      'F': 0
    };

    let gpa = 0;

    if (grades.length > 0) {
      const totalPoints = grades.reduce((sum, grade) => {
        const value = String(grade.value || '').trim().toUpperCase();
        return sum + (gradePoints[value] ?? 0);
      }, 0);

      gpa = Number((totalPoints / grades.length).toFixed(2));
    }

    const gradesContext = grades.length > 0
      ? grades.map((g) => `- ${g.subject}: ${g.value}`).join('\n')
      : 'Оценки пока не заполнены';

    const gpaContext = grades.length > 0
      ? `${gpa}`
      : 'не заполнен';

    // 4. Формируем системный промпт для ИИ
    const systemPrompt = `Ты AURA — учебный помощник академического портала.

Студент: ${user.name}.
Группа: ${user.group || 'не указана'}.

Данные расписания из базы данных:
${scheduleContext}

Данные оценок из базы данных:
${gradesContext}

GPA студента: ${gpaContext}.

Правила ответа:
- Отвечай кратко и понятно.
- Если студент спрашивает про уроки, сабақ, расписание или кесте — отвечай только по данным расписания выше.
- Если студент спрашивает про преподавателя, мұғалім или оқытушы — используй teacher из расписания выше.
- Если студент спрашивает GPA, средний балл, үлгерім или оценки — отвечай по GPA и оценкам выше.
- Если данных нет, скажи, что данные пока не заполнены.`;

    // 5. Сохраняем сообщение пользователя в БД
    await prisma.chatMessage.create({
      data: {
        role: 'user',
        content: message,
        userId
      }
    });

    // 6. Запрос к ИИ
    const completion = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.4
    });

    const reply = completion.choices[0].message.content;

    // 7. Сохраняем ответ ИИ в БД
    await prisma.chatMessage.create({
      data: {
        role: 'assistant',
        content: reply,
        userId
      }
    });

    res.json({ reply });
  } catch (error) {
    console.error("AI Error Details:", error);
    res.status(500).json({ message: 'Ошибка ИИ', error: error.message });
  }
});

// === ДАШБОРД (Заглушка для диплома) ===

app.get('/api/dashboard/summary', authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user.userId);

    const grades = await prisma.grade.findMany({
      where: { userId }
    });

    const gradePoints = {
      'A': 4.0,
      'A-': 3.67,
      'B+': 3.33,
      'B': 3.0,
      'B-': 2.67,
      'C+': 2.33,
      'C': 2.0,
      'C-': 1.67,
      'D+': 1.33,
      'D': 1.0,
      'F': 0
    };

    let gpa = 0;

    if (grades.length > 0) {
      const totalPoints = grades.reduce((sum, grade) => {
        return sum + (gradePoints[grade.value] ?? 0);
      }, 0);

      gpa = totalPoints / grades.length;
    }

    const summary = {
      gpa: Number(gpa.toFixed(2)),
      attendance: 94,
      credits: 128,
      totalCredits: 180
    };

    const deadlines = [
      { id: 1, title: 'Лабораторная №5', subject: 'Базы данных', date: '25 апр' },
      { id: 2, title: 'Курсовой проект', subject: 'Веб-технологии', date: '30 апр' }
    ];

    res.json({
      summary,
      deadlines,
      grades
    });
  } catch (error) {
    console.error("Dashboard Summary Error:", error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// === РАСПИСАНИЕ ДЛЯ ГЛАВНОЙ СТРАНИЦЫ ===

app.get('/api/schedule/today', authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user.userId);

    const schedule = await prisma.schedule.findMany({
      where: { userId },
      orderBy: { id: 'asc' }
    });

    res.json(schedule);
  } catch (error) {
    console.error("Schedule Today Error:", error);
    res.status(500).json({ message: 'Ошибка загрузки расписания' });
  }
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { 
  console.log(`Server started on ${BACKEND_URL}`);
});   