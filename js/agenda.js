// Agenda del Día (V3), con datos y estados reales.
// Cada cita vive en pacientes/{dni} (fb-psico) y ahora lleva un campo
// "estado": reservada (por defecto) → atendida (lo marca atencion.js al
// guardar la sesión final) / no_asistio / reprogramada (se marcan aquí).
// Los nombres y áreas salen de las fichas de personal (firebase-config,
// autenticado), pedidos por lotes como en pacientes.js.
import { dbPsico, PACIENTES_COLLECTION, DISPONIBILIDAD_COLLECTION, MODALIDADES, MOTIVOS_INASISTENCIA, registrarHistorialCita } from "./fb-psico.js";
import { auth } from "./firebase-config.js";
import { fetchFichasPorDnis } from "./fichas-cache.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  collectionGroup,
  getDocs,
  doc,
  updateDoc,
  query,
  where,
  orderBy,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const DIA_KEY_POR_GETDAY = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MESES_CORTOS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

// Colores del spec: azul=reservada, gris=atendida, rojo=no asistió,
// naranja=reprogramada.
const ESTADOS = {
  reservada: { label: "Reservada", barra: "bg-secondary", badge: "bg-secondary-fixed text-on-secondary-fixed-variant" },
  atendida: { label: "Atendida", barra: "bg-outline", badge: "bg-surface-container-high text-on-surface-variant" },
  no_asistio: { label: "No Asistió", barra: "bg-error", badge: "bg-error-container text-on-error-container" },
  reprogramada: { label: "Reprogramada", barra: "bg-[#F59E0B]", badge: "bg-orange-100 text-orange-800" }
};

// Estado visual derivado (no se guarda en la base): una cita pendiente cuya
// fecha ya pasó se muestra como vencida hasta que el psicólogo la resuelva
// (atenderla tarde, marcar inasistencia o reprogramarla).
const ESTADO_VENCIDA = {
  label: "Vencida · Sin atender",
  barra: "bg-outline-variant",
  badge: "bg-yellow-100 text-yellow-800"
};

function esPendiente(estadoKey) {
  return estadoKey === "reservada" || estadoKey === "reprogramada";
}

const appointmentsList = document.getElementById("appointments-list");
const statTotal = document.getElementById("stat-total");
const statPendientes = document.getElementById("stat-pendientes");
const statAtendidas = document.getElementById("stat-atendidas");
const statInasistencias = document.getElementById("stat-inasistencias");
const filterHoyBtn = document.getElementById("filter-hoy");
const filterTodasBtn = document.getElementById("filter-todas");

let reservas = []; // [{ dni, data }]
let fichasMap = new Map();
let disponibilidadMap = {};
let intervaloMinutos = 30; // duración de cita; la configura el administrador
let filtroActual = "hoy";

function poblarSelectMotivos(select) {
  MOTIVOS_INASISTENCIA.forEach((texto) => {
    const option = document.createElement("option");
    option.textContent = texto;
    select.appendChild(option);
  });
}

// ---------- Utilidades ----------
function formatearFechaISO(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fechaLabelDe(fecha) {
  return `${DIAS_CORTOS[fecha.getDay()]} ${fecha.getDate()} ${MESES_CORTOS[fecha.getMonth()]}`;
}

function estadoDe(data) {
  return ESTADOS[data.estado] ? data.estado : "reservada";
}

function getInitials(fullName) {
  return fullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

// ---------- Carga de datos ----------
async function fetchReservas() {
  const snap = await getDocs(collection(dbPsico, PACIENTES_COLLECTION));
  const lista = [];
  snap.forEach((d) => lista.push({ dni: d.id, data: d.data() }));
  return lista;
}

async function fetchDisponibilidadMap() {
  const mapa = {};
  const snap = await getDocs(collection(dbPsico, DISPONIBILIDAD_COLLECTION));
  snap.forEach((d) => {
    if (d.id === "config") {
      const minutos = Number(d.data().intervaloMinutos);
      if (minutos >= 10 && minutos <= 120) intervaloMinutos = minutos;
      return;
    }
    mapa[d.id] = d.data().bloques || [];
  });
  return mapa;
}

// ---------- Render de tarjetas (DOM APIs: el DNI viene del formulario público) ----------
function crearTarjetaCita(reserva) {
  const data = reserva.data;
  const estadoKey = estadoDe(data);
  const vencida = esPendiente(estadoKey) && data.fecha && data.fecha < formatearFechaISO(new Date());
  const estado = vencida ? ESTADO_VENCIDA : ESTADOS[estadoKey];
  const ficha = fichasMap.get(reserva.dni) || null;

  const card = document.createElement("div");
  card.className =
    "group bg-surface-container-lowest border border-outline-variant rounded-xl flex overflow-hidden shadow-sm hover:shadow-md transition-shadow" +
    (estadoKey === "no_asistio" ? " opacity-70" : "");

  const barra = document.createElement("div");
  barra.className = "w-2 flex-shrink-0 " + estado.barra;
  card.appendChild(barra);

  const cuerpo = document.createElement("div");
  cuerpo.className = "p-4 sm:p-5 flex-1 flex flex-col md:flex-row md:items-center gap-4";
  card.appendChild(cuerpo);

  // Hora y fecha
  const horario = document.createElement("div");
  horario.className = "flex md:flex-col items-baseline md:items-start gap-2 md:gap-0 md:w-28 flex-shrink-0";
  const horaEl = document.createElement("p");
  horaEl.className = "text-headline-md font-bold " + (estadoKey === "no_asistio" ? "text-on-surface-variant line-through" : "text-primary");
  horaEl.textContent = data.hora || "—";
  const fechaEl = document.createElement("p");
  fechaEl.className = "text-label-md text-on-surface-variant";
  fechaEl.textContent = data.fechaLabel || "—";
  horario.appendChild(horaEl);
  horario.appendChild(fechaEl);

  // Modalidad elegida al reservar (las citas antiguas no la tienen).
  if (data.modalidad && MODALIDADES[data.modalidad]) {
    const modalidadEl = document.createElement("p");
    modalidadEl.className = "text-label-md text-on-surface-variant flex items-center gap-1";
    const modalidadIcon = document.createElement("span");
    modalidadIcon.className = "material-symbols-outlined text-[14px]";
    modalidadIcon.textContent = MODALIDADES[data.modalidad].icon;
    modalidadEl.appendChild(modalidadIcon);
    modalidadEl.appendChild(document.createTextNode(MODALIDADES[data.modalidad].label));
    horario.appendChild(modalidadEl);
  }
  cuerpo.appendChild(horario);

  // Identidad
  const identidad = document.createElement("div");
  identidad.className = "flex items-center gap-4 flex-1 min-w-0";
  const avatar = document.createElement("div");
  avatar.className = "w-11 h-11 flex-shrink-0 rounded-full bg-secondary-fixed flex items-center justify-center text-secondary font-bold";
  avatar.textContent = ficha && ficha.nombre ? getInitials(ficha.nombre) : "?";
  const textos = document.createElement("div");
  textos.className = "min-w-0";
  const nombreEl = document.createElement("h4");
  nombreEl.className = "font-headline-md text-headline-md truncate " + (ficha && ficha.nombre ? "text-primary" : "text-on-surface-variant italic");
  nombreEl.textContent = ficha && ficha.nombre ? ficha.nombre : "Sin ficha de personal";
  const subEl = document.createElement("p");
  subEl.className = "text-body-md text-on-surface-variant truncate";
  subEl.textContent = "DNI: " + reserva.dni + (ficha && ficha.area ? " · " + ficha.area : "");
  textos.appendChild(nombreEl);
  textos.appendChild(subEl);

  // La cita queda bajo el DNI del trabajador; esto avisa que la atención es
  // en realidad para un familiar suyo (dato opcional capturado en la reserva).
  if (data.esParaFamiliar) {
    const familiarEl = document.createElement("p");
    familiarEl.className = "text-label-md font-semibold text-secondary flex items-center gap-1";
    const familiarIcon = document.createElement("span");
    familiarIcon.className = "material-symbols-outlined text-[14px]";
    familiarIcon.textContent = "family_restroom";
    familiarEl.appendChild(familiarIcon);
    const detalle = [data.familiarNombre, data.familiarParentesco].filter(Boolean).join(" — ");
    familiarEl.appendChild(document.createTextNode("Familiar" + (detalle ? ": " + detalle : "")));
    textos.appendChild(familiarEl);
  }

  // Datos de contacto: el celular aplica a toda cita (coordinación y
  // recordatorios); el enlace solo a las de video.
  if (data.telefonoWsp) {
    const contactoEl = document.createElement("a");
    contactoEl.href = "https://wa.me/51" + encodeURIComponent(data.telefonoWsp);
    contactoEl.target = "_blank";
    contactoEl.rel = "noopener";
    contactoEl.className = "text-label-md text-secondary hover:underline flex items-center gap-1";
    const wspIcon = document.createElement("span");
    wspIcon.className = "material-symbols-outlined text-[14px]";
    wspIcon.textContent = "chat";
    contactoEl.appendChild(wspIcon);
    contactoEl.appendChild(document.createTextNode("WhatsApp: " + data.telefonoWsp));
    textos.appendChild(contactoEl);
  }
  if (data.modalidad === "virtual" && data.enlace && /^https?:\/\//i.test(data.enlace)) {
    const enlaceEl = document.createElement("a");
    enlaceEl.href = data.enlace;
    enlaceEl.target = "_blank";
    enlaceEl.rel = "noopener";
    enlaceEl.className = "text-label-md text-secondary hover:underline flex items-center gap-1";
    const linkIcon = document.createElement("span");
    linkIcon.className = "material-symbols-outlined text-[14px]";
    linkIcon.textContent = "link";
    enlaceEl.appendChild(linkIcon);
    enlaceEl.appendChild(document.createTextNode("Abrir enlace de reunión"));
    textos.appendChild(enlaceEl);
  }
  identidad.appendChild(avatar);
  identidad.appendChild(textos);
  cuerpo.appendChild(identidad);

  // Badge de estado
  const badgeWrap = document.createElement("div");
  badgeWrap.className = "flex-shrink-0";
  const badge = document.createElement("span");
  badge.className = "text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider " + estado.badge;
  badge.textContent = estado.label;
  badgeWrap.appendChild(badge);
  cuerpo.appendChild(badgeWrap);

  // Acciones
  const acciones = document.createElement("div");
  acciones.className = "flex gap-2 md:justify-end flex-shrink-0";
  cuerpo.appendChild(acciones);

  const abrirBtn = document.createElement("button");
  abrirBtn.type = "button";
  abrirBtn.title = estadoKey === "atendida" ? "Abrir ficha" : "Iniciar atención";
  abrirBtn.className =
    "p-2 rounded-lg bg-secondary/10 text-secondary hover:bg-secondary hover:text-on-secondary transition-all";
  abrirBtn.innerHTML = '<span class="material-symbols-outlined">' + (estadoKey === "atendida" ? "folder_open" : "play_arrow") + "</span>";
  abrirBtn.addEventListener("click", () => {
    window.location.href = "atencion.html?dni=" + encodeURIComponent(reserva.dni);
  });
  acciones.appendChild(abrirBtn);

  if (estadoKey === "reservada" || estadoKey === "reprogramada") {
    const noAsistioBtn = document.createElement("button");
    noAsistioBtn.type = "button";
    noAsistioBtn.title = "No asistió";
    noAsistioBtn.className =
      "p-2 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-error-container hover:text-on-error-container transition-all";
    noAsistioBtn.innerHTML = '<span class="material-symbols-outlined">person_off</span>';
    noAsistioBtn.addEventListener("click", () => abrirModalNoAsistio(reserva));
    acciones.appendChild(noAsistioBtn);
  }

  if (estadoKey !== "atendida") {
    const reprogramarBtn = document.createElement("button");
    reprogramarBtn.type = "button";
    reprogramarBtn.title = "Reprogramar";
    reprogramarBtn.className =
      "p-2 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-container-high transition-all";
    reprogramarBtn.innerHTML = '<span class="material-symbols-outlined">event_repeat</span>';
    reprogramarBtn.addEventListener("click", () => abrirModalReprogramar(reserva));
    acciones.appendChild(reprogramarBtn);
  }

  return card;
}

function renderLista() {
  const hoyISO = formatearFechaISO(new Date());
  const visibles = reservas
    .filter((r) => filtroActual === "todas" || r.data.fecha === hoyISO)
    .sort((a, b) => `${a.data.fecha || ""}${a.data.hora || ""}`.localeCompare(`${b.data.fecha || ""}${b.data.hora || ""}`));

  appointmentsList.innerHTML = "";

  if (visibles.length === 0) {
    const vacio = document.createElement("p");
    vacio.className = "text-body-md text-on-surface-variant p-4";
    vacio.textContent = filtroActual === "hoy" ? "No hay citas programadas para hoy." : "No hay citas registradas todavía.";
    appointmentsList.appendChild(vacio);
    return;
  }

  visibles.forEach((reserva) => appointmentsList.appendChild(crearTarjetaCita(reserva)));
}

function renderStats() {
  const hoyISO = formatearFechaISO(new Date());
  const conteo = { reservada: 0, atendida: 0, no_asistio: 0, reprogramada: 0 };
  let vencidas = 0;

  reservas.forEach((r) => {
    const estadoKey = estadoDe(r.data);
    conteo[estadoKey]++;
    if (esPendiente(estadoKey) && r.data.fecha && r.data.fecha < hoyISO) vencidas++;
  });

  statTotal.textContent = String(reservas.length);
  statPendientes.textContent = String(conteo.reservada + conteo.reprogramada);
  statAtendidas.textContent = String(conteo.atendida);
  statInasistencias.textContent = String(conteo.no_asistio);

  const detalle = document.getElementById("stat-pendientes-detalle");
  if (vencidas > 0) {
    detalle.textContent = vencidas === 1 ? "1 vencida sin resolver" : vencidas + " vencidas sin resolver";
    detalle.classList.remove("hidden");
  } else {
    detalle.classList.add("hidden");
  }
}

// ---------- Filtro Hoy / Todas ----------
const FILTER_ACTIVE = "px-4 py-1.5 rounded-full bg-secondary text-on-secondary text-label-md font-semibold";
const FILTER_INACTIVE = "px-4 py-1.5 rounded-full bg-surface-container-high text-on-surface-variant text-label-md";

function setFiltro(filtro) {
  filtroActual = filtro;
  filterHoyBtn.className = filtro === "hoy" ? FILTER_ACTIVE : FILTER_INACTIVE;
  filterTodasBtn.className = filtro === "todas" ? FILTER_ACTIVE : FILTER_INACTIVE;
  renderLista();
}

filterHoyBtn.addEventListener("click", () => setFiltro("hoy"));
filterTodasBtn.addEventListener("click", () => setFiltro("todas"));

// ---------- No asistió ----------
const noAsistioModal = document.getElementById("no-asistio-modal");
const noAsistioClose = document.getElementById("no-asistio-close");
const noAsistioPaciente = document.getElementById("no-asistio-paciente");
const noAsistioMotivoSelect = document.getElementById("no-asistio-motivo");
const noAsistioError = document.getElementById("no-asistio-error");
const noAsistioGuardar = document.getElementById("no-asistio-guardar");
poblarSelectMotivos(noAsistioMotivoSelect);

let reservaEnNoAsistio = null;

function abrirModalNoAsistio(reserva) {
  reservaEnNoAsistio = reserva;
  const nombre = (fichasMap.get(reserva.dni) || {}).nombre || "DNI " + reserva.dni;
  noAsistioPaciente.textContent = `${nombre} · cita: ${reserva.data.fechaLabel || "—"}, ${reserva.data.hora || "—"}`;
  noAsistioMotivoSelect.value = "";
  noAsistioError.classList.add("hidden");
  noAsistioModal.classList.remove("hidden");
}

function cerrarModalNoAsistio() {
  noAsistioModal.classList.add("hidden");
  reservaEnNoAsistio = null;
}

noAsistioClose.addEventListener("click", cerrarModalNoAsistio);
noAsistioModal.addEventListener("click", (e) => {
  if (e.target === noAsistioModal) cerrarModalNoAsistio();
});

noAsistioGuardar.addEventListener("click", async () => {
  if (!reservaEnNoAsistio) return;

  const motivo = noAsistioMotivoSelect.value;
  if (!motivo) {
    noAsistioError.textContent = "Elige un motivo.";
    noAsistioError.classList.remove("hidden");
    return;
  }

  const reserva = reservaEnNoAsistio;
  const originalText = noAsistioGuardar.textContent;
  noAsistioGuardar.disabled = true;
  noAsistioGuardar.textContent = "Guardando...";

  try {
    await updateDoc(doc(dbPsico, PACIENTES_COLLECTION, reserva.dni), { estado: "no_asistio", motivo });
    registrarHistorialCita(reserva.dni, {
      estado: "no_asistio",
      fecha: reserva.data.fecha,
      hora: reserva.data.hora,
      modalidad: reserva.data.modalidad,
      motivo,
      esParaFamiliar: !!reserva.data.esParaFamiliar,
      familiarNombre: reserva.data.familiarNombre || null,
      familiarParentesco: reserva.data.familiarParentesco || null
    }).catch((err) => console.warn("No se pudo registrar el historial de la cita:", err));

    reserva.data.estado = "no_asistio";
    reserva.data.motivo = motivo;
    cerrarModalNoAsistio();
    renderLista();
    renderStats();
  } catch (err) {
    console.error("Error al marcar la inasistencia:", err);
    noAsistioError.textContent = "No se pudo guardar el cambio.";
    noAsistioError.classList.remove("hidden");
  } finally {
    noAsistioGuardar.disabled = false;
    noAsistioGuardar.textContent = originalText;
  }
});

// ---------- Reprogramar ----------
const reprogramarModal = document.getElementById("reprogramar-modal");
const reprogramarClose = document.getElementById("reprogramar-close");
const reprogramarPaciente = document.getElementById("reprogramar-paciente");
const reprogramarFecha = document.getElementById("reprogramar-fecha");
const reprogramarHoras = document.getElementById("reprogramar-horas");
const reprogramarMotivoSelect = document.getElementById("reprogramar-motivo");
const reprogramarError = document.getElementById("reprogramar-error");
const reprogramarGuardar = document.getElementById("reprogramar-guardar");
poblarSelectMotivos(reprogramarMotivoSelect);

let reservaEnReprogramacion = null;
let turnoReprogramacion = null; // { hora, modalidad, enlace } del bloque de disponibilidad elegido

// Turnos del día con su modalidad (y enlace, si es video) — mismo criterio
// que index.js (reserva pública): cada bloque de disponibilidad define su
// propia modalidad, así que un mismo día puede tener horas presenciales y
// horas por llamada a la vez.
function generarHorasDelDia(bloques) {
  const horas = new Map();
  bloques
    .filter((b) => b.activo && b.modalidad !== "emergencia")
    .forEach((b) => {
      const [hi, mi] = b.horaInicio.split(":").map(Number);
      const [hf, mf] = b.horaFin.split(":").map(Number);
      let actual = hi * 60 + mi;
      const fin = hf * 60 + mf;
      while (actual < fin) {
        const clave = `${String(Math.floor(actual / 60)).padStart(2, "0")}:${String(actual % 60).padStart(2, "0")}`;
        if (!horas.has(clave)) {
          horas.set(clave, { modalidad: b.modalidad || "presencial", enlace: b.enlace || "" });
        }
        actual += intervaloMinutos;
      }
    });
  return Array.from(horas.entries())
    .map(([hora, info]) => ({ hora, modalidad: info.modalidad, enlace: info.enlace }))
    .sort((a, b) => a.hora.localeCompare(b.hora));
}

function horaOcupada(fechaISO, hora, dniExcluido) {
  return reservas.some((r) => r.dni !== dniExcluido && r.data.fecha === fechaISO && r.data.hora === hora);
}

function abrirModalReprogramar(reserva) {
  reservaEnReprogramacion = reserva;
  turnoReprogramacion = null;

  const nombre = (fichasMap.get(reserva.dni) || {}).nombre || "DNI " + reserva.dni;
  reprogramarPaciente.textContent = `${nombre} · cita actual: ${reserva.data.fechaLabel || "—"}, ${reserva.data.hora || "—"}`;
  reprogramarFecha.value = "";
  reprogramarFecha.min = formatearFechaISO(new Date());
  reprogramarHoras.innerHTML = '<p class="col-span-full text-body-md text-on-surface-variant">Elige primero una fecha.</p>';
  reprogramarMotivoSelect.value = "";
  reprogramarError.classList.add("hidden");
  reprogramarModal.classList.remove("hidden");
}

function cerrarModalReprogramar() {
  reprogramarModal.classList.add("hidden");
  reservaEnReprogramacion = null;
  turnoReprogramacion = null;
}

reprogramarClose.addEventListener("click", cerrarModalReprogramar);
reprogramarModal.addEventListener("click", (e) => {
  if (e.target === reprogramarModal) cerrarModalReprogramar();
});

function renderHorasReprogramacion() {
  const fechaISO = reprogramarFecha.value;
  reprogramarHoras.innerHTML = "";

  if (!fechaISO) return;

  const fecha = new Date(`${fechaISO}T00:00:00`);
  const bloques = disponibilidadMap[DIA_KEY_POR_GETDAY[fecha.getDay()]] || [];
  const turnos = generarHorasDelDia(bloques);

  if (turnos.length === 0) {
    reprogramarHoras.innerHTML = '<p class="col-span-full text-body-md text-on-surface-variant">El psicólogo no atiende ese día.</p>';
    return;
  }

  turnos.forEach((turno) => {
    const ocupada = horaOcupada(fechaISO, turno.hora, reservaEnReprogramacion.dni);
    const meta = MODALIDADES[turno.modalidad] || MODALIDADES.presencial;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = meta.label;

    const icono = document.createElement("span");
    icono.className = "material-symbols-outlined text-[16px]";
    icono.textContent = meta.icon;
    const texto = document.createElement("span");
    texto.className = "text-label-md";
    texto.textContent = turno.hora;
    btn.appendChild(icono);
    btn.appendChild(texto);

    if (ocupada) {
      btn.disabled = true;
      btn.className = "py-2 rounded-lg border border-outline-variant bg-surface-container-low text-outline flex items-center justify-center gap-1 cursor-not-allowed opacity-70";
    } else {
      const seleccionado = turnoReprogramacion && turnoReprogramacion.hora === turno.hora;
      btn.className = seleccionado
        ? "py-2 rounded-lg border-2 border-secondary bg-secondary text-on-secondary flex items-center justify-center gap-1 font-semibold"
        : "py-2 rounded-lg border border-outline-variant hover:border-secondary flex items-center justify-center gap-1 transition-all";
      btn.addEventListener("click", () => {
        turnoReprogramacion = turno;
        renderHorasReprogramacion();
      });
    }

    reprogramarHoras.appendChild(btn);
  });
}

reprogramarFecha.addEventListener("change", () => {
  turnoReprogramacion = null;
  renderHorasReprogramacion();
});

reprogramarGuardar.addEventListener("click", async () => {
  if (!reservaEnReprogramacion) return;

  const fechaISO = reprogramarFecha.value;
  const motivo = reprogramarMotivoSelect.value;
  if (!fechaISO || !turnoReprogramacion || !motivo) {
    reprogramarError.textContent = "Elige una fecha, una hora y un motivo.";
    reprogramarError.classList.remove("hidden");
    return;
  }

  const fecha = new Date(`${fechaISO}T00:00:00`);
  // La modalidad y el enlace se actualizan al bloque de disponibilidad real
  // del horario elegido — no se conserva la modalidad de la cita original,
  // porque ese horario puede estar configurado para otra modalidad.
  const cambios = {
    fecha: fechaISO,
    fechaLabel: fechaLabelDe(fecha),
    hora: turnoReprogramacion.hora,
    modalidad: turnoReprogramacion.modalidad,
    enlace: turnoReprogramacion.modalidad === "virtual" ? turnoReprogramacion.enlace : "",
    estado: "reprogramada",
    motivo
  };

  const originalText = reprogramarGuardar.textContent;
  reprogramarGuardar.disabled = true;
  reprogramarGuardar.textContent = "Guardando...";

  try {
    await updateDoc(doc(dbPsico, PACIENTES_COLLECTION, reservaEnReprogramacion.dni), cambios);
    // El historial de citas (para estadísticas de asistencia) no tiene un
    // estado "reprogramada" aparte: reprogramar solo mueve una cita
    // pendiente a otra fecha, así que se registra como "reservada" de
    // nuevo (con la fecha nueva) — no es un desenlace de asistencia, es
    // el mismo tipo de evento que crea una reserva nueva. Esto también
    // abre un nuevo "ciclo de cita" en el historial de atencion.html.
    registrarHistorialCita(reservaEnReprogramacion.dni, {
      estado: "reservada",
      fecha: fechaISO,
      hora: turnoReprogramacion.hora,
      modalidad: turnoReprogramacion.modalidad,
      motivo,
      esParaFamiliar: !!reservaEnReprogramacion.data.esParaFamiliar,
      familiarNombre: reservaEnReprogramacion.data.familiarNombre || null,
      familiarParentesco: reservaEnReprogramacion.data.familiarParentesco || null
    }).catch((err) => console.warn("No se pudo registrar el historial de la cita:", err));
    Object.assign(reservaEnReprogramacion.data, cambios);
    cerrarModalReprogramar();
    renderLista();
    renderStats();
  } catch (err) {
    console.error("Error al reprogramar la cita:", err);
    reprogramarError.textContent = "No se pudo guardar el cambio.";
    reprogramarError.classList.remove("hidden");
  } finally {
    reprogramarGuardar.disabled = false;
    reprogramarGuardar.textContent = originalText;
  }
});

// ---------- Alerta de riesgo (sesión sin revisar más reciente) ----------
const riskAlertBanner = document.getElementById("risk-alert-banner");
const riskAlertTitle = document.getElementById("risk-alert-title");
const riskAlertDescription = document.getElementById("risk-alert-description");
const riskAlertReviewBtn = document.getElementById("risk-alert-review-btn");

async function loadRiskAlert() {
  try {
    const riesgoQuery = query(
      collectionGroup(dbPsico, "sesiones"),
      where("riesgo", "==", true),
      where("revisado", "==", false),
      orderBy("guardadoEn", "desc"),
      limit(1)
    );
    const snap = await getDocs(riesgoQuery);
    if (snap.empty) return;

    const sessionDoc = snap.docs[0];
    const sessionData = sessionDoc.data();
    const dni = sessionDoc.ref.parent.parent.id;
    const nombre = (fichasMap.get(dni) || {}).nombre || null;

    riskAlertTitle.textContent = `Alerta de Riesgo Crítico: ${nombre || "DNI " + dni}`;
    riskAlertDescription.textContent = sessionData.motivoConsulta
      ? `Motivo registrado en la última sesión: ${sessionData.motivoConsulta}`
      : "Se detectaron señales de riesgo en la última sesión. Se sugiere protocolo de intervención en crisis.";

    riskAlertReviewBtn.dataset.dni = dni;
    riskAlertReviewBtn.dataset.sessionPath = sessionDoc.ref.path;
    riskAlertBanner.classList.remove("hidden");
  } catch (err) {
    console.error("Error al buscar casos de riesgo:", err);
  }
}

riskAlertReviewBtn.addEventListener("click", async () => {
  const dniAlerta = riskAlertReviewBtn.dataset.dni;
  const sessionPath = riskAlertReviewBtn.dataset.sessionPath;
  if (!dniAlerta) return;

  try {
    if (sessionPath) {
      await updateDoc(doc(dbPsico, sessionPath), { revisado: true });
    }
  } catch (err) {
    console.error("Error al marcar el caso como revisado:", err);
  }

  window.location.href = "atencion.html?dni=" + encodeURIComponent(dniAlerta);
});

// ---------- Otros controles ----------
document.getElementById("fab-nueva-cita").addEventListener("click", () => {
  window.location.href = "index.html";
});

function renderHeaderFecha() {
  document.getElementById("header-fecha").textContent = new Date().toLocaleDateString("es-PE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

// ---------- Inicio (tras confirmar sesión, para que fichas no rebote) ----------
async function inicializar() {
  renderHeaderFecha();

  try {
    const [listaReservas, dispoMap] = await Promise.all([fetchReservas(), fetchDisponibilidadMap()]);
    reservas = listaReservas;
    disponibilidadMap = dispoMap;

    const dnis = reservas.map((r) => r.dni);
    fichasMap = dnis.length ? await fetchFichasPorDnis(dnis) : new Map();

    renderStats();
    renderLista();
  } catch (err) {
    console.error("Error al cargar las citas:", err);
    appointmentsList.innerHTML = '<p class="text-body-md text-error p-4">No se pudieron cargar las citas.</p>';
  }

  loadRiskAlert();
}

onAuthStateChanged(auth, (user) => {
  if (user) inicializar();
});
