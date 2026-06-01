# Energy Certificate Requests

Сайт для заказа справок об обучении в ГАПОУ МО ПК ЭНЕРГИЯ, СП ЦПСУ.

## Запуск

```powershell
npm.cmd install
copy .env.example .env
npm.cmd start
```

Сайт будет доступен на `http://localhost:9348`.

## PM2

```powershell
npm.cmd run pm2:start
npm.cmd run pm2:logs
```

## Админка

Адрес: `http://localhost:9348/admin`

Первый администратор создается автоматически из `.env`:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_DISPLAY_NAME`

После первого входа смените пароль через создание нового администратора и отключение временной учетной записи.

Роли:

- `admin` — полный доступ, управление пользователями, экспорт CSV.
- `staff` — секретарь, доступ только к просмотру заявок и смене статусов.

В интерфейсе ограничение рассчитано на 3 активных секретарей.

## Energy Run

Страница игры: `http://localhost:9348/energy-run`

Студент создает профиль: имя, фамилия и группа. После игры счет сохраняется в SQLite, а на странице показываются:

- лидерборд студентов по лучшему счету;
- лидерборд групп по сумме очков;
- личная статистика игрока.

## Расписания

Страница расписаний: `http://localhost:9348/schedule`

PDF-файлы берутся из архива `SCHEDULE_ARCHIVE_ROOT`, по умолчанию:

```text
/home/bot_rasp/archive
```

Ожидаемая структура:

```text
/home/bot_rasp/archive/2026/06/Расписание_2026-06-01.pdf
/home/bot_rasp/archive/2026/07/Расписание_2026-07-01.pdf
```

Сайт ищет PDF в папках `год/месяц`, сортирует по дате в имени файла и показывает последние расписания.

## Соцсети

На публичных страницах добавлены ссылки:

- MAX: `https://max.ru/id5012082423_gos`
- Telegram: `https://t.me/energy_temnikovo`
- ВК: `https://vk.com/energy_temnikovo`

## Nginx пример

```nginx
server {
    server_name energy.sebog1.ru;

    location / {
        proxy_pass http://127.0.0.1:9348;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
