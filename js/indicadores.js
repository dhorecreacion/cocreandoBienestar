// Tablero de Indicadores (V8 Psicólogo / V10 RRHH), con datos reales.
// Fuentes (mismo patrón eficiente que pacientes.js — nunca una consulta por
// paciente):
//   1. collectionGroup "sesiones" (fb-psico): todas las sesiones clínicas.
//   2. fichas (firebase-config, autenticado): área, género y nacimiento,
//      pedidos por lotes solo para los DNIs atendidos.
//   3. getCountFromServer sobre fichas: total de trabajadores para calcular
//      % Participación sin descargar toda la planilla.
// El toggle Psicólogo/RRHH es solo visual: en producción cada rol debería
// entrar con su propia cuenta y las reglas del backend decidir qué recibe.
import { dbPsico, MODALIDADES } from "./fb-psico.js";
import { auth, db } from "./firebase-config.js";
import { fetchFichasPorDnis } from "./fichas-cache.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  collectionGroup,
  getDocs,
  getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FICHAS_COLLECTION = "fichas";

const MESES_CORTOS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MESES_LARGOS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
];

const PRIORIDAD_META = {
  high: { label: "Alta", color: "#ba1a1a" },
  medium: { label: "Media", color: "#0058be" },
  low: { label: "Baja", color: "#c5c6cd" }
};

// ---------- Utilidades ----------
function timestampToDate(timestamp) {
  return timestamp && typeof timestamp.toDate === "function" ? timestamp.toDate() : null;
}

function porcentaje(parte, total) {
  return total > 0 ? Math.round((parte / total) * 1000) / 10 : 0;
}

function calcularEdad(fechaNacimiento) {
  const nacimiento = new Date(fechaNacimiento);
  if (!fechaNacimiento || Number.isNaN(nacimiento.getTime())) return null;
  const hoy = new Date();
  let edad = hoy.getFullYear() - nacimiento.getFullYear();
  const noCumple =
    hoy.getMonth() < nacimiento.getMonth() ||
    (hoy.getMonth() === nacimiento.getMonth() && hoy.getDate() < nacimiento.getDate());
  if (noCumple) edad -= 1;
  return edad;
}

function setTexto(id, texto) {
  document.getElementById(id).textContent = texto;
}

// Fila con barra de progreso (etiqueta + % + barra), armada con DOM APIs.
function crearFilaBarra(etiqueta, valorTexto, anchoPct, colorClase) {
  const fila = document.createElement("div");
  fila.className = "space-y-2";

  const encabezado = document.createElement("div");
  encabezado.className = "flex justify-between text-label-md text-on-surface-variant font-semibold";
  const spanEtiqueta = document.createElement("span");
  spanEtiqueta.textContent = etiqueta;
  const spanValor = document.createElement("span");
  spanValor.textContent = valorTexto;
  encabezado.appendChild(spanEtiqueta);
  encabezado.appendChild(spanValor);

  const pista = document.createElement("div");
  pista.className = "h-2 w-full bg-surface-container-highest rounded-full overflow-hidden";
  const barra = document.createElement("div");
  barra.className = "h-full rounded-full " + colorClase;
  barra.style.width = Math.min(100, Math.max(0, anchoPct)) + "%";
  pista.appendChild(barra);

  fila.appendChild(encabezado);
  fila.appendChild(pista);
  return fila;
}

function mensajeVacio(contenedor, texto) {
  contenedor.innerHTML = "";
  const p = document.createElement("p");
  p.className = "text-body-md text-on-surface-variant";
  p.textContent = texto;
  contenedor.appendChild(p);
}

// ---------- Carga de datos ----------
async function fetchSesiones() {
  const snap = await getDocs(collectionGroup(dbPsico, "sesiones"));
  const sesiones = [];
  snap.forEach((d) => {
    if (d.id === "borrador-actual") return; // los borradores no cuentan como atención
    sesiones.push({ dni: d.ref.parent.parent.id, data: d.data() });
  });
  return sesiones;
}

async function fetchTotalTrabajadores() {
  const snap = await getCountFromServer(collection(db, FICHAS_COLLECTION));
  return snap.data().count;
}

// ---------- Cálculo ----------
function calcularIndicadores(sesiones, fichas, totalTrabajadores) {
  const ahora = new Date();
  const anio = ahora.getFullYear();
  const mes = ahora.getMonth();

  const dnisTotales = new Set();
  const dnisMes = new Set();
  let atencionesMes = 0;
  const evaluadosPorMes = Array.from({ length: 12 }, () => new Set());
  const ultimaPorDni = new Map();
  const conteoAreas = new Map();
  const conteoDiagnosticos = new Map();
  const conteoDerivaciones = new Map();
  const conteoModalidades = new Map();

  sesiones.forEach(({ dni, data }) => {
    dnisTotales.add(dni);
    const fecha = timestampToDate(data.guardadoEn);

    if (fecha && fecha.getFullYear() === anio) {
      evaluadosPorMes[fecha.getMonth()].add(dni);
      if (fecha.getMonth() === mes) {
        atencionesMes++;
        dnisMes.add(dni);
      }
    }

    const previa = ultimaPorDni.get(dni);
    const fechaPrevia = previa ? timestampToDate(previa.guardadoEn) : null;
    if (!previa || (fecha && (!fechaPrevia || fecha > fechaPrevia))) {
      ultimaPorDni.set(dni, data);
    }

    const ficha = fichas.get(dni);
    const area = ficha && ficha.area ? ficha.area : "Sin área registrada";
    conteoAreas.set(area, (conteoAreas.get(area) || 0) + 1);

    (data.diagnosticos || []).forEach((diag) => {
      if (!diag || !diag.label) return;
      conteoDiagnosticos.set(diag.label, (conteoDiagnosticos.get(diag.label) || 0) + 1);
    });

    if (data.derivacion) {
      conteoDerivaciones.set(data.derivacion, (conteoDerivaciones.get(data.derivacion) || 0) + 1);
    }

    const modalidadKey = data.modalidad && MODALIDADES[data.modalidad] ? data.modalidad : "sin_registro";
    conteoModalidades.set(modalidadKey, (conteoModalidades.get(modalidadKey) || 0) + 1);
  });

  // Casos: se clasifican por la ÚLTIMA sesión de cada paciente.
  let casosRiesgo = 0;
  const conteoPrioridades = new Map();
  const urgentesPorArea = new Map();
  ultimaPorDni.forEach((ultima, dni) => {
    if (ultima.riesgo) casosRiesgo++;
    const prioridad = ultima.prioridad || "medium";
    conteoPrioridades.set(prioridad, (conteoPrioridades.get(prioridad) || 0) + 1);

    if (ultima.riesgo || prioridad === "high") {
      const ficha = fichas.get(dni);
      const area = ficha && ficha.area ? ficha.area : "Sin área registrada";
      urgentesPorArea.set(area, (urgentesPorArea.get(area) || 0) + 1);
    }
  });

  // Edades y género, sobre los pacientes con ficha encontrada.
  const edades = { "18-25": 0, "26-35": 0, "36-45": 0, "46+": 0 };
  const generos = new Map();
  let pacientesConFicha = 0;
  dnisTotales.forEach((dni) => {
    const ficha = fichas.get(dni);
    if (!ficha) return;
    pacientesConFicha++;

    const edad = calcularEdad(ficha.nacimiento);
    if (edad !== null) {
      if (edad <= 25) edades["18-25"]++;
      else if (edad <= 35) edades["26-35"]++;
      else if (edad <= 45) edades["36-45"]++;
      else edades["46+"]++;
    }

    const genero = ficha.genero || "No registrado";
    generos.set(genero, (generos.get(genero) || 0) + 1);
  });

  return {
    anio: anio,
    mes: mes,
    atencionesMes: atencionesMes,
    atendidosMes: dnisMes.size,
    participacion: porcentaje(dnisTotales.size, totalTrabajadores),
    casosActivos: dnisTotales.size,
    casosRiesgo: casosRiesgo,
    casosUrgentes: Array.from(urgentesPorArea.values()).reduce((a, b) => a + b, 0),
    evaluadosPorMes: evaluadosPorMes.map((set) => set.size),
    totalSesiones: sesiones.length,
    conteoAreas: conteoAreas,
    conteoPrioridades: conteoPrioridades,
    conteoDiagnosticos: conteoDiagnosticos,
    conteoDerivaciones: conteoDerivaciones,
    conteoModalidades: conteoModalidades,
    urgentesPorArea: urgentesPorArea,
    edades: edades,
    generos: generos,
    pacientesConFicha: pacientesConFicha
  };
}

// ---------- Render ----------
function renderKpis(ind) {
  setTexto("periodo-label", MESES_LARGOS[ind.mes].charAt(0).toUpperCase() + MESES_LARGOS[ind.mes].slice(1) + " " + ind.anio);
  setTexto("kpi-atenciones-mes", String(ind.atencionesMes));
  setTexto("kpi-participacion", ind.participacion + "%");
  setTexto("kpi-atendidos-mes", String(ind.atendidosMes));
  setTexto("kpi-casos-activos", String(ind.casosActivos));
  setTexto("riskValue", String(ind.casosRiesgo));
}

