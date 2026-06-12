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

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`

// 2. Настройка почты
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
})

// 3. Файлы
const uploadDir = path.join(__dirname, 'uploads')

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir)
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/')
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname)
  }
})

const upload = multer({ storage })

// 4. Middleware
app.use(cors())
app.use(express.json())
app.use('/uploads', express.static('uploads'))

// 5. ИИ через Groq
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
})

// 6. Auth middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader) {
    return res.status(401).json({ message: 'Нет токена' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = decoded
    next()
  } catch (error) {
    return res.status(401).json({ message: 'Неверный токен' })
  }
}

// === AUTH ===

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body

    const existingUser = await prisma.user.findUnique({
      where: { email }
    })

    if (existingUser) {
      return res.status(400).json({ message: 'Пользователь уже существует' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        group: 'АЖ-221/1'
      }
    })

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      group: user.group
    })
  } catch (error) {
    console.error('Register Error:', error)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body

    const user = await prisma.user.findUnique({
      where: { email }
    })

    if (!user) {
      return res.status(400).json({ message: 'Пользователь не найден' })
    }

    const validPassword = await bcrypt.compare(password, user.password)

    if (!validPassword) {
      return res.status(400).json({ message: 'Неверный пароль' })
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d'
      }
    )

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        group: user.group
      }
    })
  } catch (error) {
    console.error('Login Error:', error)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: Number(req.user.userId) },
      select: {
        id: true,
        name: true,
        email: true,
        group: true
      }
    })

    res.json(user)
  } catch (error) {
    console.error('Me Error:', error)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// === PASSWORD RESET ===

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body

    const user = await prisma.user.findUnique({
      where: { email }
    })

    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expires = new Date(Date.now() + 3600000)

    await prisma.user.update({
      where: { email },
      data: {
        resetToken: token,
        resetTokenExp: expires
      }
    })

    const resetLink = `${FRONTEND_URL}/reset-password?token=${token}`

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
    })

    res.json({ message: 'Ссылка отправлена на почту' })
  } catch (error) {
    console.error('Mail Error:', error)
    res.status(500).json({ message: 'Ошибка при отправке письма' })
  }
})

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExp: {
          gt: new Date()
        }
      }
    })

    if (!user) {
      return res.status(400).json({ message: 'Токен недействителен или просрочен' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExp: null
      }
    })

    res.json({ message: 'Пароль успешно обновлен' })
  } catch (error) {
    console.error('Reset Password Error:', error)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// === HELPERS ===

function calculateGpa(grades) {
  const gradePoints = {
    A: 4.0,
    'A-': 3.67,
    'B+': 3.33,
    B: 3.0,
    'B-': 2.67,
    'C+': 2.33,
    C: 2.0,
    'C-': 1.67,
    'D+': 1.33,
    D: 1.0,
    F: 0
  }

  if (!grades || grades.length === 0) {
    return 0
  }

  const totalPoints = grades.reduce((sum, grade) => {
    const value = String(grade.value || '').trim().toUpperCase()
    return sum + (gradePoints[value] ?? 0)
  }, 0)

  return Number((totalPoints / grades.length).toFixed(2))
}

// === AI CHAT ===

app.post('/api/ai/chat', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body
    const userId = Number(req.user.userId)

    console.log(`[AI Chat] Запрос от пользователя ID: ${userId}`)

    const user = await prisma.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' })
    }

    // Университетские данные
    const universityInfo = {
      university: 'Қ. Құлажанов атындағы Қазақ технология және бизнес университеті',
      faculty: 'Инжиниринг және ақпараттық технологиялар факультеті',
      department: 'Ақпараттық технологиялар кафедрасы',
      specialty: 'Ақпараттық жүйелер',
      group: user.group || 'АЖ-221/1',
      curator: 'әзірге жүйеде толық көрсетілмеген',
      facultyHead: 'әзірге жүйеде толық көрсетілмеген',
      deanOffice: 'әзірге жүйеде толық көрсетілмеген'
    }

    // Расписание
    const schedule = await prisma.schedule.findMany({
      where: { userId },
      orderBy: { id: 'asc' }
    })

    console.log(`[AI Chat] Найдено уроков в базе: ${schedule.length}`)

    const scheduleContext = schedule.length > 0
      ? schedule
          .map((s) => {
            const teacher = s.teacher ? `, оқытушы: ${s.teacher}` : ''
            return `- ${s.title} — ${s.time} (түрі: ${s.type || 'көрсетілмеген'}, аудитория: ${s.room || 'көрсетілмеген'}${teacher})`
          })
          .join('\n')
      : `Сабақ кестесі әзірге толтырылмаған. User ID: ${userId}`

    // Оценки и GPA
    const grades = await prisma.grade.findMany({
      where: { userId }
    })

    const gpa = calculateGpa(grades)

    console.log(`[AI Chat] Найдено оценок в базе: ${grades.length}`)
    console.log(`[AI Chat] GPA: ${gpa}`)

    const gradesContext = grades.length > 0
      ? grades.map((g) => `- ${g.subject}: ${g.value}`).join('\n')
      : 'Бағалар әзірге толтырылмаған'

    const gpaContext = grades.length > 0 ? String(gpa) : 'әзірге толтырылмаған'

    const systemPrompt = `Сен AURA — студенттерге арналған оқу порталының интеллектуалды көмекшісісің.

