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
const MODELOS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest"];
const TZ = "-03:00";

/* ---------- tiempo (Argentina, UTC-3 fijo) ---------- */
const ar = (d) => new Date((d || new Date()).getTime() - 3 * 3600e3);
const pad = (n) => String(n).padStart(2, "0");
const fechaAR = (d) => { const a = ar(d); return a.getUTCFullYear() + "-" + pad(a.getUTCMonth() + 1) + "-" + pad(a.getUTCDate()); };
const horaAR = (d) => { const a = ar(d); return pad(a.getUTCHours()) + ":" + pad(a.getUTCMinutes()); };
const sumarDias = (f, n) => { const d = new Date(f + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/* Día lógico de Manu: su día sigue hasta que se duerme; entre las 00:00 y las 05:00 "hoy" sigue siendo el día anterior. */
const HORA_CORTE = 5;
const fechaLogica = (d) => { const a = ar(d); return a.getUTCHours() < HORA_CORTE ? sumarDias(fechaAR(d), -1) : fechaAR(d); };
const diaDe = (t) => (t.inicio && t.inicio.length > 10 ? fechaLogica(new Date(Date.parse(t.inicio))) : (t.inicio || "").slice(0, 10));
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
const aISO = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 16) + ":00" + TZ;
function fechaNotion(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.length === 16 ? s + ":00" + TZ : s; }
function propsDe(a) {
  const p = {};
  if (a.nombre) p["Nombre"] = { title: [{ text: { content: String(a.nombre).slice(0, 200) } }] };
  if (a.habilidad !== undefined) p["Habilidad"] = { relation: a.habilidad && HAB[a.habilidad] ? [{ id: HAB[a.habilidad] }] : [] };
  if (a.min != null && !isNaN(+a.min)) p["Duración (min)"] = { number: Math.max(0, Math.round(+a.min)) };
  if (a.inicio) p["Fecha Inicio"] = { date: { start: fechaNotion(a.inicio) } };
  if (a.fin) p["Fecha Fin"] = { date: { start: fechaNotion(a.fin) } };
  if (a.estado) { p["Estado"] = { status: { name: a.estado } }; p["Completado"] = { checkbox: a.estado === "Hecho" }; }
  if (a.penalizado != null) p["Penalizado"] = { checkbox: !!a.penalizado };
  if (a.perdidos != null) p["Puntos perdidos"] = { number: Math.max(0, Math.round(+a.perdidos)) };
  if (a.nota != null) p["Descripción"] = { rich_text: a.nota ? [{ text: { content: String(a.nota).slice(-1900) } }] : [] };
  if (a.evento != null) p["Es evento"] = { checkbox: !!a.evento };
  return p;
}

/* ======================= MOTOR DE AGENDA =======================
   Gemini solo ENTIENDE el mensaje (qué hizo, qué hace ahora, qué sigue, qué es fijo).
   Todas las horas y el orden del día los calcula este código, siempre igual. */
const M = 60e3;
const mm = (x) => parseInt(x.slice(0, 2), 10) * 60 + parseInt(x.slice(3, 5), 10);
const hh = (m) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const ms = (iso) => Date.parse(iso);
const conHora = (t) => !!(t.inicio && t.inicio.length > 10 && t.fin && t.fin.length > 10);
const r5 = (x) => Math.ceil(x / (5 * M)) * 5 * M;
const hm = (x) => horaAR(new Date(x));
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
/* "HH:MM" del día lógico -> ms (las horas antes de las 05:00 son de la madrugada siguiente) */
const enHora = (dia, hhmm) => {
  const m = String(hhmm || "").match(/^(\d{1,2})(?::(\d{2}))?/); if (!m) return NaN;
  const h = +m[1], mi = +(m[2] || 0), f = h < HORA_CORTE ? sumarDias(dia, 1) : dia;
  return Date.parse(f + "T" + pad(h) + ":" + pad(mi) + ":00" + TZ);
};
const SIN_HAB = /desayuno|almuerzo|merienda|cena|comida|traslado|colectivo|bondi|viaje|tiempo muerto|sin registrar|pausa|descanso|ducha|social|caf[eé]|amig|primo|familia|novia|salida|juntada|compras|tr[aá]mite|super|mandado/i;
const REGLAS_HAB = [
  [/sue[ñn]o|siesta|dorm/i, "Sueño"], [/medit/i, "Espiritual"], [/inversi|finanz/i, "Finanzas"],
  [/marca personal|linkedin/i, "Marca Personal"], [/lectura|leer|le[ií]|libro/i, "Lectura"],
  [/ejercicio|gimnasio|gym|correr|bici|entren/i, "Ejercicio"],
  [/whatsapp|consultas\b|historias|video|cliente|carrusel|agencia|venta|contenido|seguimiento|negocio|trabaj/i, "Trabajo"],
  [/estudi|m[oó]dulo|cursada|clase|consulta|parcial|f[ií]sica|inform[aá]tica|c[aá]lculo|facultad|repaso/i, "Estudios"]
];
function habDe(nombre, hab) {
  if (HAB[hab]) return hab;
  if (SIN_HAB.test(nombre || "")) return "";
  for (const [re, h] of REGLAS_HAB) if (re.test(nombre || "")) return h;
  return "";
}
const CATEGORIA = (n) => /social|caf[eé]|amig|primo|familia|novia|salida|juntada/i.test(n) ? "Social" : /tiempo muerto/i.test(n) ? "Tiempo muerto" : /sin registrar/i.test(n) ? "Sin registrar" : /compras|tr[aá]mite|super|mandado/i.test(n) ? "Compras y trámites" : /traslado|colectivo|bondi|viaje/i.test(n) ? "Traslados" : /desayuno|almuerzo|merienda|cena|comida/i.test(n) ? "Comidas" : null;
const MATERIA = /f[ií]sica|inform[aá]tica|c[aá]lculo|organizaci|ingenier|qu[ií]mica|algebra|álgebra|dibujo/i;
const COMIDA = { desayuno: 0, almuerzo: 12 * 60 + 30, merienda: 17 * 60, cena: 20 * 60 + 30 };
const comidaDe = (n) => { const k = Object.keys(COMIDA).find((c) => norm(n).includes(c)); return k || null; };
const esHabito = (t) => Object.values(NOMBRE_HABITO).some((n) => norm(n) === norm(t.nombre)) || (t.habilidad && t.habilidad !== "Estudios" && t.habilidad !== "Trabajo" && t.habilidad !== "Sueño" && !!HABITOS[t.habilidad]);
const FIJO_NOMBRE = /^(cursada|clase|consulta|parcial|examen|turno|reuni[oó]n|traslado|sue[ñn]o|colectivo|viaje|m[eé]dico|dentista)/i;
const durDefecto = (nombre, hab) => comidaDe(nombre) ? (comidaDe(nombre) === "merienda" ? 20 : comidaDe(nombre) === "desayuno" ? 30 : 40) : hab === "Estudios" ? 50 : hab === "Trabajo" ? 30 : HABITOS[hab] || 30;
const duracion = (t) => t.min || (conHora(t) ? Math.round((ms(t.fin) - ms(t.inicio)) / M) : 30);
function parecido(t, nombre, hab) {
  const a = norm(t.nombre), b = norm(nombre);
  if (!b) return false;
  if (a === b) return true;
  if (/tiempo muerto|sin registrar/.test(b) || /tiempo muerto|sin registrar/.test(a)) return false;
  const ca = comidaDe(t.nombre), cb = comidaDe(nombre);
  if (ca || cb) return ca === cb;
  const h = habDe(nombre, hab);
  if (!h || t.habilidad !== h) return false;
  const TIPO = /^(consulta|cursada|clase|parcial|examen)/i;
  if (TIPO.test(norm(t.nombre)) !== TIPO.test(b) || (TIPO.test(b) && norm(t.nombre).split(" ")[0] !== b.split(" ")[0])) return false;
  if (h === "Estudios") { const ma = (t.nombre.match(MATERIA) || [""])[0], mb = (nombre.match(MATERIA) || [""])[0]; if (ma && mb) return norm(ma) === norm(mb); }
  return true;
}

/* Contexto de un día: tareas en memoria + cambios a mandar a Notion al final */
async function cargarDia(env, dia) {
  const ts = (await tareasDesde(env, dia, sumarDias(dia, 1))).filter((t) => t.inicio && diaDe(t) === dia);
  return { env, dia, ts, cambios: new Map(), anclados: new Set(), prioridad: [], log: [], quitados: [], sinRegistro: [] };
}
function cambiar(cx, t, a) {
  if (a.inicio) t.inicio = fechaNotion(a.inicio);
  if (a.fin) t.fin = fechaNotion(a.fin);
  if (a.min != null) t.min = a.min;
  if (a.estado) { t.estado = a.estado; t.hecho = a.estado === "Hecho"; }
  if (a.nombre) t.nombre = a.nombre;
  if (a.habilidad !== undefined) t.habilidad = a.habilidad;
  if (a.nota != null) t.desc = a.nota;
  if (a.evento != null) t.evento = !!a.evento;
  if (a.archivar) t.archivado = true;
  const prev = cx.cambios.get(t.id) || {};
  cx.cambios.set(t.id, Object.assign(prev, a));
}
async function crear(cx, a) {
  const t = { id: "nuevo-" + Math.random().toString(36).slice(2), nuevo: true, nombre: a.nombre, habilidad: a.habilidad || "", min: a.min, estado: a.estado || "Pendientes", hecho: a.estado === "Hecho", inicio: fechaNotion(a.inicio), fin: fechaNotion(a.fin), desc: a.nota || "", evento: !!a.evento };
  cx.ts.push(t); cx.cambios.set(t.id, Object.assign({}, a));
  return t;
}
async function guardar(cx) {
  for (const p of cx.porCrear || []) await crear(cx, p);
  cx.porCrear = [];
  for (const [id, a] of cx.cambios) {
    const t = cx.ts.find((x) => x.id === id);
    if (t && t.nuevo) { if (t.archivado) continue; const pg = await notion(cx.env, "pages", "POST", { parent: { database_id: DB }, properties: propsDe(Object.assign({}, a, { inicio: t.inicio, fin: t.fin, min: t.min, estado: t.estado, nombre: t.nombre, habilidad: t.habilidad })) }); t.id = pg.id; t.nuevo = false; continue; }
    if (a.archivar) { await notion(cx.env, "pages/" + id, "PATCH", { archived: true }); continue; }
    const b = Object.assign({}, a); delete b.archivar;
    if (Object.keys(b).length) await notion(cx.env, "pages/" + id, "PATCH", { properties: propsDe(b) });
  }
  cx.cambios.clear();
}
const vivas = (cx) => cx.ts.filter((t) => !t.archivado);

/* Registra algo que YA hizo, con horas reales. Reusa el bloque planificado de lo mismo y saca lo que quedó cubierto. */
async function registrar(cx, it, s, e) {
  const nombre = it.nombre, hab = habDe(nombre, it.habilidad), min = Math.max(1, Math.round((e - s) / M));
  const solapa = (t) => { if (!conHora(t)) return 0; const a = ms(t.inicio), b = ms(t.fin), o = Math.max(0, Math.min(b, e) - Math.max(a, s)); return Math.max(o / Math.max(M, b - a), o / Math.max(M, e - s)); };
  const cerca = (t) => Math.abs((conHora(t) ? ms(t.inicio) : s) - s);
  const cand = vivas(cx).filter((t) => !t.usado && parecido(t, nombre, hab) && (t.estado === "En progreso" || (!t.hecho && (!conHora(t) || ms(t.inicio) < Date.now() + 3 * 3600e3)) || (t.hecho && solapa(t) >= 0.5)))
    .sort((x, y) => ((y.estado === "En progreso") - (x.estado === "En progreso")) || ((y.hecho && solapa(y) >= 0.5) - (x.hecho && solapa(x) >= 0.5)) || (cerca(x) - cerca(y)));
  const a = { inicio: aISO(s), fin: aISO(e), min, estado: "Hecho" };
  if (it.detalle) a.nota = it.detalle;
  let t = cand[0];
  if (t && t.pen) { a.penalizado = false; a.perdidos = 0; t.pen = false; }
  if (t) cambiar(cx, t, a);
  else t = await crear(cx, Object.assign({ nombre, habilidad: hab }, a));
  t.usado = true; cx.anclados.add(t.id);
  vivas(cx).forEach((o) => {
    if (o === t || !conHora(o)) return;
    const f = solapa(o);
    if (/sin registrar/i.test(o.nombre) && f > 0) { cambiar(cx, o, { archivar: true }); return; }
    if (f >= 0.5 && !o.usado && parecido(o, nombre, hab)) cambiar(cx, o, { archivar: true });
  });
  cx.log.push("✅ " + t.nombre + " " + hm(s) + "–" + hm(e) + " (" + min + " min)");
  return t;
}

/* Lista de 'hecho' en orden cronológico -> horas reales (encadena hacia atrás desde 'hasta' o desde ahora) */
async function procesarHecho(cx, items, ahora) {
  const L = (items || []).filter((x) => x && x.nombre);
  if (!L.length) return;
  /* "desayuné hasta 6:30, después informática 20 min": lo que tiene minutos y viene justo después de algo con hora de fin, arranca ahí */
  for (let i = 1; i < L.length; i++) {
    const it = L[i], pr = L[i - 1];
    if (!it.desde && !it.hasta && it.min > 0 && pr.hasta && !(i + 1 < L.length && L[i + 1].desde && enHora(cx.dia, L[i + 1].desde) - enHora(cx.dia, pr.hasta) < it.min * M)) {
      const a = enHora(cx.dia, pr.hasta); it.desde = pr.hasta; it.hasta = hm(a + it.min * M);
    }
  }
  const res = new Array(L.length);
  let cursor = ahora;
  const lista = L.length > 1 && !L.some((x) => x.desde || x.hasta);
  for (let i = L.length - 1; i >= 0; i--) {
    const it = L[i];
    let e = it.hasta ? enHora(cx.dia, it.hasta) : cursor;
    if (!(e <= ahora + 5 * M) && !(it.desde && it.hasta)) e = Math.min(cursor, ahora);
    let s = it.desde ? enHora(cx.dia, it.desde) : NaN;
    if (lista && isNaN(s) && !/tiempo muerto|vueltas|deambul/i.test(it.nombre)) { const d = it.min > 0 ? it.min : durDefecto(it.nombre, habDe(it.nombre, it.habilidad)); s = e - d * M; }
    if (isNaN(s) && it.min > 0 && !it.hasta) {
      /* si lo había arrancado (En progreso), cuenta desde ahí */
      const hab0 = habDe(it.nombre, it.habilidad);
      const pr = vivas(cx).find((t) => t.estado === "En progreso" && parecido(t, it.nombre, hab0) && conHora(t) && ms(t.inicio) + it.min * M <= e);
      if (pr) { s = ms(pr.inicio); e = s + it.min * M; }
    }
    if (isNaN(s) && it.min > 0) s = e - it.min * M;
    if (isNaN(s)) {
      if (/tiempo muerto|vueltas|deambul/i.test(it.nombre)) { res[i] = { it, relleno: true, e }; cursor = e; continue; }
      /* "terminé X" sin minutos: desde que arrancó (En progreso) o desde lo último registrado */
      const hab = habDe(it.nombre, it.habilidad);
      const yaReg = vivas(cx).find((t) => t.hecho && conHora(t) && parecido(t, it.nombre, hab) && e - ms(t.fin) <= 20 * M && e >= ms(t.fin) - M);
      if (yaReg) { yaReg.usado = true; cx.log.push("👍 " + yaReg.nombre + " ya estaba registrado (" + hm(ms(yaReg.inicio)) + "–" + hm(ms(yaReg.fin)) + ")"); continue; }
      const prog = vivas(cx).find((t) => t.estado === "En progreso" && parecido(t, it.nombre, hab) && conHora(t) && ms(t.inicio) < e);
      const plan = vivas(cx).find((t) => !t.hecho && t.estado !== "En progreso" && parecido(t, it.nombre, hab) && t.min > 0);
      const prev = vivas(cx).filter((t) => t.hecho && conHora(t) && ms(t.fin) <= e).sort((a, b) => ms(b.fin) - ms(a.fin))[0];
      if (prog) s = ms(prog.inicio);
      else if (plan && conHora(plan) && ms(plan.inicio) < e && e - ms(plan.inicio) <= 4 * 3600e3) s = Math.max(ms(plan.inicio), prev ? ms(prev.fin) : 0, e - 150 * M);
      else if (plan) s = e - plan.min * M;
      else if (prev && e - ms(prev.fin) <= 4 * 3600e3) s = ms(prev.fin);
      else { cx.log.push("❓ no sé cuánto duró " + it.nombre + ", decime los minutos"); continue; }
    }
    if (/sue[ñn]o|dorm/i.test(it.nombre) && it.desde && it.hasta) { const hs = enHora(cx.dia, it.desde), he = enHora(cx.dia, it.hasta); s = hs; e = he > hs ? he : he + 24 * 3600e3; if (e - s > 16 * 3600e3) e -= 24 * 3600e3; }
    else if (it.desde && it.hasta && !(s < e)) e += 24 * 3600e3;
    if (!(s < e)) continue;
    res[i] = { it, s, e }; cursor = s;
  }
  for (let i = 0; i < res.length; i++) {
    const r = res[i]; if (!r) continue;
    if (r.relleno) {
      const prev = vivas(cx).filter((t) => t.hecho && conHora(t) && ms(t.fin) <= r.e).sort((a, b) => ms(b.fin) - ms(a.fin))[0];
      const s = prev ? ms(prev.fin) : NaN;
      if (s < r.e && r.e - s <= 4 * 3600e3) await registrar(cx, { nombre: "Tiempo muerto", detalle: r.it.detalle }, s, r.e);
      continue;
    }
    await registrar(cx, r.it, r.s, r.e);
  }
}

/* Lo que quedó "En progreso" y ya pasó su hora de fin: se asume hecho como estaba planificado (y se avisa) */
function cerrarViejos(cx, ahora) {
  vivas(cx).forEach((t) => {
    if (t.estado === "En progreso" && conHora(t) && !t.usado && ms(t.fin) < ahora - 10 * M) {
      cambiar(cx, t, { estado: "Hecho" }); t.usado = true;
      cx.log.push("✔️ Asumí que hiciste " + t.nombre + " " + hm(ms(t.inicio)) + "–" + hm(ms(t.fin)) + " (si no, decime)");
    }
  });
}
/* Corrige la duración de algo ya registrado: mantiene la hora de fin y mueve el inicio (o al revés si se pisa) */
function procesarCorregir(cx, items) {
  for (const it of items || []) {
    if (!it || !it.nombre || !(it.min > 0)) continue;
    const hab = habDe(it.nombre, it.habilidad);
    const t = vivas(cx).filter((x) => x.hecho && conHora(x) && parecido(x, it.nombre, hab)).sort((a, b) => ms(b.fin) - ms(a.fin))[0];
    if (!t) { cx.log.push("❓ no encontré " + it.nombre + " para corregir"); continue; }
    let e = ms(t.fin), s = e - it.min * M;
    if (it.desde) { s = enHora(cx.dia, it.desde); e = s + it.min * M; }
    else if (it.hasta) { e = enHora(cx.dia, it.hasta); s = e - it.min * M; }
    cambiar(cx, t, { inicio: aISO(s), fin: aISO(e), min: Math.round(it.min) }); t.usado = true; cx.anclados.add(t.id);
    /* lo que tapa ese tramo (pausas, sin registrar) se va */
    vivas(cx).forEach((o) => { if (o !== t && conHora(o) && o.hecho && /pausa|sin registrar|tiempo muerto/i.test(o.nombre) && ms(o.inicio) >= s && ms(o.fin) <= e) cambiar(cx, o, { archivar: true }); });
    cx.log.push("✏️ " + t.nombre + " corregido: " + hm(s) + "–" + hm(e) + " (" + Math.round(it.min) + " min)");
  }
}
/* "Hago esto y me voy a dormir": cierra el día. Lo flexible pendiente se saca, los hábitos sin hacer quedan pendientes (penalizan) y el sueño va después de lo último. */
function procesarFinDia(cx, ahora, dormirHHMM) {
  const prog = vivas(cx).filter((t) => t.estado === "En progreso" && conHora(t));
  let fin = Math.max(ahora, ...prog.map((t) => ms(t.fin)));
  if (dormirHHMM) { const d = enHora(cx.dia, dormirHHMM); if (!isNaN(d) && d > ahora - 60 * M) fin = d; }
  const sacados = [], sinCumplir = [];
  vivas(cx).forEach((t) => {
    const yaHizo = esHabito(t) && vivas(cx).some((o) => o.hecho && o !== t && (o.habilidad === t.habilidad || norm(o.nombre) === norm(t.nombre)));
    if (yaHizo && !t.hecho) { cambiar(cx, t, { archivar: true, penalizado: false }); return; }
    if (t.pen && !t.hecho && esHabito(t)) { sinCumplir.push(t.nombre); return; }
    if (t.hecho || t.estado === "En progreso" || t.pen) return;
    if (/sue[ñn]o/i.test(t.nombre)) { const dur = duracion(t) || 420; cambiar(cx, t, { inicio: aISO(r5(fin)), fin: aISO(r5(fin) + dur * M) }); return; }
    if (conHora(t) && ms(t.inicio) > fin + 6 * 3600e3) return;
    if (esHabito(t)) { cambiar(cx, t, { inicio: cx.dia, fin: cx.dia, penalizado: true, perdidos: duracion(t) * 3 }); t.pen = true; sinCumplir.push(t.nombre + " (-" + duracion(t) * 3 + ")"); }
    else { cambiar(cx, t, { archivar: true }); sacados.push(t.nombre); }
  });
  cx.cerrado = true;
  cx.log.push("🌙 Cierro el día" + (sacados.length ? ". Saqué lo que no vas a hacer: " + Array.from(new Set(sacados)).join(", ") : "") + (sinCumplir.length ? ". Hábitos sin cumplir hoy (penalizan): " + Array.from(new Set(sinCumplir)).join(", ") : ". Cumpliste todos los hábitos") + ".");
}
/* Borrar bloques que no corresponden (duplicados, cosas mal cargadas) */
function procesarBorrar(cx, items) {
  for (const it of items || []) {
    if (!it || !it.nombre) continue;
    const ref = it.hora ? enHora(cx.dia, it.hora) : null;
    const c = vivas(cx).filter((t) => norm(t.nombre) === norm(it.nombre) || parecido(t, it.nombre, it.habilidad) && (!it.min || t.min === it.min))
      .filter((t) => !it.min || t.min === Math.round(it.min))
      .sort((a, b) => (ref && conHora(a) && conHora(b) ? Math.abs(ms(a.inicio) - ref) - Math.abs(ms(b.inicio) - ref) : 0))[0];
    if (!c) { cx.log.push("❓ no encontré " + it.nombre + " para borrar"); continue; }
    cambiar(cx, c, { archivar: true }); c.usado = true;
    cx.log.push("🗑️ Borré " + c.nombre + (conHora(c) ? " " + hm(ms(c.inicio)) + "–" + hm(ms(c.fin)) : "") + (c.min ? " (" + c.min + " min, ya no suma XP)" : ""));
  }
}
/* Lo que arranca ahora (o en N minutos) */
async function procesarAhora(cx, it, ahora) {
  if (!it || !it.nombre) return;
  const hab = habDe(it.nombre, it.habilidad);
  if (hab === "Estudios" && it.min > 95) { const n = Math.ceil(it.min / 95), c = Math.round(it.min / n); cx.resto = Array.from({ length: n - 1 }, () => Object.assign({}, it, { min: c })); it = Object.assign({}, it, { min: c }); }
  const s = ahora + Math.max(0, +it.en || 0) * M;
  const cand = vivas(cx).filter((t) => !t.hecho && parecido(t, it.nombre, hab)).sort((a, b) => (b.estado === "En progreso") - (a.estado === "En progreso") || Math.abs((conHora(a) ? ms(a.inicio) : s) - s) - Math.abs((conHora(b) ? ms(b.inicio) : s) - s))[0];
  const min = it.min > 0 ? Math.round(it.min) : cand ? duracion(cand) : durDefecto(it.nombre, hab);
  const estado = (+it.en || 0) <= 10 ? "En progreso" : "Pendientes";
  vivas(cx).forEach((t) => { if (t.estado === "En progreso" && t !== cand) cambiar(cx, t, { estado: "Pendientes" }); });
  let t = cand;
  if (t) cambiar(cx, t, { inicio: aISO(s), fin: aISO(s + min * M), min, estado });
  else t = await crear(cx, { nombre: it.nombre, habilidad: hab, inicio: aISO(s), fin: aISO(s + min * M), min, estado });
  t.usado = true; cx.anclados.add(t.id);
  cx.log.push("▶️ " + t.nombre + " " + hm(s) + "–" + hm(s + min * M));
}

/* Lo que sigue, en orden: reusa bloques planificados o crea nuevos */
async function procesarDespues(cx, items, ahora) {
  for (const it of items || []) {
    if (!it || !it.nombre) continue;
    const hab = habDe(it.nombre, it.habilidad);
    if (hab === "Estudios" && it.min > 95) { const n = Math.ceil(it.min / 95), c = Math.round(it.min / n); for (let k = 0; k < n; k++) await procesarDespues(cx, [Object.assign({}, it, { min: c })], ahora); continue; }
    let t = vivas(cx).find((x) => !x.hecho && x.estado !== "En progreso" && !x.usado && !cx.anclados.has(x.id) && parecido(x, it.nombre, hab));
    const min = it.min > 0 ? Math.round(it.min) : t ? duracion(t) : durDefecto(it.nombre, hab);
    if (t) cambiar(cx, t, { min });
    else t = await crear(cx, { nombre: it.nombre, habilidad: hab, inicio: aISO(ahora), fin: aISO(ahora + min * M), min, estado: "Pendientes" });
    t.usado = true; cx.prioridad.push(t.id);
  }
}

async function procesarFijos(cx, items) {
  for (const it of items || []) {
    if (!it || !it.nombre || !it.desde) continue;
    const dia = it.fecha || cx.dia;
    const s = enHora(dia, it.desde), e = it.hasta ? enHora(dia, it.hasta) : s + (it.min || 60) * M;
    if (!(s < e)) continue;
    const hab = habDe(it.nombre, it.habilidad);
    if (dia !== cx.dia) { await notion(cx.env, "pages", "POST", { parent: { database_id: DB }, properties: propsDe({ nombre: it.nombre, habilidad: hab, inicio: aISO(s), fin: aISO(e), min: Math.round((e - s) / M), estado: "Pendientes", evento: true, nota: it.nota || "" }) }); cx.log.push("📌 " + it.nombre + " el " + dia.slice(8) + "/" + dia.slice(5, 7) + " " + hm(s) + "–" + hm(e)); continue; }
    let t = vivas(cx).find((x) => !x.hecho && norm(x.nombre) === norm(it.nombre));
    const a = { inicio: aISO(s), fin: aISO(e), min: Math.round((e - s) / M), evento: true };
    if (it.nota) a.nota = it.nota;
    if (t) cambiar(cx, t, a); else t = await crear(cx, Object.assign({ nombre: it.nombre, habilidad: hab, estado: "Pendientes" }, a));
    cx.anclados.add(t.id);
    cx.log.push("📌 " + it.nombre + " " + hm(s) + "–" + hm(e));
  }
}

function procesarNoHace(cx, nombres) {
  for (const n of nombres || []) {
    const t = vivas(cx).find((x) => !x.hecho && (norm(x.nombre) === norm(n) || parecido(x, n, "")));
    if (!t) continue;
    if (esHabito(t)) { cambiar(cx, t, { inicio: cx.dia, fin: cx.dia, estado: "Pendientes", penalizado: true, perdidos: duracion(t) * 3 }); t.pen = true; cx.log.push("🚫 " + t.nombre + " hoy no: penalizado (-" + duracion(t) * 3 + " puntos)"); }
    else { cambiar(cx, t, { archivar: true }); cx.log.push("🚫 saqué " + t.nombre); }
  }
}

/* Limpieza automática del día: sin duplicados de hábitos, sin bloques de la misma habilidad superpuestos, sin bloques de duración cero */
function sanear(cx) {
  vivas(cx).forEach((t) => { if (conHora(t) && ms(t.fin) <= ms(t.inicio)) { const m = t.min || 10; cambiar(cx, t, { fin: aISO(ms(t.inicio) + m * M) }); } });
  Object.keys(HABITOS).forEach((h) => {
    const del = vivas(cx).filter((t) => t.habilidad === h || norm(t.nombre) === norm(NOMBRE_HABITO[h]));
    const hechos = del.filter((t) => t.hecho), pend = del.filter((t) => !t.hecho && t.estado !== "En progreso");
    if (hechos.length || del.some((t) => t.estado === "En progreso")) pend.forEach((t) => cambiar(cx, t, { archivar: true }));
    else pend.slice(1).forEach((t) => cambiar(cx, t, { archivar: true }));
  });
  const reg = vivas(cx).filter((t) => (t.hecho || t.estado === "En progreso") && t.habilidad && conHora(t)).sort((a, b) => ms(a.inicio) - ms(b.inicio));
  for (let i = 0; i < reg.length; i++) for (let j = i + 1; j < reg.length; j++) {
    const a = reg[i], b = reg[j];
    if (a.archivado || b.archivado || a.habilidad !== b.habilidad) continue;
    const o = Math.min(ms(a.fin), ms(b.fin)) - Math.max(ms(a.inicio), ms(b.inicio));
    if (o <= 0) continue;
    const corto = Math.min(ms(a.fin) - ms(a.inicio), ms(b.fin) - ms(b.inicio));
    const fuera = a.usado && !b.usado ? b : b.usado && !a.usado ? a : b;
    const queda = fuera === a ? b : a;
    if (o >= corto * 0.5) { cambiar(cx, fuera, { archivar: true }); cx.log.push("🧹 Saqué " + fuera.nombre + " " + hm(ms(fuera.inicio)) + "–" + hm(ms(fuera.fin)) + " (se pisaba con " + queda.nombre + ", no cuento dos veces)"); }
    else if (ms(fuera.inicio) < ms(queda.fin) && ms(fuera.inicio) >= ms(queda.inicio)) { const ni = ms(queda.fin); cambiar(cx, fuera, { inicio: aISO(ni), min: Math.max(1, Math.round((ms(fuera.fin) - ni) / M)) }); }
    else { const nf = ms(queda.inicio); cambiar(cx, fuera, { fin: aISO(nf), min: Math.max(1, Math.round((nf - ms(fuera.inicio)) / M)) }); }
  }
}
/* Coloca bloques uno detrás de otro desde 'cursor', esquivando los fijos, sin huecos. */
function colocar(items, ocupado, cursor, limite) {
  const fijos = ocupado.slice(), cola = items.slice(), puestos = [], afuera = [];
  while (cola.length) {
    let i = cola.findIndex((it) => it.comida && it.desde && it.desde <= cursor);
    if (i < 0) i = cola.findIndex((it) => !it.desde || it.desde <= cursor);
    if (i < 0) { const sig = Math.min.apply(null, cola.map((it) => it.desde)); i = cola.findIndex((it) => it.desde === sig); }
    const it = cola.splice(i, 1)[0];
    let x = Math.max(cursor, it.desde || 0), mov = true;
    while (mov) { mov = false; for (const [a, b] of fijos) if (x < b && x + it.dur > a) {
      /* hueco antes de algo fijo: si es estudio o trabajo, lo parto y lleno el hueco */
      const hueco = a - x;
      if (it.partible && x >= a - hueco && hueco >= 25 * M && hueco < it.dur && x >= Math.max(cursor, it.desde || 0)) {
        const resto = Object.assign({}, it, { dur: it.dur - hueco, parte: true });
        cola.unshift(resto); it.dur = hueco; mov = false; break;
      }
      x = b; mov = true; } }
    if (x + it.dur > limite) { afuera.push(it); continue; }
    if (it.parte) { puestos.push([Object.assign({}, it, { nuevo: true }), x, x + it.dur]); fijos.push([x, x + it.dur]); cursor = x + it.dur + 5 * M; continue; }
    puestos.push([it, x, x + it.dur]); fijos.push([x, x + it.dur]);
    cursor = x + it.dur + (it.dur >= 45 && !it.comida ? 5 * M : 0);
  }
  return { puestos, afuera };
}

/* Reordena TODO lo pendiente del día desde ahora: sin superposiciones, sin huecos, respetando lo fijo. */
function reordenar(cx, desdeMs, limiteForzado) {
  const vs = vivas(cx);
  const sue = vs.find((t) => /sue[ñn]o/i.test(t.nombre) && !t.hecho && conHora(t) && ms(t.inicio) > desdeMs);
  const limite = limiteForzado || (sue ? ms(sue.inicio) : enHora(cx.dia, "02:00"));
  const esFija = (t) => t.hecho || t.estado === "En progreso" || t.evento || cx.anclados.has(t.id) || FIJO_NOMBRE.test(t.nombre) || !conHora(t);
  const ocupado = vs.filter((t) => conHora(t) && esFija(t) && !t.hecho && ms(t.fin) > desdeMs).map((t) => [ms(t.inicio), ms(t.fin)])
    .concat(vs.filter((t) => t.hecho && conHora(t) && ms(t.fin) > desdeMs).map((t) => [ms(t.inicio), ms(t.fin)]));
  /* comidas que quedaron muy atrás y nunca se reportaron: ya fueron, se sacan */
  vs.filter((t) => conHora(t) && !esFija(t) && comidaDe(t.nombre) && ms(t.inicio) < desdeMs - 90 * M).forEach((t) => cambiar(cx, t, { archivar: true }));
  const flex = vivas(cx).filter((t) => conHora(t) && !esFija(t));
  const orden = (t) => { const i = cx.prioridad.indexOf(t.id); return i >= 0 ? i - 1000 : ms(t.inicio); };
  flex.sort((a, b) => orden(a) - orden(b));
  const items = flex.map((t) => { const c = comidaDe(t.nombre); return { t, dur: duracion(t) * M, comida: !!c, partible: !c && (t.habilidad === "Estudios" || t.habilidad === "Trabajo") && !FIJO_NOMBRE.test(t.nombre), desde: c && COMIDA[c] ? enHora(cx.dia, hh(COMIDA[c])) : 0 }; });
  let { puestos, afuera } = colocar(items, ocupado, r5(desdeMs), limite);
  /* si no entra todo, primero se caen los bloques flexibles (no los hábitos ni lo que pidió recién) */
  const sacados = [];
  while (afuera.some((it) => esHabito(it.t))) {
    let k = -1;
    for (let j = items.length - 1; j >= 0; j--) { const it = items[j]; if (!esHabito(it.t) && !it.comida && cx.prioridad.indexOf(it.t.id) < 0) { k = j; break; } }
    if (k < 0) break;
    sacados.push(items.splice(k, 1)[0]);
    ({ puestos, afuera } = colocar(items, ocupado, r5(desdeMs), limite));
  }
  afuera = afuera.concat(sacados);
  const partes = puestos.filter((p) => p[0].nuevo); puestos = puestos.filter((p) => !p[0].nuevo);
  puestos.forEach(([it, s, e]) => { if (ms(it.t.inicio) !== s || ms(it.t.fin) !== e) cambiar(cx, it.t, { inicio: aISO(s), fin: aISO(e), min: Math.round((e - s) / M) }); });
  partes.forEach(([it, s, e]) => { cx.porCrear = (cx.porCrear || []).concat([{ nombre: it.t.nombre, habilidad: it.t.habilidad, inicio: aISO(s), fin: aISO(e), min: Math.round((e - s) / M), estado: "Pendientes" }]); });
  /* lo que pidió explícitamente nunca se cae: se pone igual a continuación (hasta las 05:00) */
  const pedidos = afuera.filter((it) => !it.t.relleno && !cx.planificando && (cx.prioridad.indexOf(it.t.id) >= 0 || cx.anclados.has(it.t.id)));
  afuera = afuera.filter((it) => pedidos.indexOf(it) < 0);
  if (pedidos.length) {
    const ult = Math.max(r5(desdeMs), ...puestos.map((p) => p[2]), ...ocupado.filter((o) => o[0] < limite).map((o) => o[1]));
    const extra = colocar(pedidos, ocupado.concat(puestos.map((p) => [p[1], p[2]])), ult, enHora(cx.dia, "04:55"));
    extra.puestos.forEach(([it, a, b]) => { if (ms(it.t.inicio) !== a || ms(it.t.fin) !== b) cambiar(cx, it.t, { inicio: aISO(a), fin: aISO(b) }); });
    afuera = afuera.concat(extra.afuera);
  }
  afuera.forEach((it) => {
    if (it.t.relleno) { cambiar(cx, it.t, { archivar: true }); return; }
    if (!esHabito(it.t) && (it.t.habilidad === "Estudios" || it.t.habilidad === "Trabajo")) {
      cambiar(cx, it.t, { archivar: true }); cx.sinTiempo = cx.sinTiempo || {}; cx.sinTiempo[it.t.nombre] = (cx.sinTiempo[it.t.nombre] || 0) + Math.round(it.dur / M); return;
    }
    if (esHabito(it.t)) { cambiar(cx, it.t, { inicio: cx.dia, fin: cx.dia }); cx.quitados.push(it.t.nombre + " (no entra en el horario, queda pendiente)"); }
    else { cambiar(cx, it.t, { archivar: true }); cx.quitados.push(it.t.nombre); }
  });
}

/* Huecos de más de 30 min entre lo registrado hasta ahora: se marcan 'Sin registrar' (una sola vez) y se pregunta. */
async function marcarHuecos(cx, ahora) {
  const reg = vivas(cx).filter((t) => conHora(t) && (t.hecho || t.estado === "En progreso") && !/sue[ñn]o/i.test(t.nombre) && ms(t.inicio) < ahora).sort((a, b) => ms(a.inicio) - ms(b.inicio));
  if (!reg.length) return;
  const plan = vivas(cx).filter((t) => conHora(t) && !t.hecho && t.estado !== "En progreso");
  let cur = ms(reg[0].fin);
  const tope = Math.min(ahora, ...vivas(cx).filter((t) => t.estado === "En progreso" && conHora(t)).map((t) => ms(t.inicio)).concat([ahora]));
  const huecos = [];
  for (const t of reg.slice(1)) { const a = ms(t.inicio); if (a - cur > 30 * M) huecos.push([cur, a]); cur = Math.max(cur, ms(t.fin)); }
  if (tope - cur > 30 * M) huecos.push([cur, tope]);
  for (const [a, b] of huecos.filter(([a, b]) => b - a <= 5 * 3600e3)) {
    if (plan.some((t) => FIJO_NOMBRE.test(t.nombre) && ms(t.inicio) < b && ms(t.fin) > a)) continue;
    await crear(cx, { nombre: "Sin registrar", habilidad: "", inicio: aISO(a), fin: aISO(b), min: Math.round((b - a) / M), estado: "Hecho", nota: "Contale al bot qué hiciste y se reemplaza" });
    cx.sinRegistro.push(hm(a) + " a " + hm(b));
  }
}

/* Planificar un día entero (hoy desde ahora, o un día futuro) */
async function planificarDia(env, p, hoy, ahora) {
  const dia = p.fecha && /^\d{4}-\d{2}-\d{2}$/.test(p.fecha) ? p.fecha : hoy;
  const cx = await cargarDia(env, dia);
  cx.planificando = true;
  const desp = enHora(dia, p.despertar || "08:00"), dormir = enHora(dia, p.dormir || "00:00");
  const inicio = dia === hoy ? Math.max(ahora, desp) : desp;
  if (p.fijos) await procesarFijos(cx, p.fijos.map((f) => Object.assign({ fecha: dia }, f)));
  /* lo flexible pendiente viejo se reemplaza por el plan nuevo (los hábitos y lo fijo se conservan) */
  vivas(cx).forEach((t) => { if (!t.hecho && t.estado !== "En progreso" && !t.evento && !cx.anclados.has(t.id) && !FIJO_NOMBRE.test(t.nombre) && !esHabito(t) && conHora(t) && ms(t.inicio) >= inicio - 5 * M) cambiar(cx, t, { archivar: true }); });
  const lista = [];
  const quiere = (n) => !vivas(cx).some((t) => comidaDe(t.nombre) === n && (t.hecho || ms(t.inicio || 0) >= inicio - 60 * M)) && !(p.bloques || []).some((b) => comidaDe(b.nombre) === n);
  if (quiere("desayuno") && inicio <= desp + 30 * M) lista.push({ nombre: "Desayuno", min: 30 });
  const hab = vivas(cx).filter((t) => esHabito(t) && !t.hecho && t.estado !== "En progreso");
  const yaHecho = (h) => vivas(cx).some((t) => t.hecho && t.habilidad === h);
  const habFaltan = Object.keys(HABITOS).filter((h) => h !== "Ejercicio" && !yaHecho(h) && !hab.some((t) => t.habilidad === h) && !(p.bloques || []).some((b) => habDe(b.nombre, b.habilidad) === h) && !(p.sin || []).some((n) => norm(n) === norm(NOMBRE_HABITO[h])));
  if (habFaltan.indexOf("Espiritual") >= 0) lista.push({ nombre: "Meditar", habilidad: "Espiritual", min: 7 });
  (p.bloques || []).forEach((b) => {
    const hb = habDe(b.nombre, b.habilidad);
    if (HABITOS[hb] && vivas(cx).some((t) => t.habilidad === hb && (t.hecho || !t.archivado))) return;
    const h = hb, total = Math.max(5, Math.round(+b.min || durDefecto(b.nombre, h)));
    if (h === "Estudios" && total > 95) { let r = total; while (r > 0) { const c = r > 95 ? 50 : r; lista.push({ nombre: b.nombre, habilidad: h, min: c }); r -= c; } }
    else lista.push({ nombre: b.nombre, habilidad: h, min: total });
  });
  if (quiere("almuerzo") && dormir > enHora(dia, "13:00")) lista.push({ nombre: "Almuerzo", min: 40 });
  if (quiere("cena") && dormir > enHora(dia, "21:00")) lista.push({ nombre: "Cena", min: 40 });
  habFaltan.filter((h) => h !== "Espiritual").forEach((h) => lista.push({ nombre: NOMBRE_HABITO[h], habilidad: h, min: HABITOS[h] }));
  /* relleno: más estudio (y un rato de trabajo cada 2 módulos) para usar el día hasta la hora de dormir; lo que no entra se descarta solo */
  const materia = ((p.bloques || []).find((b) => habDe(b.nombre, b.habilidad) === "Estudios") || {}).nombre || "Estudio";
  if (p.rellenar !== false) for (let k = 0; k < 8; k++) { lista.push({ nombre: materia, habilidad: "Estudios", min: 75, relleno: true }); if (k % 2 === 1) lista.push({ nombre: "Trabajo Diario", habilidad: "Trabajo", min: 30, relleno: true }); }
  const nuevos = [];
  for (const b of lista) { const t = await crear(cx, { nombre: b.nombre, habilidad: habDe(b.nombre, b.habilidad), min: b.min, inicio: aISO(inicio), fin: aISO(inicio + b.min * M), estado: "Pendientes" }); if (b.relleno) t.relleno = true; nuevos.push(t); }
  cx.prioridad = nuevos.filter((t) => !t.relleno).map((t) => t.id).concat(hab.map((t) => t.id), nuevos.filter((t) => t.relleno).map((t) => t.id));
  /* comidas ancladas a su horario natural; hábitos al final si no se pidieron en otro lugar */
  const sue = vivas(cx).find((t) => /sue[ñn]o/i.test(t.nombre) && conHora(t));
  if (sue && !sue.hecho) cambiar(cx, sue, { inicio: aISO(dormir), fin: aISO(dormir + 420 * M), min: 420 });
  sanear(cx);
  reordenar(cx, inicio, dormir);
  await guardar(cx);
  return cx;
}

/* Estadísticas de los últimos días (para responder "cuánto llevo", promedios, etc.) */
async function estadisticas(env, hoy, dias) {
  const ts = await tareasDesde(env, sumarDias(hoy, -dias), sumarDias(hoy, 1));
  const por = {};
  ts.filter((t) => t.hecho && t.inicio).forEach((t) => {
    const d = diaDe(t); if (d < sumarDias(hoy, -dias + 1) || d > hoy) return;
    const k = t.habilidad || CATEGORIA(t.nombre) || "Otros";
    por[d] = por[d] || {}; por[d][k] = (por[d][k] || 0) + (t.min || 0);
  });
  const diasReg = Object.keys(por).sort(), tot = {};
  diasReg.forEach((d) => Object.keys(por[d]).forEach((k) => (tot[k] = (tot[k] || 0) + por[d][k])));
  const prom = {}; Object.keys(tot).forEach((k) => (prom[k] = Math.round(tot[k] / Math.max(1, diasReg.length))));
  return { dias_con_registro: diasReg, minutos_por_dia: por, total_minutos: tot, promedio_minutos_por_dia_registrado: prom };
}
/* Resumen del día para Telegram y para el prompt */
function totalesDe(ts) {
  const out = {};
  ts.filter((t) => t.hecho && !t.archivado).forEach((t) => { const k = t.habilidad || "Sin habilidad"; out[k] = (out[k] || 0) + (t.min || 0); });
  return out;
}
function agendaTexto(cx, desdeMs, max) {
  const fut = vivas(cx).filter((t) => conHora(t) && !t.hecho && ms(t.fin) > desdeMs).sort((a, b) => ms(a.inicio) - ms(b.inicio)).slice(0, max || 8);
  return fut.map((t) => (t.estado === "En progreso" ? "▶️ " : "") + hm(ms(t.inicio)) + "–" + hm(ms(t.fin)) + " " + t.nombre).join("\n");
}

function prompt(hoy, ahora, tareasHoy, totales, texto, hayAudio, fechaReal, proximas, ayerT, stats) {
  const comp = (t) => ({ id: t.id, n: t.nombre, h: t.habilidad, min: t.min, est: t.estado, ini: t.inicio && t.inicio.length > 10 ? horaAR(new Date(ms(t.inicio))) : "sin hora", fin: t.fin && t.fin.length > 10 ? horaAR(new Date(ms(t.fin))) : "" });
  return [
    "Sos el agente de agenda de Manu (estudiante y emprendedor en Argentina, habla rioplatense). Tu ÚNICO trabajo es ENTENDER su mensaje y devolverlo estructurado en JSON. NO calcules horarios ni reordenes nada: eso lo hace el sistema con tus datos. Respondé SOLO JSON.",
    "HOY (día lógico; dura hasta que se duerme, corte 05:00): " + hoy + " (" + diaSemana(hoy) + "). AHORA: " + ahora + " (calendario real " + fechaReal + "). 'Mañana' = " + sumarDias(hoy, 1) + ".",
    hayAudio ? "El mensaje es el AUDIO adjunto: transcribilo en 'transcripcion' (limpio, sin muletillas)." : "MENSAJE: " + texto,
    "AGENDA DE HOY (n=nombre, h=habilidad, est=estado, ini/fin en hora argentina): " + JSON.stringify(tareasHoy.map(comp)),
    "AYER (" + sumarDias(hoy, -1) + "): " + JSON.stringify((ayerT || []).map((t) => ({ n: t.nombre, est: t.estado, pen: !!t.pen, min: t.min, ini: t.inicio && t.inicio.length > 10 ? horaAR(new Date(ms(t.inicio))) : "sin hora" }))),
    "FECHAS: lo que pasó HOY va SIN fecha. Solo poné fecha cuando dice explícitamente 'ayer', 'el viernes', etc. Nunca mezcles: si corrige que algo era de otro día, ponelo en borrar (del día equivocado, con su fecha) y en hecho (del día correcto). 'Me quedo hasta la 1 o 2' -> dormir:'01:30'. Para planificar el resto del día poné planificar con bloques y dormir; el sistema rellena el tiempo libre con más estudio y algo de trabajo.",
    "OTROS DÍAS: si cuenta algo de ayer u otro día ('ayer leí a la mañana', 'lo de física de ayer sí lo estudié'), ponelo en hecho o corregir con fecha:'AAAA-MM-DD' de ESE día. Si un hábito quedó penalizado pero dice que sí lo hizo, va en hecho con esa fecha (el sistema le saca la penalización).",
    "SOCIAL Y OTROS (sin habilidad, se miden igual): cafés, salidas, amigos, familia -> nombre 'Social: <detalle corto>' (ej. 'Social: café con mi primo'); compras o trámites -> 'Compras'; viajes -> 'Traslado a X'. NO uses 'Tiempo muerto' para lo social ni para compras: tiempo muerto es solo dar vueltas sin hacer nada. Nunca pongas compras como trabajo.",
    "HASTA QUÉ HORA: si dice hasta qué hora se queda ('me quedo hasta las 2'), poné dormir:'02:00' (sin fin_del_dia). Si da un total de estudio en módulos ('dos módulos, 2 horas y media'), poné un ítem por módulo con sus minutos (75 y 75). 'Otros módulos más' sin cantidad: agregá módulos de 50-75 min hasta la hora que dijo.",
    "SUEÑO: siempre registralo cuando lo cuente, es clave para medir. 'me acosté 22:40 y me levanté 5:45' -> hecho {nombre:'Sueño', habilidad:'Sueño', desde:'22:40', hasta:'05:45', fecha: el día en que se acostó (si se acostó después de medianoche, igual es el día anterior)}. 'me levanté a las 5:45' sin decir cuándo se acostó: preguntalo en respuesta.",
    "ESTADÍSTICAS DE LOS ÚLTIMOS 7 DÍAS (minutos hechos por día y por habilidad o categoría; promedios sobre los días con registro): " + JSON.stringify(stats || {}),
    "PREGUNTAS DE DATOS ('cuánto estudié esta semana', 'promedio por día', 'cuánto dormí', 'cuánto tiempo social'): respondé SIEMPRE con estos números, pasados a horas y minutos, aclarando cuántos días tienen registro. Nunca digas que no tenés los registros si están acá.",
    "MINUTOS HECHOS HOY POR HABILIDAD: " + JSON.stringify(totales),
    "PRÓXIMOS DÍAS (parciales, consultas, etc.): " + JSON.stringify((proximas || []).filter((t) => t.evento || /parcial|consulta|cursada|examen/i.test(t.nombre)).slice(0, 15).map((t) => ({ n: t.nombre, dia: (t.inicio || "").slice(0, 10), ini: t.inicio && t.inicio.length > 10 ? horaAR(new Date(ms(t.inicio))) : "" }))),
    "HABILIDADES: Estudios (facultad, módulos, consultas de materias, cursada), Trabajo (negocio, agencia, WhatsApp, historias, videos, clientes, ventas), Lectura, Espiritual (meditar), Finanzas (estudiar inversiones), Marca Personal, Ejercicio (gimnasio, bici, correr), Sueño (dormir, siesta). Comidas, traslados y tiempo muerto van SIN habilidad (\"\").",
    "NOMBRES: estudio = 'Estudio <Materia>' (ej. 'Estudio Informática'); trabajo genérico = 'Trabajo Diario', o el nombre concreto si lo dice ('Programar historias'); hábitos: 'Meditar', 'Lectura', 'Estudiar Inversiones', 'Marca Personal', 'Ejercicio'; comidas: 'Desayuno','Almuerzo','Merienda','Cena'; 'Traslado a X'; 'Tiempo muerto' para cuando dice que estuvo dando vueltas, deambulando o sin hacer nada; 'Siesta' (Sueño). Si se refiere a una tarea de la agenda, usá su mismo nombre.",
    "CAMPOS (todos opcionales):",
    "- hecho: lo que YA hizo (verbo en pasado: 'terminé', 'estuve', 'hice', 'recién termino'), en ORDEN CRONOLÓGICO, un ítem por actividad: {nombre, habilidad, min, desde, hasta, detalle}. min = minutos que dijo (1 hora y cuarto = 75). desde/hasta = horas 'HH:MM' SOLO si las dijo ('de 9 a 10:30' -> desde '09:00', hasta '10:30'; '(ahora)' o 'recién' en el último = no pongas hasta). Si dice 'terminé X' sin minutos ni horas, dejá min en null (el sistema usa desde cuándo arrancó). Si dice que en el medio estuvo dando vueltas sin decir cuánto, agregá {nombre:'Tiempo muerto'} en su lugar del orden, sin min. detalle = lo que dijo, literal y breve (ej. 'programé historias, contesté consultas, cálculos de ventas').",
    "- Si enumera varias cosas que hizo hasta ahora sin horas ('hice así: módulo de 1h15, cené, módulo de 1h30, recién termino'), ponelas en hecho en ese orden con sus minutos y SIN desde/hasta: el sistema las encadena hacia atrás desde ahora, así quedan bien en la línea de tiempo.",
    "- ahora: lo que empieza ahora o en unos minutos: {nombre, habilidad, min, en}. en = minutos hasta que arranca ('en 5' -> 5, 'descanso 5 y vuelvo' -> 5, 'ya arranqué' -> 0). min = duración si la dijo ('de 1 hora y cuarto' -> 75), si no null.",
    "- 'Ahora hago X y en N minutos Y' o 'después, en N minutos, Y' = X dura N minutos (ahora.min = N) y Y va en despues.",
    "- despues: lo que dice que hace después, EN ORDEN: [{nombre, habilidad, min}]. 'estudiar informática full' -> [{nombre:'Estudio Informática', min:null}].",
    "- fijos: cosas con hora fija nuevas o cambiadas: [{nombre, habilidad, fecha (AAAA-MM-DD, por defecto hoy), desde 'HH:MM', hasta 'HH:MM' o min, nota}]. Ej. 'me voy al gimnasio a las 11:30' -> {nombre:'Ejercicio', habilidad:'Ejercicio', desde:'11:30', min:90}; 'a las 15:20 salgo para la facu' -> {nombre:'Traslado a la facultad', desde:'15:20', min:40}; 'el lunes tengo parcial de física en el aula 14' -> {nombre:'Parcial Física', fecha:..., desde:'08:00', min:120, nota:'Aula 14'} (si no da la hora, preguntala en respuesta).",
    "- no_hace: nombres de tareas de la agenda de hoy que dice que NO va a hacer hoy (ej. 'no voy al gimnasio' -> ['Ejercicio']).",
    "- planificar: SOLO si pide armar/organizar/planificar un día (o 'reorganizame el día', 'acomodame todo'): {fecha, despertar 'HH:MM' (def. 08:00), dormir 'HH:MM' (def. 00:00), fijos:[...], bloques:[{nombre, habilidad, min}] EN EL ORDEN en que conviene hacerlos, sin, nota, rellenar (true por defecto: el sistema llena el tiempo libre con más estudio y trabajo cada 2 módulos; false si pide un día liviano)}. Pensalo como un planificador experto: priorizá la materia del parcial más cercano; bloques de estudio de 50-95 min intercalados con trabajo; si pide trabajo mínimo, poné solo lo esencial (WhatsApp/consultas 20-30, historias 20, programar videos 30) repartido cada 1-2 horas entre estudio; incluí ejercicio si va al gimnasio (90 min salvo que diga otra cosa, como fijo si da hora); si va a la facultad, traslados de ~40 min (como fijos). NO pongas comidas ni hábitos salvo que dé horas: el sistema los agrega solo. sin = hábitos que dice que no hace ese día. Para 'hoy' planificá solo desde AHORA.",
    "- corregir: si dice que algo YA registrado duró otra cosa ('el módulo era de 75, no de 50'): [{nombre, habilidad, min, desde, hasta}] con los minutos correctos y, si la dice, la hora en que arrancó (desde) o terminó (hasta). NO lo pongas también en hecho.",
    "- Si dice que va a hacer algo que interrumpe lo que está 'En progreso' (ej. 'ahora voy a cenar'), poné eso en 'ahora' y, si lo que estaba en progreso lo terminó o lo cortó, ponelo en hecho sin min (el sistema mide desde que arrancó). 'Después sigo estudiando' -> despues: [{nombre:'Estudio <Materia de lo que venía estudiando>'}].",
    "- fin_del_dia: true si dice que después de lo que hace ahora se va a dormir, que corta por hoy o que no hace nada más ('hago esto y me voy a dormir', 'hasta acá por hoy'). dormir: 'HH:MM' si dice a qué hora se acuesta. El sistema saca lo pendiente y deja los hábitos no hechos para penalizar. Si cuenta que ya comió algo (merienda, cena) ponelo en hecho.",
    "- borrar: bloques que pide sacar porque no corresponden (duplicados, mal cargados, 'las compras no eran trabajo'): [{nombre (como figura en la agenda), fecha si no es hoy, hora 'HH:MM' de inicio aprox., min}]. Si algo estaba mal categorizado, borralo y cargalo bien en hecho (ej. compras -> borrar el 'Trabajo Diario' de esa hora y hecho {nombre:'Compras', desde, hasta}).",
    "- estado: correcciones explícitas que pide ('volvelo a pendientes', 'eso no lo terminé'): [{id, estado:'Pendientes'|'En progreso'|'Hecho'}] con ids de la agenda.",
    "- respuesta: texto corto (1-3 líneas), rioplatense, sin markdown. NO listes horarios (el sistema agrega la agenda). Si pregunta algo (cuánto estudió, qué le queda, dónde era algo), respondé con los datos de arriba; si no está en los datos, decí que no lo tenés.",
    "EJEMPLOS:",
    "'recién termino un módulo de informática. Descanso 5 y vuelvo con otro de 1 hora y cuarto' -> {\"hecho\":[{\"nombre\":\"Estudio Informática\",\"habilidad\":\"Estudios\",\"min\":null}],\"ahora\":{\"nombre\":\"Estudio Informática\",\"habilidad\":\"Estudios\",\"min\":75,\"en\":5}}",
    "'de 9 a 10:30 estudié informática, de 10:30 a 11 deambulando y de 11 a 12:30 (ahora) informática' -> {\"hecho\":[{\"nombre\":\"Estudio Informática\",\"habilidad\":\"Estudios\",\"desde\":\"09:00\",\"hasta\":\"10:30\"},{\"nombre\":\"Tiempo muerto\",\"desde\":\"10:30\",\"hasta\":\"11:00\"},{\"nombre\":\"Estudio Informática\",\"habilidad\":\"Estudios\",\"desde\":\"11:00\"}]}",
    "'recién termino, 35 minutos con el negocio, en el medio estuve dando vueltas. Ahora en 5 estudio física' -> {\"hecho\":[{\"nombre\":\"Tiempo muerto\"},{\"nombre\":\"Trabajo Diario\",\"habilidad\":\"Trabajo\",\"min\":35,\"detalle\":\"negocio\"}],\"ahora\":{\"nombre\":\"Estudio Física\",\"habilidad\":\"Estudios\",\"en\":5}}",
    "'terminé la consulta de física, fueron 90 minutos; vuelvo a casa, media hora, y después media hora de negocio y estudio informática' -> {\"hecho\":[{\"nombre\":\"Consulta Física\",\"habilidad\":\"Estudios\",\"min\":90}],\"ahora\":{\"nombre\":\"Traslado a casa\",\"min\":30,\"en\":0},\"despues\":[{\"nombre\":\"Trabajo Diario\",\"habilidad\":\"Trabajo\",\"min\":30},{\"nombre\":\"Estudio Informática\",\"habilidad\":\"Estudios\"}]}",
    "'ahora almuerzo, a las 15:20 salgo para la facu, consulta de física a las 16, vuelvo y estudio informática full. No voy al gimnasio' -> {\"ahora\":{\"nombre\":\"Almuerzo\",\"min\":30,\"en\":0},\"fijos\":[{\"nombre\":\"Traslado a la facultad\",\"desde\":\"15:20\",\"hasta\":\"16:00\"},{\"nombre\":\"Consulta Física\",\"habilidad\":\"Estudios\",\"desde\":\"16:00\",\"hasta\":\"17:30\"},{\"nombre\":\"Traslado a casa\",\"desde\":\"17:30\",\"min\":40}],\"despues\":[{\"nombre\":\"Estudio Informática\",\"habilidad\":\"Estudios\"}],\"no_hace\":[\"Ejercicio\"]}",
    "'dormí la siesta, media hora' -> {\"hecho\":[{\"nombre\":\"Siesta\",\"habilidad\":\"Sueño\",\"min\":30}]}",
    "FORMATO: {\"transcripcion\":\"\",\"hecho\":[],\"ahora\":null,\"despues\":[],\"fijos\":[],\"no_hace\":[],\"planificar\":null,\"corregir\":[],\"borrar\":[],\"fin_del_dia\":false,\"dormir\":null,\"estado\":[],\"respuesta\":\"\"}"
  ].join("\n");
}

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
async function gemini(env, partes) {
  let ultimo;
  const t0 = Date.now(), PRESUPUESTO = 24000;
  let satur = false;
  for (let ronda = 0; ronda < 3; ronda++) {
  if (ronda) await new Promise((r) => setTimeout(r, 2000 * ronda));
  let saturado = false;
  for (const m of MODELOS) {
    const restante = PRESUPUESTO - (Date.now() - t0);
    if (restante < 3000) { ultimo = ultimo || new Error("Gemini tardó demasiado"); break; }
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), Math.min(m === "gemini-2.5-flash" ? 16000 : 10000, restante));
    try {
      const gc = { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 8192 };
      if (m === "gemini-2.5-flash") gc.thinkingConfig = { thinkingBudget: 1024 }; else if (/2\.5/.test(m)) gc.thinkingConfig = { thinkingBudget: 0 }; else gc.thinkingConfig = { thinkingLevel: "low" };
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent", {
        method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: partes }], generationConfig: gc })
      });
      const txt = await r.text();
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Gemini rechazó la clave"), { fatal: true });
      if (!r.ok) { ultimo = new Error("Gemini " + r.status); if (r.status === 503 || r.status === 429 || r.status >= 500) { saturado = true; satur = true; } continue; }
      const j = JSON.parse(txt), c = j.candidates && j.candidates[0];
      const out = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || "").join("") : "";
      if (!out) { ultimo = new Error("Gemini no respondió"); continue; }
      return parseJSON(out);
    } catch (e) { if (e.fatal) throw e; ultimo = e; } finally { clearTimeout(t); }
  }
  if (!saturado || Date.now() - t0 > PRESUPUESTO - 3000) break;
  }
  const base = ultimo || new Error("Gemini no respondió");
  const msg0 = String(base.message || base);
  const fin = new Error(satur && !/\b(429|5\d\d)\b/.test(msg0) ? "Gemini 503" : /aborted/i.test(msg0) ? "Gemini tardó demasiado" : msg0);
  if (satur || /aborted|tardó/i.test(msg0)) fin.sat = true;
  throw fin;
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
const decir = (env, chat, texto, silencioso) => tg(env, "sendMessage", { chat_id: chat, text: String(texto).slice(0, 4000), disable_notification: !!silencioso });

async function conCloudflareAI(env, mkPrompt, texto, audioB64) {
  let tx = texto, trans = "";
  if (audioB64) {
    const w = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: audioB64, language: "es" });
    trans = (w && w.text ? w.text : "").trim();
    if (!trans) throw new Error("no pude transcribir");
    tx = trans;
  }
  const out = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [{ role: "user", content: mkPrompt(tx, false) }], response_format: { type: "json_object" }, max_tokens: 4000, temperature: 0.2 });
  const raw = out && out.response != null ? out.response : out;
  const r = typeof raw === "string" ? parseJSON(raw) : raw;
  if (trans && !r.transcripcion) r.transcripcion = trans;
  r.respuesta = (r.respuesta || "Listo.") + " (usé el plan B porque Google estaba saturado)";
  return r;
}
async function procesar(env, msg) {
  const chat = msg.chat.id;
  if (!env.ALLOWED_CHAT_ID) { await decir(env, chat, "Tu ID de Telegram es " + chat + ". Cargalo en Cloudflare como ALLOWED_CHAT_ID y volvé a escribirme."); return; }
  if (String(chat) !== String(env.ALLOWED_CHAT_ID)) return;
  const audio = msg.voice || msg.audio;
  const texto = (msg.text || msg.caption || "").trim();
  if (texto === "/start") { await decir(env, chat, "Listo. Contame lo que hiciste, lo que hacés ahora y lo que sigue, o pedime que arme el día."); return; }
  if (!audio && !texto) { await decir(env, chat, "Mandame un audio o un texto."); return; }
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" });
  try {
    /* la hora es la del momento en que mandó el mensaje, aunque se procese después */
    const ahoraMs = Math.min(Date.now(), (msg.date || Date.now() / 1000) * 1000 + 60e3);
    const ahoraD = new Date(ahoraMs), hoy = fechaLogica(ahoraD), ahora = horaAR(ahoraD), fechaReal = fechaAR(ahoraD);
    const cx = await cargarDia(env, hoy);
    const proximas = await tareasDesde(env, sumarDias(hoy, 1), sumarDias(hoy, 10));
    const stats = await estadisticas(env, hoy, 7);
    const ayerT = (await tareasDesde(env, sumarDias(hoy, -1), hoy)).filter((t) => t.inicio && diaDe(t) === sumarDias(hoy, -1) && !/sin registrar/i.test(t.nombre));
    const mkPrompt = (tx, hayAudio) => prompt(hoy, ahora, vivas(cx).filter((t) => !/sin registrar/i.test(t.nombre) || true), totalesDe(cx.ts), tx, hayAudio, fechaReal, proximas, ayerT, stats);
    const partes = [{ text: mkPrompt(texto, !!audio) }];
    let audioB64 = "";
    if (audio) {
      const f = await tg(env, "getFile", { file_id: audio.file_id });
      if (!f.ok) throw new Error("no pude bajar el audio");
      const buf = await (await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_TOKEN + "/" + f.result.file_path)).arrayBuffer();
      audioB64 = b64(buf);
      partes.push({ inlineData: { mimeType: (audio.mime_type || "audio/ogg").replace(/;.*/, ""), data: audioB64 } });
    }
    let r;
    try { r = await gemini(env, partes); }
    catch (e) {
      if (!env.AI || !e.sat) throw e;
      try { r = await conCloudflareAI(env, mkPrompt, texto, audioB64); } catch (e2) { throw e; }
    }
    r = r || {};
    let out = "";
    if (audio && r.transcripcion) out += "🎙️ " + r.transcripcion + "\n\n";
    if (r.respuesta) out += r.respuesta + "\n";

    let cxFinal = cx, planOtroDia = null;
    if (r.planificar && (!r.planificar.fecha || r.planificar.fecha === hoy)) {
      /* primero registra lo hecho, después arma el resto de hoy */
      await procesarHecho(cx, r.hecho, ahoraMs);
      cerrarViejos(cx, ahoraMs);
      await procesarAhora(cx, r.ahora, ahoraMs);
      await marcarHuecos(cx, ahoraMs);
      await guardar(cx);
      const desde = Math.max(ahoraMs, ...vivas(cx).filter((t) => t.estado === "En progreso" && conHora(t)).map((t) => ms(t.fin)));
      cxFinal = await planificarDia(env, Object.assign({}, r.planificar, { fecha: hoy }), hoy, desde);
      cxFinal.log = cx.log.concat(cxFinal.log);
    } else {
      /* lo que cuenta de otro día (ayer, anteayer): se registra en ese día */
      const deOtro = (x) => x && x.fecha && /^\d{4}-\d{2}-\d{2}$/.test(x.fecha) && x.fecha !== hoy;
      const otros = {};
      ["hecho", "corregir", "borrar"].forEach((k) => (r[k] || []).filter(deOtro).forEach((x) => { (otros[x.fecha] = otros[x.fecha] || { hecho: [], corregir: [], borrar: [] })[k].push(x); }));
      r.hecho = (r.hecho || []).filter((x) => !deOtro(x)); r.corregir = (r.corregir || []).filter((x) => !deOtro(x)); r.borrar = (r.borrar || []).filter((x) => !deOtro(x));
      for (const f of Object.keys(otros)) {
        const c2 = await cargarDia(env, f);
        procesarBorrar(c2, otros[f].borrar);
        procesarCorregir(c2, otros[f].corregir);
        await procesarHecho(c2, otros[f].hecho, Math.min(ahoraMs, enHora(f, "04:59") + 24 * 3600e3));
        await guardar(c2);
        if (c2.log.length) cx.log.push("📅 " + diaSemana(f) + " " + f.slice(8) + "/" + f.slice(5, 7) + ":\n" + c2.log.join("\n"));
      }
      procesarBorrar(cx, r.borrar);
      procesarCorregir(cx, r.corregir);
      await procesarHecho(cx, r.hecho, ahoraMs);
      cerrarViejos(cx, ahoraMs);
      await procesarFijos(cx, r.fijos);
      procesarNoHace(cx, r.no_hace);
      await procesarAhora(cx, r.ahora, ahoraMs);
      await procesarDespues(cx, (cx.resto || []).concat(r.despues || []), ahoraMs);
      /* "me quedo hasta las 2": el día se estira hasta esa hora */
      if (r.dormir && !r.fin_del_dia) {
        const d = enHora(hoy, r.dormir);
        if (!isNaN(d) && d > ahoraMs) {
          let sue = vivas(cx).find((t) => /sue[ñn]o/i.test(t.nombre) && !t.hecho);
          if (sue) cambiar(cx, sue, { inicio: aISO(d), fin: aISO(d + 420 * M), min: 420 });
          else await crear(cx, { nombre: "Sueño", habilidad: "Sueño", inicio: aISO(d), fin: aISO(d + 420 * M), min: 420, estado: "Pendientes" });
        }
      }
      for (const c of r.estado || []) {
        const t = vivas(cx).find((x) => x.id === c.id);
        if (t && ["Pendientes", "En progreso", "Hecho"].indexOf(c.estado) >= 0) { cambiar(cx, t, { estado: c.estado }); cx.log.push("↩️ " + t.nombre + " → " + c.estado); }
      }
      if (r.fin_del_dia) procesarFinDia(cx, ahoraMs, r.dormir);
      await marcarHuecos(cx, ahoraMs);
      const finActual = Math.max(ahoraMs, ...vivas(cx).filter((t) => t.estado === "En progreso" && conHora(t)).map((t) => ms(t.fin)));
      sanear(cx);
      if (!cx.cerrado) reordenar(cx, Math.min(finActual, ahoraMs));
      await guardar(cx);
      try { const cy = await cargarDia(env, sumarDias(hoy, -1)); sanear(cy); await guardar(cy); if (cy.log.length) cx.log.push("📅 Ayer: " + cy.log.join(" ")); } catch (e) {}
      if (r.planificar && r.planificar.fecha) planOtroDia = await planificarDia(env, r.planificar, hoy, ahoraMs);
    }

    if (cxFinal.log.length) out += "\n" + cxFinal.log.join("\n") + "\n";
    if (cxFinal.sinTiempo) out += "\n⏳ No entra hoy (queda para mañana): " + Object.keys(cxFinal.sinTiempo).map((k) => k + " " + cxFinal.sinTiempo[k] + " min").join(", ") + "\n";
    if (cxFinal.quitados.length) out += "\n⚠️ No entra hoy: " + cxFinal.quitados.join(", ") + "\n";
    const ag = agendaTexto(cxFinal, ahoraMs, 8);
    if (ag) out += "\n📋 Lo que sigue:\n" + ag + "\n";
    if (planOtroDia) out += "\n🗓️ " + diaSemana(planOtroDia.dia) + " " + planOtroDia.dia.slice(8) + "/" + planOtroDia.dia.slice(5, 7) + ":\n" + agendaTexto(planOtroDia, 0, 30) + "\n";
    if (cx.sinRegistro.length) out += "\n🕳️ No tengo nada de " + cx.sinRegistro.join(", ") + ". ¿Qué hiciste ahí? (lo dejé como 'Sin registrar')";
    await decir(env, chat, out.trim() || "Listo.");
  } catch (e) {
    const edad = Date.now() / 1000 - (msg.date || 0);
    if (e.sat && edad < 20 * 60) {
      if (edad < 90) await decir(env, chat, "Google está saturado. Lo reintento solo en unos minutos, no hace falta que lo mandes de nuevo.");
      return "reintentar";
    }
    await decir(env, chat, "No pude procesarlo: " + e.message + ". Probá de nuevo.");
  }
}