function renderChartMensual(ind) {
  const contenedor = document.getElementById("chart-mensual");
  setTexto("chart-anio", String(ind.anio));
  contenedor.innerHTML = "";

  const maximo = Math.max(...ind.evaluadosPorMes, 1);

  ind.evaluadosPorMes.forEach((valor, mesIdx) => {
    const columna = document.createElement("div");
    columna.className = "flex flex-col items-center flex-1 h-full justify-end group min-w-0";

    const barra = document.createElement("div");
    const esMesActual = mesIdx === ind.mes;
    barra.className =
      "w-full rounded-t-lg relative transition-all " +
      (esMesActual ? "bg-secondary shadow-md" : "bg-secondary/10 group-hover:bg-secondary/20");
    barra.style.height = valor > 0 ? Math.max(4, (valor / maximo) * 100) + "%" : "2px";

    const tooltip = document.createElement("div");
    tooltip.className =
      "absolute -top-8 left-1/2 -translate-x-1/2 bg-primary text-white text-[10px] px-2 py-1 rounded transition-opacity " +
      (esMesActual ? "" : "opacity-0 group-hover:opacity-100");
    tooltip.textContent = String(valor);
    barra.appendChild(tooltip);

    const etiqueta = document.createElement("span");
    etiqueta.className = "mt-4 text-[11px] truncate " + (esMesActual ? "font-bold text-primary" : "text-on-surface-variant font-medium");
    etiqueta.textContent = MESES_CORTOS[mesIdx];

    columna.appendChild(barra);
    columna.appendChild(etiqueta);
    contenedor.appendChild(columna);
  });
}

