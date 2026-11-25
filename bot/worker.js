/* Bot de Telegram para el RPG de Notion de Manu.
   Cloudflare Worker. Secretos (se cargan en Cloudflare, nunca en el código):
   TELEGRAM_TOKEN, NOTION_TOKEN, GEMINI_KEY, WEBHOOK_SECRET (cualquier texto largo inventado por vos)
   Opcional: ALLOWED_CHAT_ID (tu id de Telegram; si falta, el bot te lo dice en el primer mensaje). */

const DB = "302dd23d-90e3-800b-9ab2-f8bc08f0a857";
const HAB = {
  "Estudios": "302dd23d-90e3-80ce-ba48-e8c2769cee44",
  "Trabajo": "30edd23d-90e3-8043-b189-dcbda6a3d20f",
  "Lectura": "302dd23d-90e3-80e3-99dc-f4ce6e8dbda8",
  "Sueño": "3cddd23d-90e3-8086-a032-c446ac8ab3fe",
  "Ejercicio": "302dd23d-90e3-8002-83b7-cfab600d68fa",
  "Finanzas": "302dd23d-90e3-80f5-a84c-c2eb30e389ab",
  "Espiritual": "302dd23d-90e3-80d0-ae73-edf8d5d8f0a8",
  "Marca Personal": "3b8dd23d-90e3-8044-a8be-d753d9a28e26"
};
const HAB_POR_ID = Object.fromEntries(Object.entries(HAB).map(([k, v]) => [v.replace(/-/g, ""), k]));
const MODELOS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-flash-latest"];
const TZ = "-03:00";

