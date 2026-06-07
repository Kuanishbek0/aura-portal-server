const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({
    where: {
      email: "quwanes190205@gmail.com",
    },
  });

  if (!user) {
    console.log("Пользователь не найден. Сначала зарегистрируй аккаунт на сайте.");
    return;
  }

  await prisma.schedule.createMany({
    data: [
      {
        title: "Деректер қоры",
        type: "Дәріс",
        room: "302 аудитория",
        time: "Дүйсенбі, 09:00–10:20",
        userId: user.id,
      },
      {
        title: "Web бағдарламалау",
        type: "Практика",
        room: "215 аудитория",
        time: "Дүйсенбі, 10:30–11:50",
        userId: user.id,
      },
      {
        title: "Ақпараттық жүйелерді жобалау",
        type: "Дәріс",
        room: "410 аудитория",
        time: "Дүйсенбі, 12:30–13:50",
        userId: user.id,
      },
      {
        title: "Жасанды интеллект негіздері",
        type: "Зертханалық сабақ",
        room: "308 аудитория",
        time: "Сейсенбі, 09:00–10:20",
        userId: user.id,
      },
    ],
  });

  console.log("Расписание успешно добавлено!");
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });