const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcrypt')
const prisma = new PrismaClient()

async function main() {
  // 1. Создаем или обновляем тестового юзера
  const hashedPassword = await bcrypt.hash('123456', 10)
  const user = await prisma.user.upsert({
    where: { email: 'test@kuteb.kz' },
    update: {},
    create: {
      name: 'Куанышбек Хасен',
      email: 'test@kuteb.kz',
      password: hashedPassword,
      group: 'ФИТ-301'
    },
  })

  // Очищаем старое расписание и оценки, чтобы не плодить дубликаты при каждом запуске
  await prisma.schedule.deleteMany({ where: { userId: user.id } })
  await prisma.grade.deleteMany({ where: { userId: user.id } })

  // 2. Добавляем полное расписание (теперь с днями недели!)
  // Сегодня 19 апреля, воскресенье. Добавим уроки на понедельник и вторник.
  await prisma.schedule.createMany({
    data: [
      { title: 'Базы данных', type: 'Лекция', room: '305', time: '10:00', dayOfWeek: 'Понедельник', userId: user.id },
      { title: 'Веб-технологии', type: 'Практика', room: '201', time: '14:00', dayOfWeek: 'Понедельник', userId: user.id },
      { title: 'Архитектура ИС', type: 'Лабораторная', room: '404', time: '09:00', dayOfWeek: 'Вторник', userId: user.id },
      { title: 'Облачные вычисления', type: 'Лекция', room: '501', time: '11:30', dayOfWeek: 'Среда', userId: user.id }
    ]
  })

  // 3. Добавляем оценки (используем value, как в твоей схеме)
  await prisma.grade.createMany({
    data: [
      { subject: 'Базы данных', value: 'A (95)', userId: user.id },
      { subject: 'Веб-технологии', value: 'A- (90)', userId: user.id },
      { subject: 'Машинное обучение', value: 'B+ (88)', userId: user.id },
      { subject: 'Защита информации', value: 'A (100)', userId: user.id }
    ]
  })

  console.log('✅ База данных успешно заполнена реальными данными!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })