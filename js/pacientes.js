// Directorio de Pacientes (V6).
// Cruza tres fuentes en solo 2 + ceil(N/10) consultas (nunca una por paciente):
//   1. pacientes (fb-psico): las reservas hechas desde la página pública.
//   2. collectionGroup "sesiones" (fb-psico): TODAS las sesiones de todos los
//      pacientes en una sola consulta, agrupadas aquí por el DNI del padre.
//   3. fichas (firebase-config, autenticado): nombre y área, pedidos por
//      lotes con where("personal.doc", "in", [...]) solo para los DNIs que
//      realmente aparecen en el directorio.
import { dbPsico, PACIENTES_COLLECTION } from "./fb-psico.js";
import { fetchFichasPorDnis } from "./fichas-cache.js";
import {
  collection,
  collectionGroup,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const searchInput = document.getElementById("search-input");
const areaFilter = document.getElementById("area-filter");
const patientsList = document.getElementById("patients-list");
const statPacientes = document.getElementById("stat-pacientes");
const statEnAtencion = document.getElementById("stat-en-atencion");
const statRiesgo = document.getElementById("stat-riesgo");

let registros = [];

// ---------- Utilidades ----------
function normalizar(texto) {
  // NFD separa las tildes en caracteres combinantes (U+0300..U+036F) y luego
  // se eliminan, para que "Pérez" y "perez" coincidan al buscar.
  return (texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function getInitials(fullName) {
  return fullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function timestampToDate(timestamp) {
  return timestamp && typeof timestamp.toDate === "function" ? timestamp.toDate() : null;
}

function formatFecha(date) {
  if (!date) return "—";
  return date.toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "numeric" });
}

// ---------- Carga de datos ----------
async function fetchReservas() {
  const snap = await getDocs(collection(dbPsico, PACIENTES_COLLECTION));
  const reservas = new Map();
  snap.forEach((d) => reservas.set(d.id, d.data()));
  return reservas;
}

async function fetchSesionesAgrupadas() {
  const snap = await getDocs(collectionGroup(dbPsico, "sesiones"));
  const porDni = new Map();

  snap.forEach((d) => {
    const dni = d.ref.parent.parent.id;
    if (!porDni.has(dni)) porDni.set(dni, { completadas: [], tieneBorrador: false });

    const grupo = porDni.get(dni);
    if (d.id === "borrador-actual") {
      grupo.tieneBorrador = true;
    } else {
      grupo.completadas.push(d.data());
    }
  });

  // Más reciente primero, para sacar riesgo/prioridad de la última sesión.
  porDni.forEach((grupo) => {
    grupo.completadas.sort((a, b) => {
      const fa = timestampToDate(a.guardadoEn);
      const fb = timestampToDate(b.guardadoEn);
      return (fb ? fb.getTime() : 0) - (fa ? fa.getTime() : 0);
    });
  });

  return porDni;
}

// ---------- Armado de registros ----------
async function cargarRegistros() {
  const [reservas, sesionesPorDni] = await Promise.all([fetchReservas(), fetchSesionesAgrupadas()]);

  // Un paciente puede tener reserva sin sesiones, o sesiones sin reserva
  // vigente: el directorio muestra la unión de ambos conjuntos.
  const dnis = Array.from(new Set([...reservas.keys(), ...sesionesPorDni.keys()]));
  const fichas = dnis.length ? await fetchFichasPorDnis(dnis) : new Map();

  return dnis.map((dni) => {
    const reserva = reservas.get(dni) || null;
    const sesiones = sesionesPorDni.get(dni) || { completadas: [], tieneBorrador: false };
    const ficha = fichas.get(dni) || null;
    const ultimaSesion = sesiones.completadas[0] || null;

    const fechaUltimaSesion = ultimaSesion ? timestampToDate(ultimaSesion.guardadoEn) : null;
    const fechaReserva = reserva ? timestampToDate(reserva.creadoEn) : null;
    const ultimaActividad = fechaUltimaSesion || fechaReserva;

    return {
      dni: dni,
      nombre: ficha ? ficha.nombre : "",
      area: ficha ? ficha.area : "",
      totalSesiones: sesiones.completadas.length,
      tieneBorrador: sesiones.tieneBorrador,
      riesgo: !!(ultimaSesion && ultimaSesion.riesgo),
      prioridad: ultimaSesion ? ultimaSesion.prioridad || "" : "",
      fechaUltimaSesion: fechaUltimaSesion,
      proximaCita: reserva && reserva.fechaLabel && reserva.hora ? `${reserva.fechaLabel}, ${reserva.hora}` : "",
      ultimaActividad: ultimaActividad
    };
  });
}

// ---------- Render (DOM APIs con textContent: el DNI viene de un formulario
// público, nunca debe interpretarse como HTML) ----------
function crearBadge(texto, classes) {
  const span = document.createElement("span");
  span.className = "text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider " + classes;
  span.textContent = texto;
  return span;
}

function crearFilaPaciente(registro) {
  const card = document.createElement("div");
  card.className =
    "group bg-surface-container-lowest border border-outline-variant rounded-xl flex overflow-hidden shadow-sm hover:shadow-md transition-shadow";

  const barra = document.createElement("div");
  barra.className = "w-2 flex-shrink-0 " + (registro.riesgo ? "bg-error" : registro.totalSesiones > 0 ? "bg-green-500" : "bg-secondary");
  card.appendChild(barra);

  const cuerpo = document.createElement("div");
  cuerpo.className = "p-4 sm:p-5 flex-1 flex flex-col md:flex-row md:items-center gap-4";
  card.appendChild(cuerpo);

  // Identidad: avatar + nombre + dni + área
  const identidad = document.createElement("div");
  identidad.className = "flex items-center gap-4 flex-1 min-w-0";
  cuerpo.appendChild(identidad);

  const avatar = document.createElement("div");
  avatar.className =
    "w-12 h-12 flex-shrink-0 rounded-full bg-secondary-fixed flex items-center justify-center text-secondary font-bold";
  avatar.textContent = registro.nombre ? getInitials(registro.nombre) : "?";
  identidad.appendChild(avatar);

  const textos = document.createElement("div");
  textos.className = "min-w-0";
  identidad.appendChild(textos);

  const nombreEl = document.createElement("h4");
  nombreEl.className = "font-headline-md text-headline-md truncate " + (registro.nombre ? "text-primary" : "text-on-surface-variant italic");
  nombreEl.textContent = registro.nombre || "Sin ficha de personal";
  textos.appendChild(nombreEl);

  const subEl = document.createElement("p");
  subEl.className = "text-body-md text-on-surface-variant truncate";
  subEl.textContent = "DNI: " + registro.dni + (registro.area ? " · " + registro.area : "");
  textos.appendChild(subEl);

  // Estado: badges
  const badges = document.createElement("div");
  badges.className = "flex flex-wrap items-center gap-2";
  cuerpo.appendChild(badges);

  if (registro.riesgo) badges.appendChild(crearBadge("Riesgo", "bg-error-container text-on-error-container"));
  if (registro.tieneBorrador) badges.appendChild(crearBadge("Borrador", "bg-orange-100 text-orange-800"));
  badges.appendChild(
    registro.totalSesiones > 0
      ? crearBadge("En atención", "bg-green-100 text-green-800")
      : crearBadge("Reservado", "bg-secondary-fixed text-on-secondary-fixed-variant")
  );

  // Métricas: sesiones + fechas
  const metricas = document.createElement("div");
  metricas.className = "flex gap-6 md:text-right";
  cuerpo.appendChild(metricas);

  const sesionesCol = document.createElement("div");
  const sesionesNum = document.createElement("p");
  sesionesNum.className = "font-headline-md text-headline-md text-primary";
  sesionesNum.textContent = String(registro.totalSesiones);
  const sesionesLbl = document.createElement("p");
  sesionesLbl.className = "text-label-md text-on-surface-variant";
  sesionesLbl.textContent = "Sesiones";
  sesionesCol.appendChild(sesionesNum);
  sesionesCol.appendChild(sesionesLbl);
  metricas.appendChild(sesionesCol);

  const fechasCol = document.createElement("div");
  const ultimaEl = document.createElement("p");
  ultimaEl.className = "text-body-md font-medium text-primary";
  ultimaEl.textContent = formatFecha(registro.fechaUltimaSesion);
  const ultimaLbl = document.createElement("p");
  ultimaLbl.className = "text-label-md text-on-surface-variant";
  ultimaLbl.textContent = registro.proximaCita ? "Última · Cita: " + registro.proximaCita : "Última atención";
  fechasCol.appendChild(ultimaEl);
  fechasCol.appendChild(ultimaLbl);
  metricas.appendChild(fechasCol);

  // Acción: abrir la ficha (historial + nueva atención viven en atencion.html)
  const acciones = document.createElement("div");
  acciones.className = "flex md:justify-end";
  cuerpo.appendChild(acciones);

  const abrirBtn = document.createElement("button");
  abrirBtn.type = "button";
  abrirBtn.className =
    "w-full md:w-auto px-4 py-2 bg-secondary text-on-secondary text-label-md font-semibold rounded-lg hover:opacity-90 transition-all flex items-center justify-center gap-2";
  abrirBtn.innerHTML = '<span class="material-symbols-outlined text-[18px]">folder_open</span>';
  abrirBtn.appendChild(document.createTextNode("Abrir ficha"));
  abrirBtn.addEventListener("click", () => {
    window.location.href = "atencion.html?dni=" + encodeURIComponent(registro.dni);
  });
  acciones.appendChild(abrirBtn);

  return card;
}

function renderLista() {
  const texto = normalizar(searchInput.value.trim());
  const area = areaFilter.value;

  const filtrados = registros.filter((r) => {
    const coincideTexto = !texto || normalizar(r.dni).includes(texto) || normalizar(r.nombre).includes(texto);
    const coincideArea = !area || r.area === area;
    return coincideTexto && coincideArea;
  });

  patientsList.innerHTML = "";

  if (filtrados.length === 0) {
    const vacio = document.createElement("p");
    vacio.className = "text-body-md text-on-surface-variant p-4";
    vacio.textContent = registros.length === 0 ? "Todavía no hay pacientes registrados." : "Sin resultados para esta búsqueda.";
    patientsList.appendChild(vacio);
    return;
  }

  filtrados.forEach((registro) => patientsList.appendChild(crearFilaPaciente(registro)));
}

function renderStats() {
  statPacientes.textContent = String(registros.length);
  statEnAtencion.textContent = String(registros.filter((r) => r.totalSesiones > 0).length);
  statRiesgo.textContent = String(registros.filter((r) => r.riesgo).length);
}

function poblarFiltroAreas() {
  // Se limpia primero (menos la opción "Todas") porque el directorio puede
  // recargarse tras importar histórico sin refrescar la página.
  while (areaFilter.options.length > 1) areaFilter.remove(1);

  const areas = Array.from(new Set(registros.map((r) => r.area).filter(Boolean))).sort();
  areas.forEach((area) => {
    const option = document.createElement("option");
    option.value = area;
    option.textContent = area;
    areaFilter.appendChild(option);
  });
}

// ---------- Inicio ----------
async function inicializar() {
  try {
    registros = await cargarRegistros();
    registros.sort(
      (a, b) => (b.ultimaActividad ? b.ultimaActividad.getTime() : 0) - (a.ultimaActividad ? a.ultimaActividad.getTime() : 0)
    );
    renderStats();
    poblarFiltroAreas();
    renderLista();
  } catch (err) {
    console.error("Error al cargar el directorio de pacientes:", err);
    patientsList.innerHTML = "";
    const errorEl = document.createElement("p");
    errorEl.className = "text-body-md text-error p-4";
    errorEl.textContent = "No se pudo cargar el directorio de pacientes.";
    patientsList.appendChild(errorEl);
  }
}

searchInput.addEventListener("input", renderLista);
areaFilter.addEventListener("change", renderLista);

// El importador de histórico (js/importador.js) avisa cuando termina para
// que el directorio se recargue sin refrescar la página.
window.addEventListener("historico-importado", inicializar);

inicializar();
