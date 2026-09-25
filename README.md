# hetzner-order-server

Cloudflare Worker: раз в минуту проверяет Hetzner Cloud и покупает **один** VPS
нужного типа (по умолчанию `cx33`, если нет — `cx43`). После покупки шлёт
уведомление в Telegram. Если сервер уже есть, повторно ничего не покупает.

## Как работает

1. Cron (`* * * * *`) запускает Worker.
2. Если в проекте уже есть сервер с лейблом `managed-by=hetzner-order-server`
   (или с именем `SERVER_NAME`), Worker ничего не делает.
3. Иначе Worker проходит по `SERVER_TYPES` в заданном порядке и пытается создать
   сервер в каждой локации, где этот тип сейчас есть (`/datacenters`).
4. Если удалось, отправляет в Telegram тип, локацию, IP и root-пароль
   (пароль приходит только когда `SSH_KEYS` не задан).
5. На ошибки конфигурации (неверный токен, лимит проекта и т.п.) тоже приходит
   уведомление в Telegram.

Проект Hetzner (`marrek`) задаётся самим API-токеном: токен создаётся внутри
проекта. `HETZNER_PROJECT` нужен только для текста уведомления.

## Настройки

### Секреты (`wrangler secret put`)

| Имя | Описание |
|-----|----------|
| `HETZNER_API_TOKEN` | Токен Hetzner Cloud с правами **Read & Write**: Console → проект `marrek` → Security → API tokens |
| `TELEGRAM_BOT_TOKEN` | Токен бота от @BotFather |
| `TELEGRAM_CHAT_ID` | ID чата, куда слать сообщения (можно узнать у @userinfobot). Сначала напишите своему боту `/start` |
| `ADMIN_TOKEN` | *(опционально)* Bearer-токен для HTTP-эндпоинтов `/status`, `/run`, `/test-telegram` |

### Переменные (`wrangler.toml` → `[vars]`)

| Имя | По умолчанию | Описание |
|-----|--------------|----------|
| `SERVER_TYPES` | `cx33,cx43` | Типы серверов в порядке приоритета |
| `LOCATIONS` | *(пусто = любые)* | Например `fsn1,nbg1,hel1` |
| `IMAGE` | `ubuntu-24.04` | Образ ОС |
| `SERVER_NAME` | `marrek-vps` | Имя сервера |
| `SSH_KEYS` | *(пусто)* | Имена или ID SSH-ключей из Hetzner через запятую |
| `ENABLE_IPV4` | `true` | `false` означает сервер только с IPv6 (чуть дешевле) |
| `HETZNER_PROJECT` | `marrek` | Для текста уведомления |

## Деплой

```bash
npm install
npx wrangler login

npx wrangler secret put HETZNER_API_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put ADMIN_TOKEN        # опционально

npm run deploy
```

Проверка:

```bash
URL=https://hetzner-order-server.<your-subdomain>.workers.dev
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $URL/test-telegram   # тестовое сообщение в TG
curl -H "Authorization: Bearer $ADMIN_TOKEN" $URL/status                  # конфиг и уже купленные серверы
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $URL/run             # запустить попытку покупки вручную
npm run tail                                                              # логи cron-запусков
```

Когда сервер куплен, cron можно отключить (убрать `crons` в `wrangler.toml` и
задеплоить заново). Можно и оставить: тогда каждый запуск делает один GET-запрос.

## Локальный запуск

```bash
cp .dev.vars.example .dev.vars   # заполнить значения
npm run dev
curl "http://localhost:8787/__scheduled"   # эмулировать cron
```

> ⚠️ Локальный запуск с настоящим токеном **реально купит сервер**.
