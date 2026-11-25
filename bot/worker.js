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
    desc: pr["Descripción"] && pr["Descripción"].rich_text ? pr["Descripción"].rich_text.map((t) => t.plain_text).join("") : "",
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
async function aplicarAcciones(env, acciones, validos, sem, hoy) {
  const log = [];
  const usados = {};
  for (const a of acciones || []) {
    try {
      if (a.estado && ["Pendientes", "En progreso", "Hecho"].indexOf(a.estado) < 0) a.estado = "";
      if (a.op === "sumar") {
        const min = Math.round(+a.min);
        if (!(min > 0)) { log.push("saltée una suma sin minutos"); continue; }
        const nombre = a.nombre || "Trabajo Diario", hab = HAB[a.habilidad] ? a.habilidad : "Trabajo", fecha = hoy, linea = horaAR(new Date()) + " · " + (a.detalle || "trabajo") + " (" + min + " min)";
        const cs = (sem || []).filter((t) => t.nombre === nombre && t.inicio && t.inicio.slice(0, 10) === fecha).sort((x, y) => (x.inicio < y.inicio ? -1 : 1));
        const ahoraMs = Date.now(), pend = cs.filter((t) => !t.hecho && t.inicio).sort((x, y) => Math.abs(Date.parse(x.inicio) - ahoraMs) - Math.abs(Date.parse(y.inicio) - ahoraMs));
        usados[nombre] = usados[nombre] || null;
        let c = usados[nombre] || pend[0] || cs[cs.length - 1];
        usados[nombre] = c || null;
        if (c) {
          const total = (c.hecho ? (c.min || 0) : 0) + min, desc = ((c.desc ? c.desc + "\n" : "") + linea).slice(-1900);
          await notion(env, "pages/" + c.id, "PATCH", { properties: { "Duración (min)": { number: total }, "Estado": { status: { name: "Hecho" } }, "Completado": { checkbox: true }, "Descripción": { rich_text: [{ text: { content: desc } }] } } });
          c.hecho = true; c.min = total; c.desc = desc;
          log.push("sumé " + min + " min a " + nombre + " (total " + total + ")");
        } else {
          const pg = await notion(env, "pages", "POST", { parent: { database_id: DB }, properties: { "Nombre": { title: [{ text: { content: nombre } }] }, "Habilidad": { relation: [{ id: HAB[hab] }] }, "Duración (min)": { number: min }, "Fecha Inicio": { date: { start: fecha } }, "Fecha Fin": { date: { start: fecha } }, "Estado": { status: { name: "Hecho" } }, "Completado": { checkbox: true }, "Descripción": { rich_text: [{ text: { content: linea } }] } } });
          const nuevo = { id: pg.id, nombre, hecho: true, min, desc: linea, inicio: fecha, habilidad: hab }; (sem || []).push(nuevo); usados[nombre] = nuevo;
          log.push("creé " + nombre + " con " + min + " min");
        }
      } else if (a.op === "crear") {
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
function prompt(hoy, ahora, tareasHoy, tareasSem, texto, hayAudio, proximas) {
  const comp = (t) => ({ id: t.id, n: t.nombre, h: t.habilidad, min: t.min, ok: t.hecho, est: t.estado, ini: t.inicio, fin: t.fin, d: (t.desc || "").slice(-400) });
  return [
    "Sos el agente de Manu (estudiante en Argentina, UTC-3, habla en rioplatense). Maneja su RPG de Notion: cada tarea tiene una Habilidad y una duración real en minutos; al marcarla Hecho se le suma XP a la habilidad. Respondé SOLO JSON.",
    "HOY: " + hoy + " (" + diaSemana(hoy) + "). AHORA: " + ahora + ".",
    hayAudio ? "El mensaje de Manu es el AUDIO adjunto (puede tener muletillas y errores de transcripción; interpretá con sentido común). Ponelo en 'transcripcion'." : "MENSAJE DE MANU: " + texto,
    "HABILIDADES VÁLIDAS: " + Object.keys(HAB).join(", ") + ".",
    "TAREAS DE HOY (id, n=nombre, h=habilidad, min=duración, ok=completada, est=estado, ini/fin): " + JSON.stringify(tareasHoy.map(comp)),
    "MINUTOS COMPLETADOS Y TAREAS PENALIZADAS (no hechas a las 23:59; puntos perdidos = minutos x 3) POR DÍA (últimos 7 días): " + JSON.stringify(resumen(tareasSem, hoy)),
    "PRÓXIMOS DÍAS (ya cargados en Notion, incluyen plantillas como Cursada/Sueño; si coinciden con lo que pide, actualizalas en vez de duplicar): " + JSON.stringify((proximas || []).map(comp)),
    "PENDIENTES ATRASADAS (no completadas, de días anteriores): " + JSON.stringify(tareasSem.filter((t) => !t.hecho && !t.evento && t.inicio && t.inicio.slice(0, 10) < hoy).slice(-30).map(comp)),
    "TAREAS DE LA SEMANA (resumen): " + JSON.stringify(tareasSem.filter((t) => t.inicio && t.inicio.slice(0, 10) !== hoy).slice(-60).map(comp)),
    "",
    "REGLAS:",
    "- Si cuenta algo que hizo: buscá la tarea de hoy que corresponde y actualizala (op 'actualizar', estado 'Hecho', min = minutos REALES que dijo). Si no existe, creala (op 'crear') con inicio y fin reales (formato AAAA-MM-DDTHH:MM, hora argentina; si no da horas, encadená hacia atrás desde ahora) y estado 'Hecho'. min = minutos reales.",
    "- Nunca marques Hecho lo que dice que NO hizo. Si no queda claro el tiempo, preguntá UNA cosa y no cambies nada.",
    "- Kanban: 'estoy con X' / 'empiezo X' = X pasa a 'En progreso' con inicio ahora, y la que estaba 'En progreso' antes pasa a 'Hecho' si la terminó o a 'Pendientes' si la dejó a medias (si no está claro, a 'Pendientes'). 'Terminé X, ahora voy con Y' = X 'Hecho' con minutos reales, Y 'En progreso'. Solo una tarea 'En progreso' a la vez.",
    "- 'Cambiame el día a hoy' / 'pasá X para hoy' = actualizar la tarea (op 'actualizar') con inicio y fin de hoy (misma hora si la tenía, si no 'AAAA-MM-DD' de hoy solamente). Sirve para las PENDIENTES ATRASADAS. Nunca muevas tareas ya completadas.",
    "- 'Empiezo X' = estado 'En progreso' con inicio ahora. Si en el MISMO día ya hay una tarea equivalente (Sueño, Cursada, Trabajo Diario, etc.), actualizala en vez de duplicarla.",
    "- Si pide armar el día o el resto del día: creá tareas 'Pendientes' con inicio y fin, contiguas, desde ahora hasta ~23:30, con estudio en bloques de 50 min con pausas de 5-10, trabajo en sprints de 40-45 min, comidas máx 40 min, siesta 20 opcional, hábitos (lectura, inversiones, LinkedIn/Marca Personal 20 min, ejercicio). Habilidades de descanso/comida: usá 'Sueño' solo para dormir; para comidas y pausas no crees tareas.",
    "- Para otro día ('mañana'), calculá la fecha y armalo igual.",
    "- Si pregunta cómo viene o pide análisis: respondé con los datos de arriba, comparando lo que dijo que hizo con los minutos registrados; señalá incoherencias (ej. 3 h de trabajo pero solo se nombró una tarea de 1 h), tiempo sin registrar, y qué mejorar. No inventes datos que no estén.",
    "- Cuando arma un día: respetá clases fijas que diga (ponelas como tareas de 'Estudios' con sus horas exactas), luego repartí estudio según los parciales: más tiempo a la materia con parcial más cerca y más difícil (Cálculo > Informática > Física > Organizaciones). Estudio en bloques de 50 min con pausas de 5-10; trabajo (grabar videos, agencia, WhatsApp máx 10-30 min) en sprints de 40-45 min; alterná estudio y trabajo. Usá como referencia lo que suele hacer según el historial de arriba.",
    "- Hábitos diarios a incluir: lectura (10-15 min, mañana/mediodía/noche), inversiones 15 min (Finanzas), LinkedIn/Marca Personal 20 min, ejercicio (gimnasio o bici), meditar. Comidas máx 40 min (almuerzo ~13:00, merienda ~17:00, cena ~21:00), siesta 20 min opcional. El gimnasio cierra jueves 21:30 y sábado 13:00: si dice que va al gimnasio, ponelo antes del cierre.",
    "- REPROGRAMAR a mitad del día ('al final estudié X horas', 'no cursé', 'reorganizame todo'): 1) registrá lo que hizo como tareas reales con minutos reales y estado 'Hecho' (si ya existe la tarea de hoy, actualizala; si no, creala con horas encadenadas hacia atrás desde ahora). 2) Las tareas PENDIENTES de hoy que ya no tienen sentido o quedaron obsoletas, sacalas con op 'borrar' (solo si están 'Pendientes' y no son eventos; JAMÁS borres ni cambies tareas 'Hecho'). 3) Las pendientes que siguen valiendo, reubicalas con op 'actualizar' cambiando inicio y fin. 4) Creá las tareas nuevas que falten, contiguas desde ahora hasta ~23:30, priorizando lo más importante por los parciales para maximizar productividad. 5) Si dice que NO fue a algo fijo (ej. no cursó) NO lo marques Hecho ni lo borres: dejalo pendiente y avisale en la respuesta que a las 23:59 va a quedar penalizado, y que si quiere sacarlo se lo pida. 6) La respuesta resume el nuevo plan por bloques con horas.",
    "- HÁBITOS DIARIOS (se penalizan a las 23:59 si no se hacen; incluilos SIEMPRE al armar cualquier día): Ejercicio (60 min, habilidad Ejercicio; cuenta gimnasio, bicicleta, correr o cualquier ejercicio, todos los días; si dice que no pudo ir al gimnasio, NO lo marques hecho: queda penalizado salvo que haga otro ejercicio ese día), Lectura (30 min, habilidad Lectura), Estudiar Inversiones (15 min, habilidad Finanzas), Marca Personal (30 min, habilidad Marca Personal) y Meditar (7 min, habilidad Espiritual). Estudio (clases, grupos de estudio, estudio individual, consultas) y Trabajo (negocio y agencia) NO se penalizan por horas no cumplidas: si hizo menos de lo planeado, solo ajustá o sacá las pendientes y mencionalo.",
    "- TRABAJO (todo lo del negocio y la agencia: grabar videos, hablar con clientes, WhatsApp, paneles, investigar, etc.): NO crees una tarea por actividad. Usá op 'sumar' con {\"op\":\"sumar\",\"min\":MINUTOS,\"detalle\":\"lo que hizo, literal y breve\"}: el sistema suma los minutos a la tarea 'Trabajo Diario' de hoy (queda en Hecho) y guarda el detalle en su descripción. Una acción 'sumar' por cada actividad que cuente (ej. 'media hora grabando videos y 20 min con clientes' = dos acciones: 30 min 'grabar videos' y 20 min 'hablar con clientes'). Al PLANIFICAR, los huecos libres del día se llenan REPARTIDOS EQUITATIVAMENTE entre trabajo y estudio, alternando (aprox. mitad y mitad del tiempo libre): bloques 'Trabajo Diario' (Habilidad Trabajo) y bloques de estudio de la materia más urgente según los parciales (Habilidad Estudios, 45-50 min con pausas), de 45 a 90 min cada uno; no dejes huecos sin usar salvo comidas. Al REPORTAR trabajo hecho usá siempre 'sumar': los minutos van al bloque 'Trabajo Diario' pendiente más próximo (queda en Hecho con los minutos reales) y el detalle literal se guarda en su descripción. REGLA DE TIEMPO VERBAL (crítica): 'sumar' y el estado Hecho son SOLO para lo que ya pasó ('estuve', 'hice', 'terminé', 'hasta hace un rato'). Si habla en futuro o presente de intención ('ahora me pongo a', 'en 5 minutos arranco', 'voy a trabajar 20 minutos', 'poneme un bloque'), NO sumes ni marques Hecho: creá o actualizá un bloque 'Pendientes' (o 'En progreso' si arranca ya) con inicio y fin planificados (inicio = ahora o cuando dijo que arranca; fin = inicio + minutos dichos), y reordená lo que sigue (estudio, cursada, etc.) para que no se superponga. Recién cuando después diga que lo hizo, se registra con los minutos reales. ESTUDIO POR PORCENTAJES: si Manu dice cómo repartir el estudio (ej. '70% física y 30% informática'), sumá el tiempo de estudio disponible de cada día y dividilo en bloques con nombre literal por materia ('Estudio Física', 'Estudio Informática') respetando esa proporción de minutos, de 45-50 min con pausas, intercalados y sin superponer; cada bloque con Habilidad Estudios. Al reportar, igual que el trabajo: marcá el bloque de esa materia como Hecho con los minutos reales. BLOQUES: si Manu NO dice qué va a hacer, el trabajo va en bloques genéricos 'Trabajo Diario'. Si dice tareas concretas (ej. 'mañana programar videos, contestar consultas, seguimientos, subir historias'), creá bloques con esos nombres literales (Habilidad Trabajo, cada uno con su duración y hora) y no uses 'Trabajo Diario' para ellos. Al reportar: marcá el bloque que corresponde (por nombre, o por la hora si habla del bloque de tal hora) como Hecho con los minutos reales que dijo (si hizo más de una cosa en ese bloque, el total de minutos va al bloque y lo literal en 'detalle'), aunque sean menos o más que lo planificado. Un bloque cuya hora ya pasó y reportó queda cerrado; si después hay más trabajo, creá un bloque nuevo más tarde, acomodado sin superponerse con el resto. Los bloques 'Trabajo Diario' que no se usaron se reprograman, no se penalizan. 'sumar' también sirve para hábitos y otras tareas que hace en pedazos o fuera de lo planificado (ej. 'estuve leyendo 15 min' = {\"op\":\"sumar\",\"min\":15,\"nombre\":\"Lectura\",\"habilidad\":\"Lectura\",\"detalle\":\"leí\"}): suma los minutos a la tarea de hoy con ese nombre (si estaba pendiente queda Hecho con esos minutos reales; si ya estaba hecha, se acumulan) o la crea si no existe. Si lo hizo a una hora distinta de la planificada, después reordená con 'actualizar' los bloques pendientes del día para que no queden superpuestos ni huecos. El campo 'd' de cada tarea trae el detalle ya registrado: usalo para el análisis (comparar lo que dijo que hizo con los minutos).",
    "- DESHACER / CORREGIR: si Manu dice que se equivocó o pide volver una tarea atrás ('volvela a pendientes', 'todavía no terminé', 'no estaba en progreso'), actualizá esa tarea (op 'actualizar') al estado pedido ('Pendientes' o 'En progreso'), aunque estuviera 'Hecho'; al volver a Pendientes o En progreso deja de contar como completada. Esto aplica siempre que él lo pida explícitamente; la regla de no tocar tareas 'Hecho' es solo para cuando reorganizás por tu cuenta.",
    "- REGLA CRÍTICA: nunca muevas a otro día una tarea que ya está cargada para HOY (ni reutilices las plantillas de hoy para armar mañana). Para armar un día futuro, mirá PRÓXIMOS DÍAS: reutilizá solo las tareas que YA están en ese día; todo lo demás creálo nuevo con op 'crear'. Mover una tarea de hoy a otro día solo si Manu lo pide explícitamente ('pasá X para mañana').",
    "- Nombres de tareas: sin día de la semana (ej. 'Cursada Física', no 'Cursada Física Miércoles'): si reutilizás una plantilla de otro día, renombrala. En la respuesta SIEMPRE listá el plan completo por bloques con hora de inicio y fin, incluyendo hábitos, y no digas 'quedó todo armado' si faltó algo.",
    "- Si pide organizar un día futuro, devolvé TODAS las tareas de ese día con inicio y fin (formato AAAA-MM-DDTHH:MM), contiguas y sin superponerse, desde las 7:00 hasta ~23:30, y en la respuesta resumí el plan por bloques con horas.",
    "- Metas de referencia: ~7 h diarias entre estudio y trabajo. Parciales: Cálculo y Organizaciones 24/11, Informática 27/11, Física 30/11.",
    "FORMATO: {\"transcripcion\":\"\",\"acciones\":[{\"op\":\"crear|actualizar|borrar|sumar\",\"detalle\":\"solo para sumar\",\"id\":\"solo para actualizar/borrar\",\"nombre\":\"\",\"habilidad\":\"\",\"min\":0,\"inicio\":\"AAAA-MM-DDTHH:MM\",\"fin\":\"AAAA-MM-DDTHH:MM\",\"estado\":\"Pendientes|En progreso|Hecho\",\"nota\":\"\"}],\"respuesta\":\"texto plano corto, sin markdown\"}"
  ].join("\n");
}
async function gemini(env, partes) {
  let ultimo;
  for (let ronda = 0; ronda < 3; ronda++) {
  if (ronda) await new Promise((r) => setTimeout(r, 2500 * ronda));
  let saturado = false;
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
      if (!r.ok) { ultimo = new Error("Gemini " + r.status); if (r.status === 503 || r.status === 429 || r.status >= 500) saturado = true; continue; }
      const j = JSON.parse(txt), c = j.candidates && j.candidates[0];
      const out = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || "").join("") : "";
      if (!out) { ultimo = new Error("Gemini no respondió"); continue; }
      return parseJSON(out);
    } catch (e) { if (e.fatal) throw e; ultimo = e; } finally { clearTimeout(t); }
  }
  if (!saturado) break;
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


/* Garantiza que cada día planificado tenga los 5 hábitos: si Gemini se olvidó alguno, lo agrega en un hueco libre */
const mm = (hhmm) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
const hh = (m) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
function completarHabitos(acciones, sem, hoy) {
  const extra = [], dias = {};
  (acciones || []).forEach((a) => { if (a.op === "crear" && a.inicio && a.inicio.length >= 16 && a.estado !== "Hecho") dias[a.inicio.slice(0, 10)] = 1; });
  Object.keys(dias).forEach((d) => {
    if (d < hoy) return;
    const nombresAcc = (acciones || []).filter((a) => a.op !== "borrar" && a.inicio && a.inicio.slice(0, 10) === d).map((a) => a.habilidad || "");
    const borrados = new Set((acciones || []).filter((a) => a.op === "borrar").map((a) => a.id));
    const existentes = sem.filter((t) => t.inicio && t.inicio.slice(0, 10) === d && !borrados.has(t.id));
    const tieneH = (h) => nombresAcc.indexOf(h) >= 0 || existentes.some((t) => t.habilidad === h);
    const ocupado = [];
    existentes.forEach((t) => { if (t.inicio.length > 10 && t.fin && t.fin.length > 10) ocupado.push([mm(t.inicio.slice(11, 16)), mm(t.fin.slice(11, 16))]); });
    (acciones || []).forEach((a) => { if (a.op !== "borrar" && a.inicio && a.fin && a.inicio.slice(0, 10) === d && a.fin.length >= 16) ocupado.push([mm(a.inicio.slice(11, 16)), mm(a.fin.slice(11, 16)) || 1440]); });
    const ahoraMin = d === hoy ? 0 : 0;
    Object.keys(HABITOS).forEach((h) => {
      if (tieneH(h)) return;
      const dur = HABITOS[h];
      for (let t = 7 * 60; t + dur <= 23 * 60 + 30; t += 5) {
        if (t < ahoraMin) continue;
        if (ocupado.every((o) => t + dur <= o[0] || t >= o[1])) {
          extra.push({ op: "crear", nombre: NOMBRE_HABITO[h], habilidad: h, min: dur, inicio: d + "T" + hh(t), fin: d + "T" + hh(t + dur), estado: "Pendientes" });
          ocupado.push([t, t + dur]); return;
        }
      }
    });
  });
  return extra;
}

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
    const partes = [{ text: prompt(hoy, ahora, hoyT, sem.filter((t) => t.inicio && t.inicio.slice(0, 10) <= hoy), texto, !!audio, sem.filter((t) => t.inicio && t.inicio.slice(0, 10) > hoy)) }];
    if (audio) {
      const f = await tg(env, "getFile", { file_id: audio.file_id });
      if (!f.ok) throw new Error("no pude bajar el audio");
      const buf = await (await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_TOKEN + "/" + f.result.file_path)).arrayBuffer();
      const mime = (audio.mime_type || "audio/ogg").replace(/;.*/, "");
      partes.push({ inlineData: { mimeType: mime, data: b64(buf) } });
    }
    const r = await gemini(env, partes);
    const acc = (r.acciones || []).concat(completarHabitos(r.acciones, sem, hoy));
    const log = await aplicarAcciones(env, acc, validos, sem, hoy);
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
/* Hábitos diarios que se penalizan si no se hacen: habilidad -> minutos por defecto */
const HABITOS = { "Ejercicio": 60, "Lectura": 30, "Finanzas": 15, "Marca Personal": 30, "Espiritual": 7 };
const NOMBRE_HABITO = { "Ejercicio": "Ejercicio", "Lectura": "Lectura", "Finanzas": "Estudiar Inversiones", "Marca Personal": "Marca Personal", "Espiritual": "Meditar" };
const PENALIZAR_DESDE = "2026-11-26"; /* el sistema recién arranca mañana: antes de esa fecha no se penaliza */
async function penalizarDia(env, fecha) {
  if (fecha < PENALIZAR_DESDE) return { n: 0, pts: 0, lista: [], plan: 0, hecho: 0, omitido: true };
  const ts = await tareasDesde(env, fecha, fecha);
  const delDia = ts.filter((t) => t.inicio && t.inicio.slice(0, 10) === fecha && !t.evento);
  let n = 0, pts = 0; const lista = [];
  for (const h of Object.keys(HABITOS)) {
    const mias = delDia.filter((t) => t.habilidad === h);
    if (mias.some((t) => t.hecho)) continue;
    const pend = mias.find((t) => !t.pen);
    const min = (pend && pend.min != null ? pend.min : HABITOS[h]), perdidos = min * 3;
    try {
      if (pend) await notion(env, "pages/" + pend.id, "PATCH", { properties: { "Penalizado": { checkbox: true }, "Puntos perdidos": { number: perdidos } } });
      else if (!mias.length) await notion(env, "pages", "POST", { parent: { database_id: DB }, properties: Object.assign(propsDe({ nombre: NOMBRE_HABITO[h], habilidad: h, min: min, inicio: fecha, fin: fecha, estado: "Pendientes", perdidos: perdidos }), { "Penalizado": { checkbox: true } }) });
      else continue;
      n++; pts += perdidos; lista.push(NOMBRE_HABITO[h]);
    } catch (e) {}
  }
  const t = delDia.filter((x) => !x.pen && !HABITOS[x.habilidad] && /Estudios|Trabajo/.test(x.habilidad));
  const plan = t.reduce((a, x) => a + (x.min || 0), 0), hecho = t.filter((x) => x.hecho).reduce((a, x) => a + (x.min || 0), 0);
  return { n, pts, lista, plan, hecho };
}

/* Cada mañana deja creados los hábitos de hoy y de los 2 días siguientes (los que falten) */
async function asegurarHabitos(env, desdeFecha, dias) {
  let creados = 0;
  for (let i = 0; i < dias; i++) {
    const d = sumarDias(desdeFecha, i);
    const ts = (await tareasDesde(env, d, d)).filter((t) => t.inicio && t.inicio.slice(0, 10) === d);
    const ocupado = [];
    ts.forEach((t) => { if (t.inicio.length > 10 && t.fin && t.fin.length > 10) ocupado.push([mm(t.inicio.slice(11, 16)), mm(t.fin.slice(11, 16))]); });
    for (const h of Object.keys(HABITOS)) {
      if (ts.some((t) => t.habilidad === h)) continue;
      const dur = HABITOS[h];
      for (let t = 7 * 60; t + dur <= 23 * 60 + 30; t += 5) {
        if (ocupado.every((o) => t + dur <= o[0] || t >= o[1])) {
          await notion(env, "pages", "POST", { parent: { database_id: DB }, properties: propsDe({ nombre: NOMBRE_HABITO[h], habilidad: h, min: dur, inicio: d + "T" + hh(t), fin: d + "T" + hh(t + dur), estado: "Pendientes" }) });
          ocupado.push([t, t + dur]); creados++; break;
        }
      }
    }
  }
  return creados;
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
  const sueno = {};
  ts.forEach((t) => { if (t.habilidad === "Sueño" && t.hecho && t.min > 0 && t.inicio) { const d = t.inicio.slice(0, 10); sueno[d] = (sueno[d] || 0) + t.min; } });
  const sd = Object.keys(sueno).sort(), hs = (m) => Math.round(m / 6) / 10 + " h";
  let lineaSueno = "";
  if (sd.length) {
    const prom = sd.reduce((a, d) => a + sueno[d], 0) / sd.length, mas = sd.reduce((a, d) => (sueno[d] > sueno[a] ? d : a)), menos = sd.reduce((a, d) => (sueno[d] < sueno[a] ? d : a));
    lineaSueno = "\n😴 Sueño: promedio " + hs(prom) + " por día (" + sd.length + " días registrados). Más dormiste: " + mas.slice(5) + " con " + hs(sueno[mas]) + ". Menos dormiste: " + menos.slice(5) + " con " + hs(sueno[menos]) + ".";
  }
  const totXP = Object.values(xp).reduce((a, b) => a + b, 0), totP = Object.values(perdidos).reduce((a, b) => a + b, 0);
  const datos = { desde, hasta: hoy, xp_ganado_aprox_por_habilidad: xp, total_xp: totXP, puntos_perdidos_por_habilidad: perdidos, total_puntos_perdidos: totP, tareas_no_hechas: tareasPerdidas.slice(0, 25), min_hechos_por_dia: resumen(ts, hoy) };
  let analisis = "";
  try {
    const r = await gemini(env, [{ text: "Sos el agente de Manu (rioplatense, directo). Escribí el resumen semanal en texto plano, sin markdown, máx 12 líneas: cuánto XP ganó, cuántos puntos perdió, en qué habilidad más, qué tareas no hizo, un diagnóstico honesto (¿se dedicó a lo importante? ¿hubo parciales esta semana? Cálculo y Organizaciones 24/11, Informática 27/11, Física 30/11) y 2 cosas concretas para mejorar la próxima semana. No inventes. Datos: " + JSON.stringify(datos) + '\nRespondé JSON: {"respuesta":""}' }]);
    analisis = r.respuesta || "";
  } catch (e) {}
  if (!analisis) analisis = "XP ganado: " + totXP + ". Puntos perdidos: " + totP + ". No hechas: " + (tareasPerdidas.join(", ") || "ninguna") + ".";
  return "📊 Resumen de la semana (" + desde + " a " + hoy + ")\nXP ganado: " + totXP + " · Puntos perdidos: " + totP + lineaSueno + "\n\n" + analisis;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.ALLOWED_CHAT_ID) return;
    ctx.waitUntil((async () => {
      try {
        if (event.cron === "59 2 * * *") {
          const r = await penalizarDia(env, fechaAR(new Date(Date.now() - 10 * 60e3)));
          if (r.omitido) return;
          let m = "⏰ Cierre del día: ";
          m += r.n ? "hábitos sin cumplir: " + r.lista.join(", ") + " (" + r.pts + " puntos perdidos)." : "cumpliste todos tus hábitos, sin penalización.";
          if (r.plan) m += "\nEstudio y trabajo: hiciste " + Math.round(r.hecho / 6) / 10 + " h de " + Math.round(r.plan / 6) / 10 + " h planificadas (esto no penaliza).";
          await decir(env, env.ALLOWED_CHAT_ID, m);
        } else if (event.cron === "0 9 * * *") {
          await asegurarHabitos(env, fechaAR(new Date()), 3);
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
    if (url.pathname.startsWith("/test/")) {
      if (url.searchParams.get("s") !== env.WEBHOOK_SECRET) return new Response("no", { status: 403 });
      const hoy = fechaAR(new Date()); let out;
      try {
        if (url.pathname === "/test/habitos") out = { habitos_creados: await asegurarHabitos(env, hoy, 3) };
        else if (url.pathname === "/test/resumen") { const t = await resumenSemanal(env); await decir(env, env.ALLOWED_CHAT_ID, t); out = { enviado_a_telegram: true }; }
        else if (url.pathname === "/test/cierre") out = Object.assign({ aviso: "prueba: antes del " + PENALIZAR_DESDE + " no penaliza nada" }, await penalizarDia(env, hoy));
        else out = { error: "usá /test/habitos, /test/resumen o /test/cierre" };
      } catch (e) { out = { error: e.message }; }
      return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json; charset=utf-8" } });
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
