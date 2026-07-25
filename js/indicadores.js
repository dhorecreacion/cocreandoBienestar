// Tablero de Indicadores del Psicólogo (V8), con datos reales.
// Fuentes (mismo patrón eficiente que pacientes.js — nunca una consulta por
// paciente, y un solo fetch por fuente aunque el psicólogo cambie de mes):
//   1. collectionGroup "sesiones" (fb-psico): todas las sesiones clínicas.
//   2. collectionGroup "historial_citas" (fb-psico): el historial acumulado
//      de eventos de cada cita (reservada/no_asistio/atendida — reprogramar
//      solo mueve una cita pendiente a otra fecha, no es un desenlace de
//      asistencia, así que no tiene su propio estado; se registra como
//      "reservada" de nuevo).
//   3. disponibilidad (fb-psico): plantilla semanal de bloques + intervalo,
//      para calcular capacidad/utilización.
//   4. fichas (firebase-config, autenticado): área, género y nacimiento,
//      pedidos por lotes solo para los DNIs atendidos.
//   5. configuracion/general (fb-psico): umbral de días para "Casos Sin
//      Seguimiento", editable en configuracion.html.
// El selector de mes NO vuelve a consultar Firestore: los datos crudos se
// piden una sola vez y cada cambio de mes solo recalcula en el cliente.
// La vista de RRHH (V10) se retiró de aquí (era un toggle en la misma
// pantalla); si se retoma, debe vivir en su propia página de solo lectura.
import { dbPsico, MODALIDADES, DISPONIBILIDAD_COLLECTION, DIAS_SEMANA, CONFIGURACION_COLLECTION } from "./fb-psico.js";
import { auth } from "./firebase-config.js";
import { fetchFichasPorDnis } from "./fichas-cache.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collectionGroup,
  getDocs,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const MESES_CORTOS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const CLAVE_DIA_POR_GETDAY = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const UMBRAL_SEGUIMIENTO_DEFAULT = 30; // respaldo si configuracion/general aún no existe

const PRIORIDAD_META = {
  high: { label: "Alta", color: "#ba1a1a" },
  medium: { label: "Media", color: "#0058be" },
  low: { label: "Baja", color: "#c5c6cd" }
};