/* ---------- tiempo (Argentina, UTC-3 fijo) ---------- */
const ar = (d) => new Date((d || new Date()).getTime() - 3 * 3600e3);
const pad = (n) => String(n).padStart(2, "0");
const fechaAR = (d) => { const a = ar(d); return a.getUTCFullYear() + "-" + pad(a.getUTCMonth() + 1) + "-" + pad(a.getUTCDate()); };
const horaAR = (d) => { const a = ar(d); return pad(a.getUTCHours()) + ":" + pad(a.getUTCMinutes()); };
const sumarDias = (f, n) => { const d = new Date(f + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const diaSemana = (f) => DIAS[new Date(f + "T12:00:00Z").getUTCDay()];

/* ---------- Notion ---------- */
async function notion(env, path, method, body) {
  const r = await fetch("https://api.notion.com/v1/" + path, {
    method, headers: { Authorization: "Bearer " + env.NOTION_TOKEN, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Notion: " + (j.message || r.status));
  return j;
}
function leerTarea(p) {
  const pr = p.properties || {};
  const tx = (x) => (x && x.title ? x.title.map((t) => t.plain_text).join("") : "");
  const rel = (pr["Habilidad"] && pr["Habilidad"].relation) || [];
  return {
    id: p.id,
    nombre: tx(pr["Nombre"]),
    habilidad: rel.map((x) => HAB_POR_ID[x.id.replace(/-/g, "")] || "?").join(", "),
    min: pr["Duración (min)"] ? pr["Duración (min)"].number : null,
    hecho: !!(pr["Completado"] && pr["Completado"].checkbox),
    estado: pr["Estado"] && pr["Estado"].status ? pr["Estado"].status.name : "",
    inicio: pr["Fecha Inicio"] && pr["Fecha Inicio"].date ? pr["Fecha Inicio"].date.start : null,
    fin: pr["Fecha Fin"] && pr["Fecha Fin"].date ? pr["Fecha Fin"].date.start : null,
    evento: !!(pr["Es evento"] && pr["Es evento"].checkbox),
    pen: !!(pr["Penalizado"] && pr["Penalizado"].checkbox),
    perdidos: pr["Puntos perdidos"] ? pr["Puntos perdidos"].number : null
  };
}
async function tareasDesde(env, desde, hasta) {
  let out = [], cursor;
  do {
    const j = await notion(env, "databases/" + DB + "/query", "POST", {
      page_size: 100, start_cursor: cursor,
      filter: { and: [{ property: "Fecha Inicio", date: { on_or_after: desde } }, { property: "Fecha Inicio", date: { on_or_before: hasta } }] },
      sorts: [{ property: "Fecha Inicio", direction: "ascending" }]
    });
    out = out.concat(j.results.map(leerTarea)); cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && out.length < 400);
  return out;
}
function fechaNotion(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.length === 16 ? s + ":00" + TZ : s; }
function propsDe(a) {
  const p = {};
  if (a.nombre) p["Nombre"] = { title: [{ text: { content: String(a.nombre).slice(0, 200) } }] };
  if (a.habilidad && HAB[a.habilidad]) p["Habilidad"] = { relation: [{ id: HAB[a.habilidad] }] };
  if (a.min != null && !isNaN(+a.min)) p["Duración (min)"] = { number: Math.max(0, Math.round(+a.min)) };
  if (a.inicio) { p["Fecha Inicio"] = { date: { start: fechaNotion(a.inicio) } }; }
  if (a.fin) { p["Fecha Fin"] = { date: { start: fechaNotion(a.fin) } }; }
  if (a.estado) { p["Estado"] = { status: { name: a.estado } }; if (a.estado === "Hecho") p["Completado"] = { checkbox: true }; }
  if (a.estado === "Pendientes" || a.estado === "En progreso") p["Completado"] = { checkbox: false };
  if (a.penalizado) { p["Penalizado"] = { checkbox: true }; }
  if (a.perdidos != null) p["Puntos perdidos"] = { number: Math.max(0, Math.round(+a.perdidos)) };
  if (a.nota) p["Descripción"] = { rich_text: [{ text: { content: String(a.nota).slice(0, 1900) } }] };
  return p;
}
async function aplicarAcciones(env, acciones, validos) {
  const log = [];
  for (const a of acciones || []) {
    try {
      if (a.estado && ["Pendientes", "En progreso", "Hecho"].indexOf(a.estado) < 0) a.estado = "";
      if (a.op === "crear") {
        if (!a.nombre || !a.habilidad || !HAB[a.habilidad]) { log.push("saltée una tarea sin nombre o habilidad válida"); continue; }
        await notion(env, "pages", "POST", { parent: { database_id: DB }, properties: propsDe(a) });
        log.push("creé " + a.nombre);
      } else if (a.op === "actualizar" && a.id && validos.has(a.id)) {
        await notion(env, "pages/" + a.id, "PATCH", { properties: propsDe(a) });
        log.push("actualicé " + (a.nombre || a.id));
      } else if (a.op === "borrar" && a.id && validos.has(a.id)) {
        await notion(env, "pages/" + a.id, "PATCH", { archived: true });
        log.push("saqué " + (a.nombre || a.id));
      } else log.push("ignoré una acción inválida");
    } catch (e) { log.push("falló '" + (a.nombre || a.id) + "': " + e.message); }
  }
  return log;
}

/* ---------- resumen para analizar ---------- */
function resumen(tareas, hoy) {
  const porDia = {};
  tareas.filter((t) => t.hecho && t.inicio).forEach((t) => {
    const d = t.inicio.slice(0, 10); porDia[d] = porDia[d] || {};
    const h = t.habilidad || "?"; porDia[d][h] = (porDia[d][h] || 0) + (t.min || 0);
  });
  const perd = {};
  tareas.filter((t) => t.pen && t.inicio).forEach((t) => {
    const d = t.inicio.slice(0, 10); perd[d] = perd[d] || { puntos: 0, tareas: [] };
    perd[d].puntos += t.perdidos || 0; perd[d].tareas.push(t.nombre);
  });
  const dias = Array.from(new Set(Object.keys(porDia).concat(Object.keys(perd)))).sort();
  return dias.map((d) => ({ dia: d, min_hechos_por_habilidad: porDia[d] || {}, penalizadas: perd[d] || null }));
}

/* ---------- Gemini ---------- */
function prompt(hoy, ahora, tareasHoy, tareasSem, texto, hayAudio) {
  const comp = (t) => ({ id: t.id, n: t.nombre, h: t.habilidad, min: t.min, ok: t.hecho, est: t.estado, ini: t.inicio, fin: t.fin });
  return [
    "Sos el agente de Manu (estudiante en Argentina, UTC-3, habla en rioplatense). Maneja su RPG de Notion: cada tarea tiene una Habilidad y una duración real en minutos; al marcarla Hecho se le suma XP a la habilidad. Respondé SOLO JSON.",
    "HOY: " + hoy + " (" + diaSemana(hoy) + "). AHORA: " + ahora + ".",
    hayAudio ? "El mensaje de Manu es el AUDIO adjunto (puede tener muletillas y errores de transcripción; interpretá con sentido común). Ponelo en 'transcripcion'." : "MENSAJE DE MANU: " + texto,
    "HABILIDADES VÁLIDAS: " + Object.keys(HAB).join(", ") + ".",
    "TAREAS DE HOY (id, n=nombre, h=habilidad, min=duración, ok=completada, est=estado, ini/fin): " + JSON.stringify(tareasHoy.map(comp)),
    "MINUTOS COMPLETADOS Y TAREAS PENALIZADAS (no hechas a las 23:59; puntos perdidos = minutos x 3) POR DÍA (últimos 7 días): " + JSON.stringify(resumen(tareasSem, hoy)),
    "PENDIENTES ATRASADAS (no completadas, de días anteriores): " + JSON.stringify(tareasSem.filter((t) => !t.hecho && !t.evento && t.inicio && t.inicio.slice(0, 10) < hoy).slice(-30).map(comp)),
    "TAREAS DE LA SEMANA (resumen): " + JSON.stringify(tareasSem.filter((t) => t.inicio && t.inicio.slice(0, 10) !== hoy).slice(-60).map(comp)),
    "",
    "REGLAS:",
    "- Si cuenta algo que hizo: buscá la tarea de hoy que corresponde y actualizala (op 'actualizar', estado 'Hecho', min = minutos REALES que dijo). Si no existe, creala (op 'crear') con inicio y fin reales (formato AAAA-MM-DDTHH:MM, hora argentina; si no da horas, encadená hacia atrás desde ahora) y estado 'Hecho'. min = minutos reales.",
    "- Nunca marques Hecho lo que dice que NO hizo. Si no queda claro el tiempo, preguntá UNA cosa y no cambies nada.",
    "- Kanban: 'estoy con X' / 'empiezo X' = X pasa a 'En progreso' con inicio ahora, y la que estaba 'En progreso' antes pasa a 'Hecho' si la terminó o a 'Pendientes' si la dejó a medias (si no está claro, a 'Pendientes'). 'Terminé X, ahora voy con Y' = X 'Hecho' con minutos reales, Y 'En progreso'. Solo una tarea 'En progreso' a la vez.",
    "- 'Cambiame el día a hoy' / 'pasá X para hoy' = actualizar la tarea (op 'actualizar') con inicio y fin de hoy (misma hora si la tenía, si no 'AAAA-MM-DD' de hoy solamente). Sirve para las PENDIENTES ATRASADAS. Nunca muevas tareas ya completadas.",
    "- 'Empiezo X' = estado 'En progreso' con inicio ahora. Plantillas diarias existentes (Sueño, Cursada, Trabajo Diario, etc.) se reutilizan: actualizalas, no dupliques.",
    "- Si pide armar el día o el resto del día: creá tareas 'Pendientes' con inicio y fin, contiguas, desde ahora hasta ~23:30, con estudio en bloques de 50 min con pausas de 5-10, trabajo en sprints de 40-45 min, comidas máx 40 min, siesta 20 opcional, hábitos (lectura, inversiones, LinkedIn/Marca Personal 20 min, ejercicio). Habilidades de descanso/comida: usá 'Sueño' solo para dormir; para comidas y pausas no crees tareas.",
    "- Para otro día ('mañana'), calculá la fecha y armalo igual.",
    "- Si pregunta cómo viene o pide análisis: respondé con los datos de arriba, comparando lo que dijo que hizo con los minutos registrados; señalá incoherencias (ej. 3 h de trabajo pero solo se nombró una tarea de 1 h), tiempo sin registrar, y qué mejorar. No inventes datos que no estén.",
    "- Metas de referencia: ~7 h diarias entre estudio y trabajo. Parciales: Cálculo y Organizaciones 24/11, Informática 27/11, Física 30/11.",
    "FORMATO: {\"transcripcion\":\"\",\"acciones\":[{\"op\":\"crear|actualizar|borrar\",\"id\":\"solo para actualizar/borrar\",\"nombre\":\"\",\"habilidad\":\"\",\"min\":0,\"inicio\":\"AAAA-MM-DDTHH:MM\",\"fin\":\"AAAA-MM-DDTHH:MM\",\"estado\":\"Pendientes|En progreso|Hecho\",\"nota\":\"\"}],\"respuesta\":\"texto plano corto, sin markdown\"}"
  ].join("\n");
}
async function gemini(env, partes) {
  let ultimo;
  for (const m of MODELOS) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
    try {
      const gc = { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 8192 };
      if (/2\.5/.test(m)) gc.thinkingConfig = { thinkingBudget: 0 }; else gc.thinkingConfig = { thinkingLevel: "low" };
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent", {
        method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: partes }], generationConfig: gc })
      });
      const txt = await r.text();
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Gemini rechazó la clave"), { fatal: true });
      if (!r.ok) { ultimo = new Error("Gemini " + r.status); continue; }
      const j = JSON.parse(txt), c = j.candidates && j.candidates[0];
      const out = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || "").join("") : "";
      if (!out) { ultimo = new Error("Gemini no respondió"); continue; }
      return parseJSON(out);
    } catch (e) { if (e.fatal) throw e; ultimo = e; } finally { clearTimeout(t); }
  }
  throw ultimo || new Error("Gemini no respondió");
}
function parseJSON(s) {
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("respuesta no válida");
}
function b64(buf) { let s = "", u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }

/* ---------- Telegram ---------- */
async function tg(env, metodo, body) {
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/" + metodo, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
const decir = (env, chat, texto) => tg(env, "sendMessage", { chat_id: chat, text: String(texto).slice(0, 4000) });

async function procesar(env, msg) {
  const chat = msg.chat.id;
  if (!env.ALLOWED_CHAT_ID) { await decir(env, chat, "Tu ID de Telegram es " + chat + ". Cargalo en Cloudflare como ALLOWED_CHAT_ID y volvé a escribirme."); return; }
  if (String(chat) !== String(env.ALLOWED_CHAT_ID)) return;
  const audio = msg.voice || msg.audio;
  const texto = (msg.text || msg.caption || "").trim();
  if (texto === "/start") { await decir(env, chat, "Listo. Mandame un audio o un texto con lo que hiciste, lo que vas a hacer, o pedime que arme el día."); return; }
  if (!audio && !texto) { await decir(env, chat, "Mandame un audio o un texto."); return; }
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" });
  try {
    const ahoraD = new Date(), hoy = fechaAR(ahoraD), ahora = horaAR(ahoraD);
    const sem = await tareasDesde(env, sumarDias(hoy, -7), sumarDias(hoy, 7));
    const hoyT = sem.filter((t) => t.inicio && t.inicio.slice(0, 10) === hoy);
    const validos = new Set(sem.map((t) => t.id));
    const partes = [{ text: prompt(hoy, ahora, hoyT, sem.filter((t) => t.inicio && t.inicio.slice(0, 10) <= hoy), texto, !!audio) }];
    if (audio) {
      const f = await tg(env, "getFile", { file_id: audio.file_id });
      if (!f.ok) throw new Error("no pude bajar el audio");
      const buf = await (await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_TOKEN + "/" + f.result.file_path)).arrayBuffer();
      const mime = (audio.mime_type || "audio/ogg").replace(/;.*/, "");
      partes.push({ inlineData: { mimeType: mime, data: b64(buf) } });
    }
    const r = await gemini(env, partes);
    const log = await aplicarAcciones(env, r.acciones, validos);
    let out = "";
    if (audio && r.transcripcion) out += "🎙️ " + r.transcripcion + "\n\n";
    out += r.respuesta || "Listo.";
    const fallas = log.filter((l) => /falló|saltée|ignoré/.test(l));
    if (fallas.length) out += "\n\n⚠️ " + fallas.join("; ");
    await decir(env, chat, out);
  } catch (e) {
    await decir(env, chat, "No pude procesarlo: " + e.message + ". Probá de nuevo.");
  }
}

