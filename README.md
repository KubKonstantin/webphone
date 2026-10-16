# SIP Web Phone: Casdoor + SIP over WSS

Готовый каркас веб-звонилки:

- Casdoor OAuth Authorization Code через backend-for-frontend по тем же endpoint-ам, что в asternic (`/login/oauth/authorize`, `/api/login/oauth/access_token`, `/api/userinfo`);
- получение временных SIP-реквизитов из внешнего сервиса по логину Casdoor;
- регистрация и звонки через SIP.js по WSS;
- входящие и исходящие звонки;
- blind transfer через SIP REFER;
- громкость удалённого аудио и mute микрофона;
- история вызовов, разделённая по пользователям;
- обновление временных SIP-реквизитов до истечения TTL без обрыва активного звонка.

## Архитектура

```text
Browser (React + SIP.js)
  │  HttpOnly session cookie
  ▼
Node BFF
  ├── Casdoor OAuth ↔ Casdoor
  ├── POST login пользователя → внешний SIP auth service
  └── история вызовов

Browser (SIP.js) ── SIP over WSS/WebRTC ── PBX/SBC
```

Casdoor client secret и токен внешнего сервиса никогда не попадают в браузер. Временный SIP-пароль неизбежно выдаётся браузеру для SIP Digest-регистрации, но API помечено `no-store`, пароль не пишется в localStorage/историю и удаляется из объекта приложения после создания SIP.js UserAgent.

## Контракт внешнего SIP auth service

BFF отправляет:

```http
POST /api/v1/sip-credentials
Authorization: Bearer <SIP_AUTH_BEARER_TOKEN>
Content-Type: application/json

{"login":"casdoor-user"}
```

Рекомендуемый ответ:

```json
{
  "sipLogin": "1001",
  "sipPassword": "temporary-secret",
  "expiresIn": 300,
  "wssServer": "wss://pbx.example.com:8089/ws",
  "sipDomain": "pbx.example.com",
  "displayName": "Alice"
}
```

Также нормализуются поля `login|username`, `password`, `expire`, `server`, `domain`. `expire` может быть TTL в секундах, Unix timestamp или ISO-дата.

## Запуск

1. Скопируйте переменные окружения:

```bash
cp .env.example .env
```

2. В Casdoor создайте OIDC Application:

- Grant type: Authorization Code;
- Redirect URI должен совпадать с публичным адресом nginx, например `https://phone.example.com/api/auth/callback`;
- scope: `openid profile email`;
- `CASDOOR_ENDPOINT` или совместимый с asternic alias `CASDOOR_SERVER_URL` должен указывать на базовый URL Casdoor;
- `CASDOOR_ORG_NAME` и `CASDOOR_APP_NAME` соответствуют `org_name`/`app_name` из asternic-конфига и добавляются в URL входа как `organization`/`application`;
- после обмена `code` backend запрашивает `/api/userinfo` с `Authorization: Bearer <access_token>` и сохраняет пользователя в сессию;
- логин Casdoor читается из `preferred_username` (настраивается через `CASDOOR_LOGIN_CLAIM`) и нормализуется до части перед `@`, как в asternic.

3. Установите зависимости и запустите:

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`; BFF: `http://localhost:3000`.

Телефонная книга хранится локально в `localStorage` браузера отдельно для каждого Casdoor-логина. Вкладка «Контакты» позволяет добавлять и удалять записи, подставлять номер в поле набора, экспортировать книгу в JSON и импортировать как ранее экспортированный объект `{ "version": 1, "contacts": [...] }` или JSON-массив контактов. Импорт объединяет записи по номеру: контакт из файла заменяет локальную запись с тем же номером.

Для запуска контейнеров используйте `docker compose up --build`. Контейнер nginx принимает внешний трафик на `${HTTP_PORT:-80}` и проксирует все запросы (включая `/api`) во внутренний `sip-phone:3000`; порт backend наружу не публикуется. Compose запускает backend в production-режиме, чтобы он раздавал собранный frontend. Укажите публичный адрес nginx в `APP_BASE_URL`, а тот же адрес с путём `/api/auth/callback` — в `CASDOOR_REDIRECT_URI`. В production передавайте в nginx исходный HTTPS через TLS-терминатор либо добавьте сертификат непосредственно в его конфигурацию; nginx сохраняет `X-Forwarded-Proto`, поэтому session cookie автоматически получает флаг `Secure` для HTTPS.

## Production

```bash
npm run build
NODE_ENV=production npm start
```

В production BFF раздаёт `apps/client/dist`. Размещайте приложение только за HTTPS; SIP endpoint должен быть `wss://`.

Обязательно замените стандартный MemoryStore у `express-session` на Redis/PostgreSQL session store для нескольких инстансов. Файловое хранилище истории предназначено для одного процесса; адаптер `HistoryStore` следует заменить на вашу БД. Добавьте rate limiting на reverse proxy и настройте TURN для пользователей за сложным NAT.

## PBX/SBC требования

- SIP over secure WebSocket (WSS);
- WebRTC media: DTLS-SRTP, ICE, RTCP mux;
- сертификат WSS, доверенный браузером;
- разрешённый codec, обычно Opus и/или PCMU/PCMA;
- поддержка `REFER` для blind transfer;
- корректные NAT/public address настройки и TURN при необходимости.

## Поведение обновления SIP-реквизитов

`refreshAfter = expiresIn - SIP_REFRESH_SKEW_SECONDS`. При отсутствии разговора UserAgent безопасно перерегистрируется с новыми данными. Во время активного звонка новые реквизиты сохраняются в памяти и применяются сразу после завершения звонка, чтобы не разорвать текущий SIP dialog. Поэтому внешний TTL должен быть больше ожидаемой максимальной длительности разговора либо PBX должен позволять существующему dialog продолжаться после истечения registration credentials.

## Что реализован перевод

Текущая кнопка выполняет **blind transfer** (`REFER` на новый SIP URI). Для attended transfer потребуется второй параллельный dialog, hold первого звонка и REFER/Replaces; это отдельный сценарий поверх текущего `SipPhone`.
