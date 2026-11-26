# Bot de Telegram para el RPG de Notion

Un solo archivo: `worker.js` (Cloudflare Worker). No tiene ningún secreto adentro.

## Instalación (10 minutos, desde el celu o la compu)
1. dash.cloudflare.com → Workers & Pages → Create → **Create Worker** → nombre `agente-manu` → Deploy.
2. **Edit code** → borrá todo → pegá el contenido de `worker.js` → Deploy.
3. Settings → **Variables and Secrets** → Add → tipo **Secret**, uno por uno:
   - `TELEGRAM_TOKEN` (el de @BotFather)
   - `NOTION_TOKEN` (el que empieza con ntn_)
   - `GEMINI_KEY`
   - `WEBHOOK_SECRET` (inventá una clave larga, solo letras y números)
4. Abrí en el navegador `https://TU-WORKER.workers.dev/setup?s=TU_WEBHOOK_SECRET` → tiene que decir `"ok":true`.
5. Escribile algo al bot. Te va a decir tu ID de Telegram → cargalo como secret `ALLOWED_CHAT_ID` → Deploy.
6. En Notion: página RPG → ··· → Conexiones → agregá tu integración.
7. Programar los avisos automáticos: tu Worker → Settings → **Triggers** → Cron Triggers → Add, dos veces:
   - `0 8 * * *` (cierre del día a las 05:00 de Argentina, fin del día lógico: penaliza los hábitos que no hiciste)
   - `0 9 * * *` (cada día a las 06:00 de Argentina: crea los hábitos de hoy y de los 2 días siguientes)
   - `0 1 * * 1` (resumen semanal: domingo 22:00 de Argentina)