/* ---------- Tareas programadas ---------- */
/* Hábitos diarios que se penalizan si no se hacen: habilidad -> minutos por defecto */
const HABITOS = { "Ejercicio": 90, "Lectura": 30, "Finanzas": 15, "Marca Personal": 30, "Espiritual": 7 };
const NOMBRE_HABITO = { "Ejercicio": "Ejercicio", "Lectura": "Lectura", "Finanzas": "Estudiar Inversiones", "Marca Personal": "Marca Personal", "Espiritual": "Meditar" };
const PENALIZAR_DESDE = "2026-11-26"; /* el sistema recién arranca mañana: antes de esa fecha no se penaliza */
async function penalizarDia(env, fecha) {
  if (fecha < PENALIZAR_DESDE) return { n: 0, pts: 0, lista: [], plan: 0, hecho: 0, omitido: true };
  const ts0 = await tareasDesde(env, fecha, sumarDias(fecha, 1));
  /* lo flexible (estudio, trabajo, comidas, sueño planificado) que quedó pendiente se saca: no se penaliza ni queda colgado */
  for (const t of ts0) if (t.inicio && diaDe(t) === fecha && !t.hecho && t.estado !== "En progreso" && !t.evento && !HABITOS[t.habilidad]) { try { await notion(env, "pages/" + t.id, "PATCH", { archived: true }); t.archivado = true; } catch (e) {} }
  const ts = ts0.filter((t) => !t.archivado);
  const delDia = ts.filter((t) => t.inicio && diaDe(t) === fecha && !t.evento && !/sin registrar|tiempo muerto/i.test(t.nombre));
  let n = 0, pts = 0; const lista = [];
  for (const h of Object.keys(HABITOS)) {
    const mias = delDia.filter((t) => t.habilidad === h);
    const enCurso = mias.find((t) => !t.hecho && t.estado === "En progreso");
    if (enCurso) { try { await notion(env, "pages/" + enCurso.id, "PATCH", { properties: propsDe({ estado: "Hecho" }) }); } catch (e) {} continue; }
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
  const xp = {}, perdidos = {}, tareasPerdidas = [], muerto = {};
  ts.forEach((t) => {
    const h = t.habilidad || "?";
    if (t.hecho && t.habilidad) xp[h] = (xp[h] || 0) + (t.min || 0) * 3;
    const cat = t.hecho && !t.habilidad ? CATEGORIA(t.nombre) : null;
    if (cat) muerto[cat] = (muerto[cat] || 0) + (t.min || 0);
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
  const datos = { desde, hasta: hoy, xp_ganado_aprox_por_habilidad: xp, total_xp: totXP, puntos_perdidos_por_habilidad: perdidos, total_puntos_perdidos: totP, minutos_por_categoria_sin_habilidad: muerto, tareas_no_hechas: tareasPerdidas.slice(0, 25), min_hechos_por_dia: resumen(ts, hoy) };
  let analisis = "";
  try {
    const r = await gemini(env, [{ text: "Sos el agente de Manu (rioplatense, directo). Escribí el resumen semanal en texto plano, sin markdown, máx 12 líneas: cuánto XP ganó, cuántos puntos perdió, en qué habilidad más, qué tareas no hizo, cuánto tiempo dedicó a lo social (cafés, amigos), compras, traslados, comidas, tiempo muerto y sin registrar (en horas, con una línea de lectura honesta), un diagnóstico honesto (¿se dedicó a lo importante? ¿hubo parciales esta semana? Cálculo y Organizaciones 24/11, Informática 27/11, Física 30/11) y 2 cosas concretas para mejorar la próxima semana. No inventes. Datos: " + JSON.stringify(datos) + '\nRespondé JSON: {"respuesta":""}' }]);
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
        if (event.cron === "0 8 * * *" || event.cron === "59 2 * * *") {
          /* 0 8 UTC = 05:00 en Argentina: cierra el día lógico anterior (incluye lo que hizo de madrugada) */
          if (event.cron === "59 2 * * *") return;
          const r = await penalizarDia(env, fechaLogica(new Date(Date.now() - 10 * 60e3)));
          if (r.omitido) return;
          let m = "⏰ Cierre del día: ";
          m += r.n ? "hábitos sin cumplir: " + r.lista.join(", ") + " (" + r.pts + " puntos perdidos)." : "cumpliste todos tus hábitos, sin penalización.";
          if (r.plan) m += "\nEstudio y trabajo: hiciste " + Math.round(r.hecho / 6) / 10 + " h de " + Math.round(r.plan / 6) / 10 + " h planificadas (esto no penaliza).";
          await decir(env, env.ALLOWED_CHAT_ID, m, true);
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
      if (up.message) { const r = await procesar(env, up.message); if (r === "reintentar") return new Response("reintentar", { status: 503 }); }
      return new Response("ok");
    }
    return new Response("Agente de Manu activo.");
  }
};
