// Importador de histórico (pacientes.html).
// Genera una plantilla Excel (.xlsx) con una sola hoja de datos ("Histórico")
// más una hoja de guía, lee el archivo llenado (.xlsx, .xls o .csv vía
// SheetJS), valida cada fila y escribe en Firestore (proyecto fb-psico).
//
// Cada fila trae una columna "tipo" que dice a dónde va:
// - "sesion" (por defecto si se deja vacío): contenido clínico completo →
//   pacientes/{dni}/sesiones.
// - "cita": solo si la persona asistió o no (si/no), SIN contenido clínico
//   (para historial viejo de inasistencias) → pacientes/{dni}/historial_citas.
//
// Decisiones de diseño:
// - Ninguna de las dos crea el documento pacientes/{dni}: así las personas
//   del histórico no aparecen como "citas" fantasma en la agenda.
// - El ID de cada fila importada es determinístico (imp-dni-fecha-n / o
//   imp-cita-dni-fecha-n): si vuelves a subir el mismo archivo, se
//   sobreescriben en vez de duplicarse.
// - Las sesiones con riesgo se importan como revisado:true, para que un
//   histórico viejo no encienda la alerta roja de la agenda.
// - Los diagnósticos aceptan CUALQUIER código CIE-10 (con o sin punto) y son
//   opcionales; sus nombres se completan automáticamente consultando el
//   catálogo público de notasalud.com al validar el archivo.
import { dbPsico, PACIENTES_COLLECTION, HISTORIAL_CITAS_SUBCOLLECTION, CONFIGURACION_COLLECTION } from "./fb-psico.js";
import { fetchFichasPorDnis } from "./fichas-cache.js";
import {
  doc,
  getDoc,
  writeBatch,
  Timestamp,
  collection,
  collectionGroup,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Columnas vigentes de la hoja "Histórico": "seguimiento" y "restricciones"
// ya no forman parte de la ficha de atención; si el archivo trae columnas
// extra, se ignoran.
// - "tipo": sesion (por defecto) o cita — decide a qué colección va la fila.
// - "asistio": solo se usa cuando tipo=cita (si/no/reprogramada); en filas
//   de tipo=sesion se ignora (la sesión siempre queda "completada").
// - "familiar*": opcionales, solo aplican a tipo=sesion, para sesiones
//   brindadas en realidad a un familiar del trabajador (mismo dato que
//   captura index.html).
const COLUMNAS = [
  "tipo", "dni", "fecha", "hora", "modalidad",
  "familiar", "familiar_nombre", "familiar_parentesco",
  "asistio", "motivo", "riesgo", "frecuencia", "prioridad",
  "derivacion", "aptitud", "evolucion", "diagnosticos", "acciones", "resultados"
];

const CIE10_API = "https://notasalud.com/buscar/cie-10";
const MAX_CODIGOS_A_RESOLVER = 80; // margen bajo el límite de 120 consultas/min de la API

// Nombres pre-cargados de los códigos más usados (evita consultas a la API).
const etiquetasCie10 = new Map([
  ["F41.1", "F41.1 - Trastorno de ansiedad generalizada"],
  ["F32.1", "F32.1 - Episodio depresivo moderado"],
  ["F43.1", "F43.1 - Trastorno de estrés postraumático"],
  ["F43.2", "F43.2 - Trastorno de adaptación"],
  ["F51.0", "F51.0 - Insomnio no orgánico"],
  ["Z73.0", "Z73.0 - Problemas relacionados con la enfermedad consuntiva"]
]);

const PRIORIDADES = { baja: "low", media: "medium", alta: "high", low: "low", medium: "medium", high: "high" };
const APTITUDES = { apto: "apto", restricciones: "restricciones", "apto con restricciones": "restricciones", "no apto": "no_apto", no_apto: "no_apto" };
const MODALIDADES_ALIAS = { presencial: "presencial", virtual: "virtual", video: "virtual", llamada: "llamada", telefono: "llamada", "teléfono": "llamada" };

// Valores válidos de "asistio" para filas de tipo "cita": si / no / y
// "reprogramada" para cuando se sabe que la cita se movió de fecha (no es un
// desenlace de asistencia — queda como "reservada", pendiente, igual que
// hace agenda.html al reprogramar en vivo: no cuenta ni a favor ni en contra
// del % de asistencia, pero sí queda en el historial de esa persona).
// Las claves ya están en minúsculas y sin tildes porque se comparan después
// de normalizarTexto().
const ASISTIO_VALIDOS = {
  si: "atendida",
  atendida: "atendida",
  asistio: "atendida",
  no: "no_asistio",
  "no asistio": "no_asistio",
  no_asistio: "no_asistio",
  reprogramada: "reservada",
  reprogramado: "reservada"
};

// Catálogos editables desde configuracion.html (colección "configuracion",
// doc "catalogos"): deben coincidir EXACTAMENTE con las opciones de
// #derivacion-select y las casillas de #acciones-checkboxes en atencion.html
// — de ahí salen los únicos valores que una sesión capturada a mano puede
// tener, así que una importación no debería poder colar algo distinto (el
// tablero de indicadores también agrupa "Derivaciones" por el texto literal).
// Estos arreglos son solo el respaldo por si el documento aún no existe.
const DERIVACIONES_DEFAULT = ["No requerida", "Psiquiatría", "Psicologia", "Neuropsicologia"];
const ACCIONES_DEFAULT = [
  "Recomendaciones compartidas verbalmente",
  "Envío de material psicoeducativo digital",
  "Pruebas psicométricas aplicadas"
];

// Quita tildes y pasa a minúsculas, para que la validación no dependa de
// mayúsculas/acentos al escribir en el Excel.
function normalizarTexto(texto) {
  return texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function construirMapaCatalogo(lista) {
  const mapa = {};
  lista.forEach((texto) => {
    mapa[normalizarTexto(texto)] = texto;
  });
  return mapa;
}

// Se refrescan antes de cada validación de archivo y antes de generar la
// plantilla, con el catálogo real; mientras tanto quedan con el respaldo.
let derivacionesValidas = construirMapaCatalogo(DERIVACIONES_DEFAULT);
let accionesValidas = construirMapaCatalogo(ACCIONES_DEFAULT);

// Una sola lectura trae ambos catálogos (viven en el mismo documento).
async function obtenerCatalogos() {
  try {
    const snap = await getDoc(doc(dbPsico, CONFIGURACION_COLLECTION, "catalogos"));
    if (snap.exists()) {
      const data = snap.data();
      return {
        derivaciones: Array.isArray(data.derivaciones) && data.derivaciones.length ? data.derivaciones : DERIVACIONES_DEFAULT,
        acciones: Array.isArray(data.acciones) && data.acciones.length ? data.acciones : ACCIONES_DEFAULT
      };
    }
  } catch (err) {
    console.warn("No se pudo cargar el catálogo; se usan las opciones por defecto:", err);
  }
  return { derivaciones: DERIVACIONES_DEFAULT, acciones: ACCIONES_DEFAULT };
}

const importToggle = document.getElementById("import-toggle");
const importBody = document.getElementById("import-body");
const importChevron = document.getElementById("import-chevron");
const downloadTemplateBtn = document.getElementById("download-template-btn");
const importFile = document.getElementById("import-file");
const importStatus = document.getElementById("import-status");
const importErrors = document.getElementById("import-errors");
const importWarnings = document.getElementById("import-warnings");
const importBtn = document.getElementById("import-btn");
const downloadReportBtn = document.getElementById("download-report-btn");

// Reporte maestro: una sola hoja con TODO lo cargado (sesiones + citas),
// mismo criterio que la plantilla (columna "tipo" en vez de dos hojas
// separadas). Dos columnas para el desenlace:
// - "estado": el dato completo — Completada (sesión), o Reservada/
//   Atendida/No Asistió (cita; "Reservada" incluye tanto una cita en vivo
//   aún pendiente como una importada como "reprogramada").
// - "asistio": la lectura rápida Sí/No — vacía cuando "estado" es
//   Reservada, porque ahí todavía no hay un desenlace de asistencia.
// Las columnas clínicas (motivo, evolución, diagnósticos, etc.) quedan
// vacías en las filas de tipo "cita", porque no tienen ese contenido.
// Mismo orden de campos que la plantilla (COLUMNAS) para las columnas que
// comparten ambas; "nombre/area/cargo/sede/telefono" (identidad, no está en
// la plantilla) van justo tras "dni", y "estado" (la versión completa de
// "asistio") va justo antes de "asistio".
const COLUMNAS_REPORTE = [
  "tipo", "dni", "nombre", "area", "cargo", "sede", "telefono", "fecha", "hora", "modalidad",
  "familiar", "familiar_nombre", "familiar_parentesco",
  "estado", "asistio", "motivo", "riesgo", "frecuencia", "prioridad",
  "derivacion", "aptitud", "evolucion", "diagnosticos", "acciones", "resultados"
];
const ESTADO_CITA_LABEL = { reservada: "Reservada", atendida: "Atendida", no_asistio: "No Asistió", reprogramada: "Reprogramada" };
const ASISTIO_CITA_LABEL = { atendida: "Sí", no_asistio: "No" };

// El teléfono vive en pacientes/{dni} (la reserva vigente), no en sesiones
// ni en historial_citas — por eso se trae aparte. OJO: pacientes/{dni} se
// sobreescribe en cada reserva nueva, así que solo se tiene el último
// número conocido de cada persona, no un historial de cambios.
async function fetchTelefonosPorDni() {
  const mapa = new Map();
  const snap = await getDocs(collection(dbPsico, PACIENTES_COLLECTION));
  snap.forEach((d) => {
    const telefono = d.data().telefonoWsp;
    if (telefono) mapa.set(d.id, telefono);
  });
  return mapa;
}

let sesionesValidas = [];
let citasValidas = [];

importToggle.addEventListener("click", () => {
  importBody.classList.toggle("hidden");
  importChevron.textContent = importBody.classList.contains("hidden") ? "expand_more" : "expand_less";
});

function sheetJsDisponible() {
  if (typeof XLSX === "undefined") {
    mostrarEstado("No se pudo cargar el componente de Excel. Revisa tu conexión a internet y recarga la página.", true);
    return false;
  }
  return true;
}

// Hoja de Excel con el ancho de columna calculado a partir del encabezado
// (usado tanto por la plantilla como por el reporte maestro).
function hojaConAnchos(filas, columnas) {
  const hoja = XLSX.utils.aoa_to_sheet(filas);
  hoja["!cols"] = columnas.map((col) => ({ wch: Math.max(col.length + 2, 14) }));
  return hoja;
}

// Filas fijas de ejemplo: casos ficticios (DNI y datos personales inventados)
// que ilustran la variedad de valores válidos por columna — distintas
// modalidades, prioridades, aptitudes, derivaciones (incluida cada una de
// las 3 no-default), varias sesiones para un mismo DNI, diagnósticos simples
// y múltiples, una sesión brindada a un familiar del trabajador, y al final
// 3 filas de tipo "cita" (sin contenido clínico) mostrando "asistio"
// si / no / reprogramada, incluida una cita de un familiar que no asistió.
const FILAS_EJEMPLO = [
  ["sesion", "10000001", "2026-05-13", "18:00", "virtual", "no", "", "", "", "", "no", "Semanal", "media", "", "apto", "Se brindan recomendaciones generales.", "", "", ""],
  ["sesion", "10000002", "2026-05-13", "10:00", "llamada", "no", "", "", "", "Refiere afectación emocional por el fallecimiento de un familiar cercano.", "no", "a demanda", "media", "", "no apto", "Se brindan recomendaciones para el manejo del proceso de duelo.", "", "", ""],
  ["sesion", "10000003", "2026-06-03", "10:00", "llamada", "no", "", "", "", "Refiere sentirse afectado emocionalmente por una pérdida reciente; primera vez que atraviesa una situación así.", "no", "Semanal", "media", "", "no apto", "Se brindan recomendaciones para el manejo del duelo; se le informa sobre grupos de apoyo voluntarios.", "", "", ""],
  ["sesion", "10000004", "2026-05-06", "08:00", "presencial", "no", "", "", "", "Refiere síntomas físicos de ansiedad y preocupación por su salud.", "no", "a demanda", "baja", "", "apto", "Se brindan recomendaciones para el manejo de la ansiedad.", "", "", ""],
  ["sesion", "10000005", "2026-06-23", "14:40", "llamada", "no", "", "", "", "Sesión de seguimiento; se registran avances y pendientes.", "no", "Quincenal", "media", "Neuropsicologia", "no apto", "Se revisan los acuerdos de la sesión anterior y se ajusta el plan de seguimiento.", "R45.8;F43.8", "Pruebas psicométricas aplicadas", "Se aplican pruebas complementarias."],
  ["sesion", "10000005", "2026-07-24", "21:59", "", "no", "", "", "", "Caso de alta prioridad; requiere seguimiento inmediato.", "si", "A demanda", "alta", "Psiquiatría", "no apto", "Se registra intervención de urgencia y coordinación con derivación especializada.", "F43.1", "Pruebas psicométricas aplicadas", "Pendiente de cierre."],
  ["sesion", "10000006", "2026-06-23", "15:00", "llamada", "no", "", "", "", "Refiere afectación emocional por el fallecimiento de un familiar.", "no", "Semanal", "baja", "Psicologia", "apto", "Se le recomienda tomarse un tiempo para procesar la pérdida junto a su familia.", "F41.2", "Recomendaciones compartidas verbalmente;Pruebas psicométricas aplicadas", "En proceso de cierre y codificación."],
  ["sesion", "10000007", "2026-07-10", "16:00", "presencial", "si", "Ana Torres", "Esposa(o)", "", "Sesión brindada al familiar del trabajador por convenio del programa de bienestar.", "no", "A demanda", "media", "", "", "Se realiza consejería breve; se orienta sobre manejo de conflictos familiares.", "", "", ""],
  ["cita", "10000010", "2026-05-04", "09:00", "presencial", "si", "Sofía Ramos", "Hermano(a)", "no", "", "", "", "", "", "", "", "", "", ""],
  ["cita", "10000011", "2026-06-02", "16:00", "llamada", "", "", "", "si", "", "", "", "", "", "", "", "", "", ""],
  ["cita", "10000012", "2026-06-10", "11:00", "presencial", "", "", "", "reprogramada", "", "", "", "", "", "", "", "", "", ""]
];

// ---------- Plantilla Excel (una hoja de datos + hoja de guía) ----------
downloadTemplateBtn.addEventListener("click", async () => {
  if (!sheetJsDisponible()) return;

  const filasDatos = [COLUMNAS, ...FILAS_EJEMPLO];
  const catalogos = await obtenerCatalogos();

  const filasGuia = [
    ["Columna", "¿Obligatorio?", "Qué poner"],
    ["tipo", "No", "sesion / cita (vacío = sesion). \"sesion\" = contenido clínico completo de una atención ya realizada. \"cita\" = solo si la persona asistió o no a un turno agendado, SIN contenido clínico (para historial viejo de inasistencias)."],
    ["dni", "SÍ", "8 dígitos. Debe existir en la app de fichas para que salgan nombre, área, edad y género."],
    ["fecha", "SÍ", "Fecha real: 2026-05-14 o 14/05/2026."],
    ["hora", "No", "Formato 10:30 (si se deja vacío y tipo=sesion, se asume 12:00)."],
    ["modalidad", "No", "presencial, virtual (o video), llamada."],
    ["familiar", "No", "si / no. Indica si la sesión o cita fue en realidad para un familiar del trabajador, no para él mismo (vacío = no). Aplica a tipo=sesion Y a tipo=cita — un no asistió o una reprogramación también pueden ser de un familiar."],
    ["familiar_nombre", "No", "Nombre del familiar (solo aplica si \"familiar\" es sí)."],
    ["familiar_parentesco", "No", "Padre, Madre, Hermano(a), Esposa(o), Hijo(a) u otro texto libre (solo aplica si \"familiar\" es sí)."],
    ["asistio", "SÍ, solo si tipo=cita", "si / no / reprogramada. No se usa en filas de tipo \"sesion\" (esas siempre quedan como sesión completada). \"reprogramada\" es para cuando sabes que la cita se movió de fecha: queda \"pendiente\" en el sistema (no cuenta ni a favor ni en contra del % de asistencia), pero sí se ve en el historial de esa persona."],
    ["motivo", "No — solo aplica a tipo=sesion", "Texto libre: motivo de consulta."],
    ["riesgo", "No — solo aplica a tipo=sesion", "si / no. Los riesgos históricos NO encienden la alerta de la agenda."],
    ["frecuencia", "No — solo aplica a tipo=sesion", "Semanal, Quincenal, Mensual, A demanda."],
    ["prioridad", "No — solo aplica a tipo=sesion", "baja / media / alta (vacío = media)."],
    ["derivacion", "No — solo aplica a tipo=sesion", catalogos.derivaciones.join(", ") + " (vacío = No requerida). Debe ser una de estas opciones exactas: son las mismas del catálogo editable en Configuración."],
    ["aptitud", "No — solo aplica a tipo=sesion", "apto / restricciones / no_apto."],
    ["evolucion", "No — solo aplica a tipo=sesion", "Texto libre: evolución y observaciones."],
    ["diagnosticos", "No — solo aplica a tipo=sesion", "Cualquier código del catálogo CIE-10, con o sin punto (F41.1 o F411), separados por ; — el nombre se completa automáticamente al importar. Puede quedar vacío."],
    ["acciones", "No — solo aplica a tipo=sesion", "Una o más, separadas por ; — deben ser del catálogo editable en Configuración: " + catalogos.acciones.join(", ") + "."],
    ["resultados", "No — solo aplica a tipo=sesion", "Texto libre. Ej.: BDI-II: 24 puntos."],
    [],
    ["Nota", "", "Una fila = una sesión o una cita, según la columna \"tipo\". Si subes el mismo archivo dos veces, se sobreescribe (no se duplica)."],
    ["Nota", "", "Las filas de ejemplo son ficticias (DNI y datos inventados) — bórralas y reemplázalas por los datos reales antes de subir el archivo."],
    ["Nota", "", "Columnas adicionales (p. ej. seguimiento o restricciones de plantillas anteriores) se ignoran."]
  ];

  const libro = XLSX.utils.book_new();
  const hojaDatos = hojaConAnchos(filasDatos, COLUMNAS);
  const hojaGuia = XLSX.utils.aoa_to_sheet(filasGuia);
  hojaGuia["!cols"] = [{ wch: 20 }, { wch: 22 }, { wch: 95 }];

  XLSX.utils.book_append_sheet(libro, hojaDatos, "Histórico");
  XLSX.utils.book_append_sheet(libro, hojaGuia, "Guía");
  XLSX.writeFile(libro, "plantilla-historico-sesiones.xlsx");
});

// ---------- Códigos CIE-10 ----------
// Normaliza "f41.1", "F411" o "F41.1 " al formato estándar con punto: F41.1.
function normalizarCodigoCie10(texto) {
  const limpio = texto.toUpperCase().replace(/[.\s]/g, "");
  return limpio.length > 3 ? limpio.slice(0, 3) + "." + limpio.slice(3) : limpio;
}

function esCodigoCie10Valido(codigoNormalizado) {
  return /^[A-Z]\d{2}(\.[\dA-Z]{1,2})?$/.test(codigoNormalizado);
}

// Completa los nombres de los códigos consultando el catálogo público.
// Si la API no responde, el código queda como etiqueta (no bloquea el import).
async function resolverEtiquetasCie10(codigos) {
  const pendientes = codigos.filter((c) => !etiquetasCie10.has(c));

  for (const codigo of pendientes.slice(0, MAX_CODIGOS_A_RESOLVER)) {
    try {
      const sinPunto = codigo.replace(".", "");
      const resp = await fetch(`${CIE10_API}?q=${encodeURIComponent(sinPunto)}&limit=5`);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const exacto = (data.results || []).find((r) => String(r.codigo).toUpperCase() === sinPunto);
      etiquetasCie10.set(codigo, exacto ? `${codigo} - ${exacto.nombre}` : codigo);
    } catch (err) {
      etiquetasCie10.set(codigo, codigo);
    }
  }

  // Si hubiera más códigos únicos que el tope, quedan con el código como nombre.
  pendientes.slice(MAX_CODIGOS_A_RESOLVER).forEach((c) => etiquetasCie10.set(c, c));
}

// ---------- Validación por fila ----------
function parseFecha(fechaTexto, horaTexto) {
  let iso = null;
  const isoMatch = fechaTexto.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const latMatch = fechaTexto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (isoMatch) iso = `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
  else if (latMatch) iso = `${latMatch[3]}-${latMatch[2].padStart(2, "0")}-${latMatch[1].padStart(2, "0")}`;
  if (!iso) return null;

  const fecha = new Date(`${iso}T${horaTexto || "12:00"}:00`);
  return Number.isNaN(fecha.getTime()) ? null : { iso, fecha };
}

function crearLectorCeldas(celdas, indices) {
  return (col) => {
    if (indices[col] < 0) return "";
    const celda = celdas[indices[col]];
    return celda === undefined || celda === null ? "" : String(celda).trim();
  };
}

// DNI (8 dígitos) o carné de extranjería / otro documento alfanumérico
// (letras y números, 8 a 12 caracteres) — se quita todo lo que no sea
// letra o número (espacios, guiones, puntos) y se pasa a mayúsculas.
function limpiarDni(valorDni) {
  return valorDni.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function esDniValido(dniLimpio) {
  return /^[A-Z0-9]{8,12}$/.test(dniLimpio);
}

// Clave de hora para IDs determinísticos: usar la hora real (no un contador
// que dependa del orden de las filas) para que reimportar el mismo archivo
// sobreescriba lo mismo aunque hayas reordenado las filas. Si dos filas del
// mismo día tuvieran la misma hora exacta, ahí sí se usa un contador aparte
// (ver secuencia en el botón de importar).
function claveHora(hora) {
  return (hora || "1200").replace(":", "");
}

// Columnas clínicas que solo tienen sentido en tipo=sesion: si aparecen
// rellenas en una fila tipo=cita, se ignoran — se avisa para que no se
// pierda el dato sin que el usuario se entere (igual que ya pasó con
// "familiar" antes de que lo soportáramos también en citas).
const COLUMNAS_CLINICAS = [
  "motivo", "riesgo", "frecuencia", "prioridad", "derivacion",
  "aptitud", "evolucion", "diagnosticos", "acciones", "resultados"
];

function advertenciaClinicaEnCita(valor, numeroFila) {
  const conDatos = COLUMNAS_CLINICAS.filter((col) => valor(col));
  if (conDatos.length === 0) return null;
  return `Fila ${numeroFila} (cita): tiene datos en "${conDatos.join('", "')}" que se van a ignorar — las filas "cita" no guardan contenido clínico. Usa tipo=sesion si quieres conservarlo.`;
}

// Fila de tipo "cita": mucho más simple, sin contenido clínico — solo el
// desenlace de la cita.
function validarFilaCita(valor, numeroFila) {
  const dni = limpiarDni(valor("dni"));
  if (!esDniValido(dni)) {
    return { error: `Fila ${numeroFila} (cita): documento inválido ("${valor("dni")}"). Debe tener de 8 a 12 letras/números.` };
  }

  const horaMatch = valor("hora").match(/(\d{1,2}):(\d{2})/);
  const hora = horaMatch ? `${horaMatch[1].padStart(2, "0")}:${horaMatch[2]}` : "";

  const fechaParseada = parseFecha(valor("fecha"), hora);
  if (!fechaParseada) return { error: `Fila ${numeroFila} (cita): fecha inválida ("${valor("fecha")}"). Usa AAAA-MM-DD o DD/MM/AAAA.` };

  const modalidadTexto = valor("modalidad").toLowerCase();
  if (modalidadTexto && !MODALIDADES_ALIAS[modalidadTexto]) {
    return { error: `Fila ${numeroFila} (cita): modalidad "${valor("modalidad")}" no válida (presencial / virtual / llamada).` };
  }

  const asistioTexto = normalizarTexto(valor("asistio"));
  const estadoCanonico = ASISTIO_VALIDOS[asistioTexto];
  if (!estadoCanonico) {
    return { error: `Fila ${numeroFila} (cita): "asistio" = "${valor("asistio")}" no válido (si / no / reprogramada).` };
  }

  // Familiar: una cita (asistida, no asistida o reprogramada) también puede
  // haber sido para un familiar del trabajador, igual que una sesión.
  const esFamiliar = ["si", "sí", "1", "true"].includes(valor("familiar").toLowerCase());
  const familiarNombre = esFamiliar ? valor("familiar_nombre") : "";
  const familiarParentesco = esFamiliar ? valor("familiar_parentesco") : "";

  const advertencias = [];
  const advertenciaClinica = advertenciaClinicaEnCita(valor, numeroFila);
  if (advertenciaClinica) advertencias.push(advertenciaClinica);
  if (esFamiliar && !familiarNombre && !familiarParentesco) {
    advertencias.push(`Fila ${numeroFila} (cita): "familiar" está en sí, pero no pusiste nombre ni parentesco — quedará marcada como familiar sin más detalle.`);
  }

  return {
    cita: {
      dni,
      fechaISO: fechaParseada.iso,
      horaISO: claveHora(hora),
      data: {
        estado: estadoCanonico,
        fecha: fechaParseada.iso,
        hora: hora || null,
        modalidad: MODALIDADES_ALIAS[modalidadTexto] || null,
        importado: true,
        esParaFamiliar: esFamiliar,
        familiarNombre: familiarNombre || null,
        familiarParentesco: familiarParentesco || null,
        registradoEn: Timestamp.fromDate(fechaParseada.fecha)
      }
    },
    advertencias: advertencias
  };
}

// Fila de tipo "sesion" (o sin "tipo", por compatibilidad): contenido
// clínico completo.
function validarFilaSesion(valor, numeroFila) {
  const dni = limpiarDni(valor("dni"));
  if (!esDniValido(dni)) {
    return { error: `Fila ${numeroFila} (sesión): documento inválido ("${valor("dni")}"). Debe tener de 8 a 12 letras/números.` };
  }

  // Excel puede entregar la hora como "10:30", "10:30:00" o con AM/PM:
  // se extrae siempre el patrón HH:MM.
  const horaMatch = valor("hora").match(/(\d{1,2}):(\d{2})/);
  const hora = horaMatch ? `${horaMatch[1].padStart(2, "0")}:${horaMatch[2]}` : "";

  const fechaParseada = parseFecha(valor("fecha"), hora);
  if (!fechaParseada) return { error: `Fila ${numeroFila} (sesión): fecha inválida ("${valor("fecha")}"). Usa AAAA-MM-DD o DD/MM/AAAA.` };

  const prioridadTexto = valor("prioridad").toLowerCase();
  if (prioridadTexto && !PRIORIDADES[prioridadTexto]) {
    return { error: `Fila ${numeroFila} (sesión): prioridad "${valor("prioridad")}" no válida (baja / media / alta).` };
  }

  const modalidadTexto = valor("modalidad").toLowerCase();
  if (modalidadTexto && !MODALIDADES_ALIAS[modalidadTexto]) {
    return { error: `Fila ${numeroFila} (sesión): modalidad "${valor("modalidad")}" no válida (presencial / virtual / llamada).` };
  }

  const aptitudTexto = valor("aptitud").toLowerCase();
  if (aptitudTexto && !APTITUDES[aptitudTexto]) {
    return { error: `Fila ${numeroFila} (sesión): aptitud "${valor("aptitud")}" no válida (apto / restricciones / no_apto).` };
  }

  const derivacionTexto = normalizarTexto(valor("derivacion"));
  if (derivacionTexto && !derivacionesValidas[derivacionTexto]) {
    return {
      error: `Fila ${numeroFila} (sesión): derivación "${valor("derivacion")}" no válida (${Object.values(derivacionesValidas).join(" / ")}).`
    };
  }

  // Diagnósticos: campo OPCIONAL. Si viene, cada código debe tener forma
  // CIE-10 (letra + números, con o sin punto). El nombre se resuelve después.
  const codigosDiagnostico = valor("diagnosticos").split(";").map((c) => c.trim()).filter(Boolean);
  const diagnosticos = [];
  for (const crudo of codigosDiagnostico) {
    const codigo = normalizarCodigoCie10(crudo);
    if (!esCodigoCie10Valido(codigo)) {
      return { error: `Fila ${numeroFila} (sesión): "${crudo}" no parece un código CIE-10 (ej.: F41.1 o F411).` };
    }
    diagnosticos.push({ codigo, label: codigo });
  }

  // Acciones: campo OPCIONAL, pero cada una debe ser del catálogo (igual
  // que en atencion.html, donde son casillas, no texto libre) — así una
  // sesión importada no puede terminar con una acción que la ficha de
  // atención nunca podría producir.
  const accionesTexto = valor("acciones").split(";").map((a) => a.trim()).filter(Boolean);
  const acciones = [];
  for (const cruda of accionesTexto) {
    const canonica = accionesValidas[normalizarTexto(cruda)];
    if (!canonica) {
      return {
        error: `Fila ${numeroFila} (sesión): acción "${cruda}" no válida (${Object.values(accionesValidas).join(" / ")}).`
      };
    }
    acciones.push(canonica);
  }

  const riesgo = ["si", "sí", "1", "true"].includes(valor("riesgo").toLowerCase());

  // Familiar: si la sesión fue en realidad para un familiar del trabajador
  // (mismo dato opcional que captura index.html). Nombre/parentesco quedan
  // en blanco si "familiar" no está marcado.
  const esFamiliar = ["si", "sí", "1", "true"].includes(valor("familiar").toLowerCase());
  const familiarNombre = esFamiliar ? valor("familiar_nombre") : "";
  const familiarParentesco = esFamiliar ? valor("familiar_parentesco") : "";

  const advertencias = [];
  if (esFamiliar && !familiarNombre && !familiarParentesco) {
    advertencias.push(`Fila ${numeroFila} (sesión): "familiar" está en sí, pero no pusiste nombre ni parentesco — quedará marcada como familiar sin más detalle.`);
  }

  return {
    sesion: {
      dni,
      fechaISO: fechaParseada.iso,
      horaISO: claveHora(hora),
      data: {
        estado: "completada",
        importado: true,
        revisado: true,
        riesgo,
        prioridad: PRIORIDADES[prioridadTexto] || "medium",
        modalidad: MODALIDADES_ALIAS[modalidadTexto] || null,
        frecuencia: valor("frecuencia"),
        motivoConsulta: valor("motivo"),
        evolucion: valor("evolucion"),
        aptitud: APTITUDES[aptitudTexto] || null,
        derivacion: derivacionTexto ? derivacionesValidas[derivacionTexto] : "No requerida",
        diagnosticos,
        accionesRealizadas: acciones,
        resultadosPruebas: valor("resultados"),
        esParaFamiliar: esFamiliar,
        familiarNombre: familiarNombre || null,
        familiarParentesco: familiarParentesco || null,
        guardadoEn: Timestamp.fromDate(fechaParseada.fecha)
      }
    },
    advertencias: advertencias
  };
}

// Punto de entrada por fila: la columna "tipo" decide si es una sesión
// (contenido clínico) o una cita (solo desenlace, sin contenido clínico).
function validarFila(celdas, indices, numeroFila) {
  const valor = crearLectorCeldas(celdas, indices);
  const tipoTexto = normalizarTexto(valor("tipo"));

  if (tipoTexto === "cita" || tipoTexto === "citas") {
    return validarFilaCita(valor, numeroFila);
  }
  if (tipoTexto && tipoTexto !== "sesion" && tipoTexto !== "sesiones") {
    return { error: `Fila ${numeroFila}: tipo "${valor("tipo")}" no válido (sesion / cita).` };
  }

  return validarFilaSesion(valor, numeroFila);
}

// ---------- Lectura y validación del archivo ----------
importFile.addEventListener("change", () => {
  const archivo = importFile.files[0];
  if (!archivo || !sheetJsDisponible()) return;

  const lector = new FileReader();
  lector.onload = async () => {
    let filas;
    try {
      const libro = XLSX.read(lector.result, { type: "array", cellDates: false });
      // Se usa la hoja "Histórico" si existe (la de la plantilla); si no, la primera.
      const nombreHoja = libro.SheetNames.includes("Histórico") ? "Histórico" : libro.SheetNames[0];
      // raw:false entrega todo como texto ya formateado (fechas como aaaa-mm-dd).
      filas = XLSX.utils.sheet_to_json(libro.Sheets[nombreHoja], { header: 1, raw: false, dateNF: "yyyy-mm-dd", defval: "" });
    } catch (err) {
      console.error("Error al leer el archivo:", err);
      mostrarEstado("No se pudo leer el archivo. ¿Es un Excel (.xlsx) o CSV válido?", true);
      return;
    }

    importErrors.innerHTML = "";
    importErrors.classList.add("hidden");
    importBtn.classList.add("hidden");
    sesionesValidas = [];
    citasValidas = [];

    const filasConDatos = filas.filter((fila) => fila.some((celda) => String(celda).trim() !== ""));
    if (filasConDatos.length < 2) {
      mostrarEstado("El archivo no tiene filas de datos.", true);
      return;
    }

    const encabezados = filasConDatos[0].map((h) => String(h).trim().toLowerCase());
    const indices = {};
    COLUMNAS.forEach((col) => {
      indices[col] = encabezados.indexOf(col);
    });

    if (indices.dni < 0 || indices.fecha < 0) {
      mostrarEstado('El encabezado debe incluir al menos las columnas "dni" y "fecha" (usa la hoja "Histórico" de la plantilla).', true);
      return;
    }

    // Catálogos vigentes (editables en configuracion.html), una sola lectura
    // por archivo validado, no por fila.
    const catalogosVigentes = await obtenerCatalogos();
    derivacionesValidas = construirMapaCatalogo(catalogosVigentes.derivaciones);
    accionesValidas = construirMapaCatalogo(catalogosVigentes.acciones);

    const errores = [];
    const advertencias = [];
    for (let i = 1; i < filasConDatos.length; i++) {
      const resultado = validarFila(filasConDatos[i], indices, i + 1);
      if (resultado.error) {
        errores.push(resultado.error);
        continue;
      }
      if (resultado.sesion) sesionesValidas.push(resultado.sesion);
      else if (resultado.cita) citasValidas.push(resultado.cita);
      if (resultado.advertencias && resultado.advertencias.length) advertencias.push(...resultado.advertencias);
    }

    // Nombres de los diagnósticos: se completan desde el catálogo CIE-10.
    const codigosUnicos = Array.from(new Set(sesionesValidas.flatMap((s) => s.data.diagnosticos.map((d) => d.codigo))));
    if (codigosUnicos.some((c) => !etiquetasCie10.has(c))) {
      mostrarEstado("Completando nombres de diagnósticos desde el catálogo CIE-10…", false);
      await resolverEtiquetasCie10(codigosUnicos);
    }
    sesionesValidas.forEach((s) => {
      s.data.diagnosticos.forEach((d) => {
        d.label = etiquetasCie10.get(d.codigo) || d.codigo;
      });
    });

    if (errores.length > 0) {
      importErrors.classList.remove("hidden");
      errores.slice(0, 15).forEach((e) => {
        const p = document.createElement("p");
        p.textContent = e;
        importErrors.appendChild(p);
      });
      if (errores.length > 15) {
        const p = document.createElement("p");
        p.textContent = `…y ${errores.length - 15} errores más.`;
        importErrors.appendChild(p);
      }
    }

    // Advertencias: la fila SÍ se importa, pero con algo que conviene saber
    // (datos clínicos que se van a ignorar, familiar sin nombre, etc.).
    if (importWarnings) {
      importWarnings.innerHTML = "";
      if (advertencias.length > 0) {
        importWarnings.classList.remove("hidden");
        advertencias.slice(0, 15).forEach((a) => {
          const p = document.createElement("p");
          p.textContent = a;
          importWarnings.appendChild(p);
        });
        if (advertencias.length > 15) {
          const p = document.createElement("p");
          p.textContent = `…y ${advertencias.length - 15} avisos más.`;
          importWarnings.appendChild(p);
        }
      } else {
        importWarnings.classList.add("hidden");
      }
    }

    const totalListas = sesionesValidas.length + citasValidas.length;
    if (totalListas > 0) {
      const partes = [];
      if (sesionesValidas.length) partes.push(`${sesionesValidas.length} sesiones`);
      if (citasValidas.length) partes.push(`${citasValidas.length} citas`);
      const detalles = [];
      if (errores.length) detalles.push(`${errores.length} filas con error serán ignoradas`);
      if (advertencias.length) detalles.push(`${advertencias.length} con avisos (revisa abajo)`);
      mostrarEstado(`${partes.join(" y ")} listas para importar` + (detalles.length ? ` (${detalles.join("; ")}).` : "."), false);
      importBtn.textContent = `Importar ${partes.join(" y ")}`;
      importBtn.classList.remove("hidden");
    } else {
      mostrarEstado("Ninguna fila pasó la validación. Corrige los errores y vuelve a subir el archivo.", true);
    }
  };
  lector.readAsArrayBuffer(archivo);
});

function mostrarEstado(mensaje, esError) {
  importStatus.textContent = mensaje;
  importStatus.className = "text-body-md font-semibold " + (esError ? "text-error" : "text-primary");
  importStatus.classList.remove("hidden");
}

// ---------- Escritura por lotes (ID determinístico = reimportar no duplica) ----------
// La clave incluye la HORA real (no solo dni+fecha) para que el ID no
// dependa del orden de las filas en el archivo: si reordenas filas de un
// mismo día al reimportar, cada una sigue apuntando a su propio documento.
// Solo si dos filas comparten dni+fecha+hora EXACTOS se usa un contador (n)
// aparte entre ellas — un caso mucho más raro que "se reordenó el archivo".
importBtn.addEventListener("click", async () => {
  if (sesionesValidas.length === 0 && citasValidas.length === 0) return;

  importBtn.disabled = true;
  const LOTE = 400; // margen bajo el límite de 500 operaciones por batch

  try {
    const secuenciaSesiones = new Map();
    for (let inicio = 0; inicio < sesionesValidas.length; inicio += LOTE) {
      const grupo = sesionesValidas.slice(inicio, inicio + LOTE);
      const batch = writeBatch(dbPsico);

      grupo.forEach((sesion) => {
        const clave = `${sesion.dni}-${sesion.fechaISO}-${sesion.horaISO}`;
        const n = (secuenciaSesiones.get(clave) || 0) + 1;
        secuenciaSesiones.set(clave, n);
        const idDoc = `imp-${clave}-${n}`;
        batch.set(doc(dbPsico, PACIENTES_COLLECTION, sesion.dni, "sesiones", idDoc), sesion.data);
      });

      mostrarEstado(`Importando sesiones… ${Math.min(inicio + LOTE, sesionesValidas.length)} de ${sesionesValidas.length}`, false);
      await batch.commit();
    }

    const secuenciaCitas = new Map();
    for (let inicio = 0; inicio < citasValidas.length; inicio += LOTE) {
      const grupo = citasValidas.slice(inicio, inicio + LOTE);
      const batch = writeBatch(dbPsico);

      grupo.forEach((cita) => {
        const clave = `${cita.dni}-${cita.fechaISO}-${cita.horaISO}`;
        const n = (secuenciaCitas.get(clave) || 0) + 1;
        secuenciaCitas.set(clave, n);
        const idDoc = `imp-cita-${clave}-${n}`;
        batch.set(doc(dbPsico, PACIENTES_COLLECTION, cita.dni, HISTORIAL_CITAS_SUBCOLLECTION, idDoc), cita.data);
      });

      mostrarEstado(`Importando citas… ${Math.min(inicio + LOTE, citasValidas.length)} de ${citasValidas.length}`, false);
      await batch.commit();
    }

    const partes = [];
    if (sesionesValidas.length) partes.push(`${sesionesValidas.length} sesiones`);
    if (citasValidas.length) partes.push(`${citasValidas.length} citas`);
    mostrarEstado(`Importación completa: ${partes.join(" y ")} guardadas. Actualizando directorio…`, false);
    importBtn.classList.add("hidden");
    importFile.value = "";
    sesionesValidas = [];
    citasValidas = [];
    window.dispatchEvent(new Event("historico-importado"));
  } catch (err) {
    console.error("Error al importar el histórico:", err);
    mostrarEstado("Error al importar: " + (err.message || "revisa la consola."), true);
  } finally {
    importBtn.disabled = false;
  }
});

// ---------- Reporte maestro: consolidado de TODO lo cargado ----------
// Dos collectionGroup queries (sesiones + historial_citas) traen todo de
// todos los pacientes de una sola vez; los datos de identidad se piden por
// lotes a través del caché compartido de fichas.js. Incluye tanto lo
// importado por Excel como lo capturado a mano en Ficha de Atención/agenda.
// Una sola hoja ("Histórico"), igual criterio que la plantilla: columna
// "tipo" (sesion/cita) en vez de hojas separadas.
downloadReportBtn.addEventListener("click", async () => {
  if (!sheetJsDisponible()) return;

  const originalHtml = downloadReportBtn.innerHTML;
  downloadReportBtn.disabled = true;
  downloadReportBtn.textContent = "Generando…";

  try {
    const [sesionesSnap, citasSnap] = await Promise.all([
      getDocs(collectionGroup(dbPsico, "sesiones")),
      getDocs(collectionGroup(dbPsico, "historial_citas"))
    ]);

    const sesiones = sesionesSnap.docs
      .filter((d) => d.id !== "borrador-actual")
      .map((d) => ({ dni: d.ref.parent.parent.id, data: d.data() }));
    const citas = citasSnap.docs.map((d) => ({ dni: d.ref.parent.parent.id, data: d.data() }));

    if (sesiones.length === 0 && citas.length === 0) {
      alert("Todavía no hay sesiones ni citas registradas para exportar.");
      return;
    }

    const dnis = Array.from(new Set([...sesiones.map((s) => s.dni), ...citas.map((c) => c.dni)]));
    const [fichas, telefonos] = await Promise.all([
      dnis.length ? fetchFichasPorDnis(dnis) : Promise.resolve(new Map()),
      fetchTelefonosPorDni()
    ]);

    // Se combinan ambas fuentes en una sola lista, cada una con su fecha
    // real (guardadoEn para sesiones, fecha+hora para citas) para poder
    // ordenarlas juntas de más reciente a más antigua en una sola hoja.
    const filas = [];

    sesiones.forEach(({ dni, data }) => {
      const ficha = fichas.get(dni) || {};
      const fechaObj = data.guardadoEn && data.guardadoEn.toDate ? data.guardadoEn.toDate() : null;

      filas.push({
        orden: fechaObj ? fechaObj.getTime() : 0,
        fila: [
          "sesion",
          dni,
          ficha.nombre || "",
          ficha.area || "",
          ficha.cargo || "",
          ficha.sede || "",
          telefonos.get(dni) || "",
          fechaObj ? fechaObj.toISOString().slice(0, 10) : "",
          fechaObj ? fechaObj.toTimeString().slice(0, 5) : "",
          data.modalidad || "",
          data.esParaFamiliar ? "si" : "no",
          data.familiarNombre || "",
          data.familiarParentesco || "",
          "Completada",
          "Sí", // una sesión guardada implica que sí hubo atención
          data.motivoConsulta || "",
          data.riesgo ? "si" : "no",
          data.frecuencia || "",
          data.prioridad || "",
          data.derivacion || "",
          data.aptitud || "",
          data.evolucion || "",
          (data.diagnosticos || []).map((d) => d.label).join("; "),
          (data.accionesRealizadas || []).join("; "),
          data.resultadosPruebas || ""
        ]
      });
    });

    citas.forEach(({ dni, data }) => {
      const ficha = fichas.get(dni) || {};
      const fechaObj = data.fecha ? new Date(`${data.fecha}T${data.hora || "00:00"}:00`) : null;

      filas.push({
        orden: fechaObj && !Number.isNaN(fechaObj.getTime()) ? fechaObj.getTime() : 0,
        // Las columnas clínicas no aplican a una cita (no tiene ese
        // contenido); quedan vacías. Familiar sí aplica (una inasistencia o
        // reprogramación también puede ser de un familiar del trabajador).
        fila: [
          "cita",
          dni,
          ficha.nombre || "",
          ficha.area || "",
          ficha.cargo || "",
          ficha.sede || "",
          telefonos.get(dni) || "",
          data.fecha || "",
          data.hora || "",
          data.modalidad || "",
          data.esParaFamiliar ? "si" : "no",
          data.familiarNombre || "",
          data.familiarParentesco || "",
          ESTADO_CITA_LABEL[data.estado] || data.estado || "",
          ASISTIO_CITA_LABEL[data.estado] || "",
          "", "", "", "", "", "", "", "", "", ""
        ]
      });
    });

    filas.sort((a, b) => b.orden - a.orden);

    const filasHoja = [COLUMNAS_REPORTE, ...filas.map((f) => f.fila)];

    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hojaConAnchos(filasHoja, COLUMNAS_REPORTE), "Histórico");

    const hoy = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(libro, `reporte-maestro-historico-${hoy}.xlsx`);
  } catch (err) {
    console.error("Error al generar el reporte maestro:", err);
    alert("No se pudo generar el reporte maestro. Revisa la consola.");
  } finally {
    downloadReportBtn.disabled = false;
    downloadReportBtn.innerHTML = originalHtml;
  }
});