/* ---------- Tareas programadas ---------- */
async function penalizarDia(env, fecha) {
  const j = await notion(env, "databases/" + DB + "/query", "POST", {
    page_size: 100,
    filter: { and: [
      { property: "Fecha Inicio", date: { on_or_after: fecha } }, { property: "Fecha Inicio", date: { before: sumarDias(fecha, 1) } },
      { property: "Completado", checkbox: { equals: false } }, { property: "Penalizado", checkbox: { equals: false } }, { property: "Es evento", checkbox: { equals: false } }
    ] }
  });
  let n = 0, pts = 0;
  for (const p of j.results) {
    const t = leerTarea(p), perdidos = (t.min == null ? 30 : t.min) * 3;
    try { await notion(env, "pages/" + t.id, "PATCH", { properties: { "Penalizado": { checkbox: true }, "Puntos perdidos": { number: perdidos } } }); n++; pts += perdidos; } catch (e) {}
  }
  return { n, pts };
}
async function resumenSemanal(env) {
  const hoy = fechaAR(new Date()), desde = sumarDias(hoy, -6);
  const ts = await tareasDesde(env, desde, hoy);
  const xp = {}, perdidos = {}, tareasPerdidas = [];
  ts.forEach((t) => {
    const h = t.habilidad || "?";
    if (t.hecho) xp[h] = (xp[h] || 0) + (t.min || 0) * 3;
    if (t.pen) { perdidos[h] = (perdidos[h] || 0) + (t.perdidos || 0); tareasPerdidas.push(t.nombre + " (" + (t.inicio || "").slice(5, 10) + ")"); }
  });
  const totXP = Object.values(xp).reduce((a, b) => a + b, 0), totP = Object.values(perdidos).reduce((a, b) => a + b, 0);
  const datos = { desde, hasta: hoy, xp_ganado_aprox_por_habilidad: xp, total_xp: totXP, puntos_perdidos_por_habilidad: perdidos, total_puntos_perdidos: totP, tareas_no_hechas: tareasPerdidas.slice(0, 25), min_hechos_por_dia: resumen(ts, hoy) };
  let analisis = "";
  try {
    const r = await gemini(env, [{ text: "Sos el agente de Manu (rioplatense, directo). Escribí el resumen semanal en texto plano, sin markdown, máx 12 líneas: cuánto XP ganó, cuántos puntos perdió, en qué habilidad más, qué tareas no hizo, un diagnóstico honesto (¿se dedicó a lo importante? ¿hubo parciales esta semana? Cálculo y Organizaciones 24/11, Informática 27/11, Física 30/11) y 2 cosas concretas para mejorar la próxima semana. No inventes. Datos: " + JSON.stringify(datos) + '\nRespondé JSON: {"respuesta":""}' }]);
    analisis = r.respuesta || "";
  } catch (e) {}
  if (!analisis) analisis = "XP ganado: " + totXP + ". Puntos perdidos: " + totP + ". No hechas: " + (tareasPerdidas.join(", ") || "ninguna") + ".";
  return "📊 Resumen de la semana (" + desde + " a " + hoy + ")\nXP ganado: " + totXP + " · Puntos perdidos: " + totP + "\n\n" + analisis;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.ALLOWED_CHAT_ID) return;
    ctx.waitUntil((async () => {
      try {
        if (event.cron === "59 2 * * *") {
          const r = await penalizarDia(env, fechaAR(new Date(Date.now() - 10 * 60e3)));
          if (r.n) await decir(env, env.ALLOWED_CHAT_ID, "⏰ Cierre del día: " + r.n + " tarea(s) sin hacer quedaron penalizadas (" + r.pts + " puntos perdidos).");
        } else if (event.cron === "0 1 * * 1") {
          await decir(env, env.ALLOWED_CHAT_ID, await resumenSemanal(env));
        }
      } catch (e) { await decir(env, env.ALLOWED_CHAT_ID, "No pude hacer el cierre automático: " + e.message); }
    })());
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/setup") {
      if (url.searchParams.get("s") !== env.WEBHOOK_SECRET) return new Response("no", { status: 403 });
      const r = await tg(env, "setWebhook", { url: url.origin + "/telegram", secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message"] });
      return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/telegram" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("no", { status: 403 });
      const up = await req.json();
      if (up.message) ctx.waitUntil(procesar(env, up.message));
      return new Response("ok");
    }
    return new Response("Agente de Manu activo.");
  }
};