Студент туралы мәлімет:
- Аты-жөні: ${user.name}
- Email: ${user.email}
- Тобы: ${universityInfo.group}

Университет туралы нақты деректер:
- Университет: ${universityInfo.university}
- Факультет: ${universityInfo.faculty}
- Кафедра: ${universityInfo.department}
- Мамандық: ${universityInfo.specialty}
- Куратор: ${universityInfo.curator}
- Факультет басшысы: ${universityInfo.facultyHead}
- Деканат орналасқан жері: ${universityInfo.deanOffice}

Сабақ кестесі:
${scheduleContext}

Бағалар:
${gradesContext}

GPA көрсеткіші:
${gpaContext}

Жауап беру ережелері:
- Қысқа, нақты және түсінікті жауап бер.
- Студент қазақша сұраса қазақша жауап бер, орысша сұраса орысша жауап бер.
- Егер студент "менің тобым қандай?", "группам какая?", "қай топта оқимын?" деп сұраса: ${universityInfo.group} деп жауап бер.
- Егер студент факультет туралы сұраса: ${universityInfo.faculty} деп жауап бер.
- Егер студент кафедра туралы сұраса: ${universityInfo.department} деп жауап бер.
- Егер студент мамандық, специальность немесе profession туралы сұраса: ${universityInfo.specialty} деп жауап бер.
- Егер студент университет туралы сұраса: ${universityInfo.university} деп жауап бер.
- Егер студент куратор, факультет басшысы немесе деканат туралы сұраса, жоғарыдағы дерекке ғана сүйен. Егер "әзірге жүйеде толық көрсетілмеген" деп тұрса, солай айт.
- Егер студент сабақ, кесте, расписание немесе урок туралы сұраса, тек жоғарыдағы сабақ кестесіне сүйен.
- Егер студент оқытушы, преподаватель немесе мұғалім туралы сұраса, сабақ кестесіндегі оқытушы дерегіне сүйен.
- Егер студент GPA, орташа балл, средний балл, үлгерім немесе бағалар туралы сұраса, тек жоғарыдағы GPA және бағалар дерегіне сүйен.
- Егер сұралған ақпарат жүйеде жоқ болса, ойдан шығарма. "Бұл ақпарат әзірге жүйеде толық енгізілмеген" деп жауап бер.`

    await prisma.chatMessage.create({
      data: {
        role: 'user',
        content: message,
        userId
      }
    })

    const completion = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.3
    })

    const reply = completion.choices[0].message.content

    await prisma.chatMessage.create({
      data: {
        role: 'assistant',
        content: reply,
        userId
      }
    })

    res.json({ reply })
  } catch (error) {
    console.error('AI Error Details:', error)
    res.status(500).json({
      message: 'Ошибка ИИ',
      error: error.message
    })
  }
})

app.get('/api/ai/history', authMiddleware, async (req, res) => {
  try {
    const history = await prisma.chatMessage.findMany({
      where: { userId: Number(req.user.userId) },
      orderBy: { createdAt: 'asc' }
    })

    res.json(history)
  } catch (error) {
    console.error('History Error:', error)
    res.status(500).json({ message: 'Ошибка загрузки истории' })
  }
})

app.delete('/api/ai/history', authMiddleware, async (req, res) => {
  try {
    await prisma.chatMessage.deleteMany({
      where: { userId: Number(req.user.userId) }
    })

    res.json({ message: 'История очищена' })
  } catch (error) {
    console.error('Delete History Error:', error)
    res.status(500).json({ message: 'Ошибка при удалении' })
  }
})

// === DASHBOARD SUMMARY ===

app.get('/api/dashboard/summary', authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user.userId)

    const grades = await prisma.grade.findMany({
      where: { userId }
    })

    const gpa = calculateGpa(grades)

    const summary = {
      gpa,
      attendance: 94,
      credits: 128,
      totalCredits: 180
    }

    const deadlines = [
      {
        id: 1,
        title: 'Лабораторная №5',
        subject: 'Базы данных',
        date: '25 апр'
      },
      {
        id: 2,
        title: 'Курсовой проект',
        subject: 'Веб-технологии',
        date: '30 апр'
      }
    ]

    res.json({
      summary,
      deadlines,
      grades,
      courses: []
    })
  } catch (error) {
    console.error('Dashboard Summary Error:', error)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// === SCHEDULE ===

app.get('/api/schedule/today', authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user.userId)

    const schedule = await prisma.schedule.findMany({
      where: { userId },
      orderBy: { id: 'asc' }
    })

    res.json(schedule)
  } catch (error) {
    console.error('Schedule Today Error:', error)
    res.status(500).json({ message: 'Ошибка загрузки расписания' })
  }
})

// === FILE UPLOAD OPTIONAL ===

app.post('/api/files/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Файл не загружен' })
    }

    const fileUrl = `${BACKEND_URL}/uploads/${req.file.filename}`

    res.json({
      message: 'Файл загружен',
      fileUrl
    })
  } catch (error) {
    console.error('Upload Error:', error)
    res.status(500).json({ message: 'Ошибка загрузки файла' })
  }
})

// === START SERVER ===

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`Server started on ${BACKEND_URL}`)
})