const APTITUD_META = {
  apto: { label: "Apto", color: "#2e7d32" },
  restricciones: { label: "Restricciones", color: "#f59e0b" },
  no_apto: { label: "No apto", color: "#ba1a1a" }
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

// Barra vertical (columna) para gráficos de 12 meses, reutilizada por
// "Evaluados por Mes" y "Tendencia de Asistencia".
function crearColumnaMes(mesIdx, valor, maximo, esMesSeleccionado, sufijo) {
  const columna = document.createElement("div");
  columna.className = "flex flex-col items-center flex-1 h-full justify-end group min-w-0";

  const barra = document.createElement("div");
  barra.className =
    "w-full rounded-t-lg relative transition-all " +
    (esMesSeleccionado ? "bg-secondary shadow-md" : "bg-secondary/10 group-hover:bg-secondary/20");
  barra.style.height = valor > 0 ? Math.max(4, (valor / maximo) * 100) + "%" : "2px";

  const tooltip = document.createElement("div");
  tooltip.className =
    "absolute -top-8 left-1/2 -translate-x-1/2 bg-primary text-white text-[10px] px-2 py-1 rounded transition-opacity " +
    (esMesSeleccionado ? "" : "opacity-0 group-hover:opacity-100");
  tooltip.textContent = valor + (sufijo || "");
  barra.appendChild(tooltip);

  const etiqueta = document.createElement("span");
  etiqueta.className = "mt-4 text-[11px] truncate " + (esMesSeleccionado ? "font-bold text-primary" : "text-on-surface-variant font-medium");
  etiqueta.textContent = MESES_CORTOS[mesIdx];

  columna.appendChild(barra);
  columna.appendChild(etiqueta);
  return columna;
}

// ---------- Carga de datos (una sola vez; el selector de mes no reconsulta) ----------
async function fetchSesiones() {
  const snap = await getDocs(collectionGroup(dbPsico, "sesiones"));
  const sesiones = [];
  snap.forEach((d) => {
    if (d.id === "borrador-actual") return; // los borradores no cuentan como atención
    sesiones.push({ dni: d.ref.parent.parent.id, data: d.data() });
  });
  return sesiones;
}

// Historial acumulado de eventos de citas (pacientes/{dni}/historial_citas):
// a diferencia de pacientes/{dni} —que se sobreescribe en cada reserva
// nueva—, esto nunca se pisa, así que sí permite calcular una tasa de
// asistencia real acumulada en el tiempo.
async function fetchCitas() {
  const snap = await getDocs(collectionGroup(dbPsico, "historial_citas"));
  const citas = [];
  snap.forEach((d) => citas.push(d.data()));
  return citas;
}

// Plantilla semanal de disponibilidad (7 días + intervalo de cita), para
// estimar capacidad. OJO: es la plantilla ACTUAL; si los horarios cambiaron
// en el pasado, la capacidad de meses anteriores es una aproximación, no un
// registro histórico real (eso no se guarda hoy).
async function fetchDisponibilidadCompleta() {
  const [snapshots, configSnap] = await Promise.all([
    Promise.all(DIAS_SEMANA.map((dia) => getDoc(doc(dbPsico, DISPONIBILIDAD_COLLECTION, dia)))),
    getDoc(doc(dbPsico, DISPONIBILIDAD_COLLECTION, "config"))
  ]);

  const bloquesPorDia = {};
  DIAS_SEMANA.forEach((dia, i) => {
    bloquesPorDia[dia] = snapshots[i].exists() ? snapshots[i].data().bloques || [] : [];
  });

  const intervaloMinutos = configSnap.exists() ? Number(configSnap.data().intervaloMinutos) || 30 : 30;
  return { bloquesPorDia, intervaloMinutos };
}

// Umbral de días sin sesión para marcar un caso como "sin seguimiento",
// editable en configuracion.html (antes era un número fijo en el código).
async function fetchUmbralSeguimiento() {
  try {
    const snap = await getDoc(doc(dbPsico, CONFIGURACION_COLLECTION, "general"));
    const valor = snap.exists() ? Number(snap.data().umbralSeguimientoDias) : NaN;
    return Number.isInteger(valor) && valor > 0 ? valor : UMBRAL_SEGUIMIENTO_DEFAULT;
  } catch (err) {
    console.warn("No se pudo cargar el umbral de seguimiento; se usa el valor por defecto:", err);
    return UMBRAL_SEGUIMIENTO_DEFAULT;
  }
}

// ---------- Capacidad / utilización ----------
// Cuenta los turnos reservables (excluye bloques apagados y "emergencia",
// que solo bloquea agenda y nunca es una cita reservable) de un día.
function contarSlotsBloques(bloques, intervaloMinutos) {
  return (bloques || [])
    .filter((b) => b.activo && b.modalidad !== "emergencia")
    .reduce((total, b) => {
      const [hI, mI] = b.horaInicio.split(":").map(Number);
      const [hF, mF] = b.horaFin.split(":").map(Number);
      const minutos = hF * 60 + mF - (hI * 60 + mI);
      return total + (minutos > 0 ? Math.floor(minutos / intervaloMinutos) : 0);
    }, 0);
}

function contarDiasSemanaEnMes(anio, mes) {
  const conteo = { lunes: 0, martes: 0, miercoles: 0, jueves: 0, viernes: 0, sabado: 0, domingo: 0 };
  const totalDias = new Date(anio, mes + 1, 0).getDate();
  for (let d = 1; d <= totalDias; d++) {
    conteo[CLAVE_DIA_POR_GETDAY[new Date(anio, mes, d).getDay()]]++;
  }
  return conteo;
}

function calcularCapacidadMes(disponibilidad, anio, mes) {
  const conteoDias = contarDiasSemanaEnMes(anio, mes);
  return DIAS_SEMANA.reduce((total, dia) => {
    const slotsPorDia = contarSlotsBloques(disponibilidad.bloquesPorDia[dia], disponibilidad.intervaloMinutos);
    return total + slotsPorDia * conteoDias[dia];
  }, 0);
}

// ---------- Cálculo ----------
function calcularIndicadores(sesiones, fichas, citas, disponibilidad, mesSeleccionado, umbralSeguimientoDias) {
  const ahora = new Date();
  const anio = ahora.getFullYear();
  const mes = mesSeleccionado;

  const dnisTotales = new Set();
  const dnisMes = new Set();
  let atencionesMes = 0;
  const evaluadosPorMes = Array.from({ length: 12 }, () => new Set());
  const ultimaPorDni = new Map();
  const conteoAreas = new Map();
  const conteoDiagnosticos = new Map();
  const conteoDerivaciones = new Map();
  const conteoModalidades = new Map();
  const diagPorArea = new Map(); // area -> Map(diagnostico -> cuenta)
  const aptitudMes = { apto: 0, restricciones: 0, no_apto: 0 };

  sesiones.forEach(({ dni, data }) => {
    dnisTotales.add(dni);
    const fecha = timestampToDate(data.guardadoEn);
    const ficha = fichas.get(dni);
    const area = ficha && ficha.area ? ficha.area : "Sin área registrada";

    if (fecha && fecha.getFullYear() === anio) {
      evaluadosPorMes[fecha.getMonth()].add(dni);
      if (fecha.getMonth() === mes) {
        atencionesMes++;
        dnisMes.add(dni);
        if (data.aptitud && Object.prototype.hasOwnProperty.call(aptitudMes, data.aptitud)) {
          aptitudMes[data.aptitud]++;
        }
      }
    }

    const previa = ultimaPorDni.get(dni);
    const fechaPrevia = previa ? timestampToDate(previa.guardadoEn) : null;
    if (!previa || (fecha && (!fechaPrevia || fecha > fechaPrevia))) {
      ultimaPorDni.set(dni, data);
    }

    conteoAreas.set(area, (conteoAreas.get(area) || 0) + 1);

    (data.diagnosticos || []).forEach((diag) => {
      if (!diag || !diag.label) return;
      conteoDiagnosticos.set(diag.label, (conteoDiagnosticos.get(diag.label) || 0) + 1);
      if (!diagPorArea.has(area)) diagPorArea.set(area, new Map());
      const porArea = diagPorArea.get(area);
      porArea.set(diag.label, (porArea.get(diag.label) || 0) + 1);
    });

    if (data.derivacion) {
      conteoDerivaciones.set(data.derivacion, (conteoDerivaciones.get(data.derivacion) || 0) + 1);
    }

    const modalidadKey = data.modalidad && MODALIDADES[data.modalidad] ? data.modalidad : "sin_registro";
    conteoModalidades.set(modalidadKey, (conteoModalidades.get(modalidadKey) || 0) + 1);
  });

  // Asistencia por mes (de historial_citas, agrupado por la fecha real de la
  // cita): base tanto de "% Participación" (mes elegido) como de la
  // tendencia de 12 meses. Solo cuentan las citas con desenlace real
  // (atendida / no_asistio); "reservada" (aún pendiente, incluida la que
  // deja una reprogramación) no suma ni arriba ni abajo. Datos viejos con
  // estado "reprogramada" (de antes de este cambio) tampoco suman — quedan
  // como si siguieran pendientes, igual que "reservada".
  const asistenciaPorMesDetalle = Array.from({ length: 12 }, () => ({ atendidas: 0, total: 0 }));
  citas.forEach((cita) => {
    const estado = cita.estado || "reservada";
    if (estado !== "atendida" && estado !== "no_asistio") return;
    const fecha = cita.fecha ? new Date(cita.fecha + "T00:00:00") : null;
    if (!fecha || Number.isNaN(fecha.getTime()) || fecha.getFullYear() !== anio) return;

    const bucket = asistenciaPorMesDetalle[fecha.getMonth()];
    bucket.total++;
    if (estado === "atendida") bucket.atendidas++;
  });

  // Casos: se clasifican por la ÚLTIMA sesión de cada paciente.
  let casosRiesgo = 0;
  const conteoPrioridades = new Map();
  const casosSinSeguimiento = [];
  ultimaPorDni.forEach((ultima, dni) => {
    if (ultima.riesgo) casosRiesgo++;
    const prioridad = ultima.prioridad || "medium";
    conteoPrioridades.set(prioridad, (conteoPrioridades.get(prioridad) || 0) + 1);

    // Casos que requieren seguimiento (riesgo o aptitud restringida) sin una
    // sesión nueva hace más de umbralSeguimientoDias (configuracion.html).
    const requiereSeguimiento = ultima.riesgo || ultima.aptitud === "restricciones" || ultima.aptitud === "no_apto";
    if (!requiereSeguimiento) return;
    const fechaUltima = timestampToDate(ultima.guardadoEn);
    if (!fechaUltima) return;
    const diasSinAtender = Math.floor((ahora - fechaUltima) / (1000 * 60 * 60 * 24));
    if (diasSinAtender > umbralSeguimientoDias) {
      const ficha = fichas.get(dni);
      casosSinSeguimiento.push({ dni, nombre: ficha ? ficha.nombre : "", dias: diasSinAtender });
    }
  });
  casosSinSeguimiento.sort((a, b) => b.dias - a.dias);

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

  // Diagnóstico más frecuente por área (histórico, top 6 áreas).
  const diagnosticoTopPorArea = Array.from(diagPorArea.entries())
    .map(([area, mapa]) => {
      const top = Array.from(mapa.entries()).sort((a, b) => b[1] - a[1])[0];
      return { area, diagnostico: top[0], cuenta: top[1] };
    })
    .sort((a, b) => b.cuenta - a.cuenta)
    .slice(0, 6);

  const capacidadMes = calcularCapacidadMes(disponibilidad, anio, mes);
  const bucketMes = asistenciaPorMesDetalle[mes];

  return {
    anio: anio,
    mes: mes,
    atencionesMes: atencionesMes,
    atendidosMes: dnisMes.size,
    participacion: porcentaje(bucketMes.atendidas, bucketMes.total),
    capacidadMes: capacidadMes,
    utilizacion: porcentaje(atencionesMes, capacidadMes),
    casosActivos: dnisTotales.size,
    casosRiesgo: casosRiesgo,
    casosSinSeguimiento: casosSinSeguimiento,
    evaluadosPorMes: evaluadosPorMes.map((set) => set.size),
    asistenciaPorMes: asistenciaPorMesDetalle.map((b) => porcentaje(b.atendidas, b.total)),
    totalSesiones: sesiones.length,
    conteoAreas: conteoAreas,
    conteoPrioridades: conteoPrioridades,
    conteoDiagnosticos: conteoDiagnosticos,
    conteoDerivaciones: conteoDerivaciones,
    conteoModalidades: conteoModalidades,
    diagnosticoTopPorArea: diagnosticoTopPorArea,
    aptitudMes: aptitudMes,
    edades: edades,
    generos: generos,
    pacientesConFicha: pacientesConFicha
  };
}

// ---------- Render ----------
function renderKpis(ind) {
  document.getElementById("mes-selector").value = String(ind.mes);
  setTexto("periodo-anio", String(ind.anio));
  setTexto("kpi-atenciones-mes", String(ind.atencionesMes));
  setTexto("kpi-participacion", ind.participacion + "%");
  setTexto("kpi-atendidos-mes", String(ind.atendidosMes));
  setTexto("kpi-casos-activos", String(ind.casosActivos));
  setTexto("riskValue", String(ind.casosRiesgo));
  setTexto("kpi-capacidad", ind.utilizacion + "%");
}

function renderChartMensual(ind) {
  const contenedor = document.getElementById("chart-mensual");
  setTexto("chart-anio", String(ind.anio));
  contenedor.innerHTML = "";

  const maximo = Math.max(...ind.evaluadosPorMes, 1);
  ind.evaluadosPorMes.forEach((valor, mesIdx) => {
    contenedor.appendChild(crearColumnaMes(mesIdx, valor, maximo, mesIdx === ind.mes, ""));
  });
}

function renderChartAsistenciaMensual(ind) {
  const contenedor = document.getElementById("chart-asistencia-mensual");
  setTexto("chart-asistencia-anio", String(ind.anio));
  contenedor.innerHTML = "";

  ind.asistenciaPorMes.forEach((valor, mesIdx) => {
    contenedor.appendChild(crearColumnaMes(mesIdx, valor, 100, mesIdx === ind.mes, "%"));
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

function renderAptitudMes(ind) {
  const donut = document.getElementById("chart-aptitud-donut");
  const leyenda = document.getElementById("chart-aptitud-legend");
  leyenda.innerHTML = "";

  const total = ind.aptitudMes.apto + ind.aptitudMes.restricciones + ind.aptitudMes.no_apto;
  if (total === 0) {
    mensajeVacio(leyenda, "Sin determinaciones de aptitud en el mes elegido.");
    donut.style.background = "none";
    setTexto("aptitud-donut-value", "0");
    setTexto("aptitud-donut-label", "Casos");
    return;
  }

  const orden = ["apto", "restricciones", "no_apto"];
  let acumulado = 0;
  const segmentos = [];

  orden.forEach((clave) => {
    const cuenta = ind.aptitudMes[clave];
    if (cuenta === 0) return;
    const meta = APTITUD_META[clave];
    const pct = (cuenta / total) * 100;
    segmentos.push(meta.color + " " + acumulado + "% " + (acumulado + pct) + "%");
    acumulado += pct;

    const fila = document.createElement("div");
    fila.className = "flex items-center gap-3";
    const punto = document.createElement("span");
    punto.className = "w-4 h-4 rounded flex-shrink-0";
    punto.style.backgroundColor = meta.color;
    const textos = document.createElement("div");
    textos.className = "flex-1 flex justify-between text-body-md font-medium";
    const nombre = document.createElement("span");
    nombre.textContent = meta.label;
    const valor = document.createElement("span");
    valor.textContent = cuenta + " (" + porcentaje(cuenta, total) + "%)";
    textos.appendChild(nombre);
    textos.appendChild(valor);
    fila.appendChild(punto);
    fila.appendChild(textos);
    leyenda.appendChild(fila);
  });

  donut.style.background = "conic-gradient(" + segmentos.join(", ") + ")";
  setTexto("aptitud-donut-value", String(total));
  setTexto("aptitud-donut-label", "Casos");
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

function renderDiagnosticosPorArea(ind) {
  const contenedor = document.getElementById("chart-diag-area");
  contenedor.innerHTML = "";

  if (ind.diagnosticoTopPorArea.length === 0) {
    mensajeVacio(contenedor, "Aún no hay suficientes datos.");
    return;
  }

  ind.diagnosticoTopPorArea.forEach(({ area, diagnostico, cuenta }) => {
    const fila = document.createElement("div");
    fila.className = "flex items-center justify-between gap-3 p-3 bg-surface-container-low rounded-lg border border-outline-variant/30";

    const izquierda = document.createElement("div");
    izquierda.className = "min-w-0";
    const areaEl = document.createElement("p");
    areaEl.className = "text-label-md font-bold text-on-surface-variant uppercase tracking-wide truncate";
    areaEl.textContent = area;
    const diagEl = document.createElement("p");
    diagEl.className = "text-body-md font-semibold truncate";
    diagEl.textContent = diagnostico;
    izquierda.appendChild(areaEl);
    izquierda.appendChild(diagEl);

    const cuentaEl = document.createElement("span");
    cuentaEl.className = "text-body-md font-bold text-secondary flex-shrink-0";
    cuentaEl.textContent = String(cuenta);

    fila.appendChild(izquierda);
    fila.appendChild(cuentaEl);
    contenedor.appendChild(fila);
  });
}

function renderCasosSinSeguimiento(ind) {
  const contenedor = document.getElementById("chart-seguimiento");
  contenedor.innerHTML = "";

  if (ind.casosSinSeguimiento.length === 0) {
    mensajeVacio(contenedor, "No hay casos pendientes de seguimiento.");
    return;
  }

  ind.casosSinSeguimiento.slice(0, 8).forEach((caso) => {
    const fila = document.createElement("div");
    fila.className = "flex items-center justify-between gap-3 p-3 bg-surface-container-low rounded-lg border border-outline-variant/30";

    const nombre = document.createElement("span");
    nombre.className = "text-body-md font-medium truncate";
    nombre.textContent = caso.nombre || "DNI " + caso.dni;

    const dias = document.createElement("span");
    dias.className = "text-label-md font-bold text-error flex-shrink-0";
    dias.textContent = caso.dias + " días";

    fila.appendChild(nombre);
    fila.appendChild(dias);
    contenedor.appendChild(fila);
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
      const color = derivacion === "No requerida" ? "bg-surface-container-highest" : "bg-secondary";
      contenedor.appendChild(crearFilaBarra(derivacion, pct + "%", pct, color));
    });
}

function renderTodo(ind) {
  renderKpis(ind);
  renderChartMensual(ind);
  renderChartAsistenciaMensual(ind);
  renderChartAreas(ind);
  renderChartPrioridades(ind);
  renderAptitudMes(ind);
  renderDiagnosticos(ind);
  renderDiagnosticosPorArea(ind);
  renderCasosSinSeguimiento(ind);
  renderEdadesYGenero(ind);
  renderModalidades(ind);
  renderDerivaciones(ind);
}

// Exportar: usa la impresión del navegador (permite guardar como PDF el
// tablero tal como se ve), hasta que exista un generador de reporte formal.
document.getElementById("export-btn").addEventListener("click", () => window.print());

// ---------- Inicio (tras confirmar sesión, para que fichas no rebote) ----------
// Los datos crudos se guardan aquí; cambiar el mes solo recalcula, sin volver
// a leer Firestore.
let datosGlobales = null;
const mesSelector = document.getElementById("mes-selector");

function recalcularYRenderizar() {
  if (!datosGlobales) return;
  const mesSeleccionado = Number(mesSelector.value);
  renderTodo(
    calcularIndicadores(
      datosGlobales.sesiones,
      datosGlobales.fichas,
      datosGlobales.citas,
      datosGlobales.disponibilidad,
      mesSeleccionado,
      datosGlobales.umbralSeguimiento
    )
  );
}

mesSelector.addEventListener("change", recalcularYRenderizar);

async function inicializar() {
  try {
    const sesiones = await fetchSesiones();
    const dnis = Array.from(new Set(sesiones.map((s) => s.dni)));

    const [fichas, citas, disponibilidad, umbralSeguimiento] = await Promise.all([
      dnis.length ? fetchFichasPorDnis(dnis) : Promise.resolve(new Map()),
      fetchCitas(),
      fetchDisponibilidadCompleta(),
      fetchUmbralSeguimiento()
    ]);

    datosGlobales = { sesiones, fichas, citas, disponibilidad, umbralSeguimiento };
    mesSelector.value = String(new Date().getMonth());
    recalcularYRenderizar();
  } catch (err) {
    console.error("Error al cargar los indicadores:", err);
    [
      "chart-mensual", "chart-asistencia-mensual", "chart-areas", "chart-prioridades-legend",
      "psychContent", "chart-diag-area", "chart-seguimiento", "chart-edades", "chart-derivaciones"
    ].forEach((id) => mensajeVacio(document.getElementById(id), "No se pudieron cargar los datos."));
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) inicializar();
});