function renderChartAreas(ind) {
  const contenedor = document.getElementById("chart-areas");
  contenedor.innerHTML = "";

  if (ind.totalSesiones === 0) {
    mensajeVacio(contenedor, "Aún no hay sesiones registradas.");
    return;
  }

  Array.from(ind.conteoAreas.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .forEach(([area, cuenta]) => {
      const pct = porcentaje(cuenta, ind.totalSesiones);
      contenedor.appendChild(crearFilaBarra(area, pct + "%", pct, "bg-secondary"));
    });
}

function renderChartPrioridades(ind) {
  const donut = document.getElementById("chart-prioridades-donut");
  const leyenda = document.getElementById("chart-prioridades-legend");
  leyenda.innerHTML = "";

  const totalCasos = Array.from(ind.conteoPrioridades.values()).reduce((a, b) => a + b, 0);
  if (totalCasos === 0) {
    mensajeVacio(leyenda, "Aún no hay casos registrados.");
    setTexto("donut-center-value", "0");
    setTexto("donut-center-label", "Casos");
    return;
  }

  // Donut real: conic-gradient con los porcentajes exactos de cada prioridad.
  const orden = ["high", "medium", "low"];
  let acumulado = 0;
  const segmentos = [];
  let mayor = { label: "", pct: -1 };

  orden.forEach((clave) => {
    const cuenta = ind.conteoPrioridades.get(clave) || 0;
    if (cuenta === 0) return;
    const meta = PRIORIDAD_META[clave];
    const pct = (cuenta / totalCasos) * 100;
    segmentos.push(meta.color + " " + acumulado + "% " + (acumulado + pct) + "%");
    acumulado += pct;
    const pctRedondeado = porcentaje(cuenta, totalCasos);
    if (pctRedondeado > mayor.pct) mayor = { label: meta.label, pct: pctRedondeado };

    const fila = document.createElement("div");
    fila.className = "flex items-center gap-3";
    const punto = document.createElement("span");
    punto.className = "w-4 h-4 rounded flex-shrink-0";
    punto.style.backgroundColor = meta.color;
    const textos = document.createElement("div");
    textos.className = "flex-1 flex justify-between text-body-md font-medium";
    const nombre = document.createElement("span");
    nombre.textContent = "Prioridad " + meta.label;
    const valor = document.createElement("span");
    valor.textContent = cuenta + " (" + pctRedondeado + "%)";
    textos.appendChild(nombre);
    textos.appendChild(valor);
    fila.appendChild(punto);
    fila.appendChild(textos);
    leyenda.appendChild(fila);
  });

  donut.style.background = "conic-gradient(" + segmentos.join(", ") + ")";
  setTexto("donut-center-value", mayor.pct + "%");
  setTexto("donut-center-label", mayor.label);
}

function renderDiagnosticos(ind) {
  const contenedor = document.getElementById("psychContent");
  contenedor.innerHTML = "";

  const totalMenciones = Array.from(ind.conteoDiagnosticos.values()).reduce((a, b) => a + b, 0);
  if (totalMenciones === 0) {
    mensajeVacio(contenedor, "Aún no hay diagnósticos registrados en las sesiones.");
    return;
  }

  Array.from(ind.conteoDiagnosticos.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .forEach(([label, cuenta], indice) => {
      const fila = document.createElement("div");
      fila.className = "flex items-center justify-between p-4 bg-surface-container-low rounded-lg border border-outline-variant/30";

      const izquierda = document.createElement("div");
      izquierda.className = "flex items-center gap-4 min-w-0";
      const numero = document.createElement("div");
      numero.className = "w-10 h-10 flex-shrink-0 rounded bg-white flex items-center justify-center font-bold text-secondary shadow-sm";
      numero.textContent = String(indice + 1).padStart(2, "0");
      const nombre = document.createElement("span");
      nombre.className = "font-body-md font-semibold truncate";
      nombre.textContent = label;
      izquierda.appendChild(numero);
      izquierda.appendChild(nombre);

      const pct = document.createElement("span");
      pct.className = "text-body-md font-bold text-secondary flex-shrink-0 ml-3";
      pct.textContent = porcentaje(cuenta, totalMenciones) + "%";

      fila.appendChild(izquierda);
      fila.appendChild(pct);
      contenedor.appendChild(fila);
    });
}

function renderUrgentesPorArea(ind) {
  const contenedor = document.getElementById("hrContent");
  contenedor.innerHTML = "";

  const nota = document.createElement("p");
  nota.className = "text-xs text-on-surface-variant mb-2";
  nota.textContent = "Casos urgentes por área (conteo, sin nombres ni motivos)";
  contenedor.appendChild(nota);

  if (ind.urgentesPorArea.size === 0) {
    const vacio = document.createElement("p");
    vacio.className = "text-body-md text-on-surface-variant";
    vacio.textContent = "No hay casos urgentes en este momento.";
    contenedor.appendChild(vacio);
    return;
  }

  const maximo = Math.max(...ind.urgentesPorArea.values());
  Array.from(ind.urgentesPorArea.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([area, cuenta]) => {
      const etiquetaCuenta = cuenta === 1 ? "1 caso" : cuenta + " casos";
      contenedor.appendChild(crearFilaBarra(area, etiquetaCuenta, (cuenta / maximo) * 100, "bg-error/70"));
    });
}

function renderEdadesYGenero(ind) {
  const edadesEl = document.getElementById("chart-edades");
  const generoEl = document.getElementById("chart-genero");
  edadesEl.innerHTML = "";
  generoEl.innerHTML = "";

  if (ind.pacientesConFicha === 0) {
    mensajeVacio(edadesEl, "Sin fichas de personal vinculadas todavía.");
    mensajeVacio(generoEl, "—");
    return;
  }

  const totalEdades = Object.values(ind.edades).reduce((a, b) => a + b, 0);
  Object.entries(ind.edades).forEach(([rango, cuenta]) => {
    const pct = porcentaje(cuenta, totalEdades || 1);
    edadesEl.appendChild(crearFilaBarra(rango, pct + "%", pct, "bg-secondary"));
  });

  const coloresGenero = ["bg-secondary", "bg-tertiary-fixed-dim", "bg-surface-container-highest"];
  Array.from(ind.generos.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([genero, cuenta], indice) => {
      const chip = document.createElement("span");
      chip.className = "flex items-center gap-2";
      const punto = document.createElement("span");
      punto.className = "w-3 h-3 rounded-full " + coloresGenero[Math.min(indice, coloresGenero.length - 1)];
      chip.appendChild(punto);
      chip.appendChild(document.createTextNode(genero + " " + porcentaje(cuenta, ind.pacientesConFicha) + "%"));
      generoEl.appendChild(chip);
    });
}

function renderModalidades(ind) {
  const contenedor = document.getElementById("chart-modalidades");
  contenedor.innerHTML = "";

  const total = Array.from(ind.conteoModalidades.values()).reduce((a, b) => a + b, 0);
  if (total === 0) {
    mensajeVacio(contenedor, "Aún no hay sesiones registradas.");
    return;
  }

  const colores = { presencial: "bg-secondary", virtual: "bg-secondary/60", llamada: "bg-tertiary-fixed-dim", sin_registro: "bg-surface-container-highest" };

  Array.from(ind.conteoModalidades.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([clave, cuenta]) => {
      const etiqueta = clave === "sin_registro" ? "Sin registro (citas antiguas)" : MODALIDADES[clave].label;
      const pct = porcentaje(cuenta, total);
      contenedor.appendChild(crearFilaBarra(etiqueta, pct + "%", pct, colores[clave] || "bg-secondary"));
    });
}

function renderDerivaciones(ind) {
  const contenedor = document.getElementById("chart-derivaciones");
  contenedor.innerHTML = "";

  const total = Array.from(ind.conteoDerivaciones.values()).reduce((a, b) => a + b, 0);
  if (total === 0) {
    mensajeVacio(contenedor, "Aún no hay derivaciones registradas.");
    return;
  }

  Array.from(ind.conteoDerivaciones.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([derivacion, cuenta]) => {
      const pct = porcentaje(cuenta, total);
      const color = derivacion.includes("Urgente")
        ? "bg-error"
        : derivacion === "No requerida"
          ? "bg-surface-container-highest"
          : "bg-secondary";
      contenedor.appendChild(crearFilaBarra(derivacion, pct + "%", pct, color));
    });
}

// ---------- Toggle Psicólogo (V8) / RRHH (V10) ----------
let indicadores = null;

function switchView(view) {
  const psychBtn = document.getElementById("viewPsych");
  const hrBtn = document.getElementById("viewHR");
  const psychContent = document.getElementById("psychContent");
  const hrContent = document.getElementById("hrContent");
  const riskCasesCard = document.getElementById("riskCasesCard");

  const esPsych = view === "psych";
  const activo = esPsych ? psychBtn : hrBtn;
  const inactivo = esPsych ? hrBtn : psychBtn;

  activo.classList.add("bg-secondary", "text-on-secondary", "shadow-sm");
  activo.classList.remove("text-on-surface-variant", "hover:bg-surface-container-high");
  inactivo.classList.remove("bg-secondary", "text-on-secondary", "shadow-sm");
  inactivo.classList.add("text-on-surface-variant", "hover:bg-surface-container-high");

  psychContent.classList.toggle("hidden", !esPsych);
  hrContent.classList.toggle("hidden", esPsych);

  setTexto("dynamicTitle", esPsych ? "Diagnósticos Más Frecuentes" : "Casos Urgentes por Área");
  setTexto("viewTitle", esPsych ? "Desempeño Operativo" : "Salud Organizacional");
  setTexto("viewSubtitle", esPsych ? "Resumen Operativo Mensual" : "Analítica Anonimizada (sin nombres ni diagnósticos)");

  riskCasesCard.classList.toggle("bg-red-50/50", esPsych);
  riskCasesCard.classList.toggle("border-red-100", esPsych);
  riskCasesCard.classList.toggle("bg-secondary/5", !esPsych);
  riskCasesCard.classList.toggle("border-secondary/20", !esPsych);
  setTexto("riskLabel", esPsych ? "Casos de Riesgo" : "Casos Urgentes");
  if (indicadores) {
    setTexto("riskValue", String(esPsych ? indicadores.casosRiesgo : indicadores.casosUrgentes));
  }
}

document.getElementById("viewPsych").addEventListener("click", () => switchView("psych"));
document.getElementById("viewHR").addEventListener("click", () => switchView("hr"));

// Exportar: usa la impresión del navegador (permite guardar como PDF el
// tablero tal como se ve), hasta que exista un generador de reporte formal.
document.getElementById("export-btn").addEventListener("click", () => window.print());

// ---------- Inicio (tras confirmar sesión, para que fichas no rebote) ----------
async function inicializar() {
  try {
    const sesiones = await fetchSesiones();
    const dnis = Array.from(new Set(sesiones.map((s) => s.dni)));

    const [fichas, totalTrabajadores] = await Promise.all([
      dnis.length ? fetchFichasPorDnis(dnis) : Promise.resolve(new Map()),
      fetchTotalTrabajadores()
    ]);

    indicadores = calcularIndicadores(sesiones, fichas, totalTrabajadores);

    renderKpis(indicadores);
    renderChartMensual(indicadores);
    renderChartAreas(indicadores);
    renderChartPrioridades(indicadores);
    renderDiagnosticos(indicadores);
    renderUrgentesPorArea(indicadores);
    renderEdadesYGenero(indicadores);
    renderModalidades(indicadores);
    renderDerivaciones(indicadores);
  } catch (err) {
    console.error("Error al cargar los indicadores:", err);
    ["chart-mensual", "chart-areas", "chart-prioridades-legend", "psychContent", "chart-edades", "chart-derivaciones"].forEach(
      (id) => mensajeVacio(document.getElementById(id), "No se pudieron cargar los datos.")
    );
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) inicializar();
});
