// Importador de histórico de sesiones (pacientes.html).
// Genera una plantilla Excel (.xlsx) con hoja de guía, lee el archivo llenado
// (.xlsx, .xls o .csv vía SheetJS), valida cada fila y escribe las sesiones
// en pacientes/{dni}/sesiones del proyecto fb-psico.
//
// Decisiones de diseño:
// - NO crea el documento pacientes/{dni}: así las personas del histórico no
//   aparecen como "citas" fantasma en la agenda. El directorio, el historial
//   y los indicadores las encuentran igual a través de sus sesiones.
// - El ID de cada sesión importada es determinístico (imp-dni-fecha-n): si
//   vuelves a subir el mismo archivo, se sobreescriben en vez de duplicarse.
// - Las sesiones con riesgo se importan como revisado:true, para que un
//   histórico viejo no encienda la alerta roja de la agenda.
// - Los diagnósticos aceptan CUALQUIER código CIE-10 (con o sin punto) y son
//   opcionales; sus nombres se completan automáticamente consultando el
//   catálogo público de notasalud.com al validar el archivo.
import { dbPsico, PACIENTES_COLLECTION, CONFIGURACION_COLLECTION } from "./fb-psico.js";
import { fetchFichasPorDnis } from "./fichas-cache.js";
import {
  doc,
  getDoc,
  writeBatch,
  Timestamp,
  collectionGroup,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Columnas vigentes: "seguimiento" y "restricciones" ya no forman parte de la
// ficha de atención; si el archivo trae columnas extra, se ignoran.
const COLUMNAS = [
  "dni", "fecha", "hora", "modalidad", "riesgo", "prioridad", "frecuencia",
  "motivo", "evolucion", "aptitud", "derivacion", "diagnosticos", "acciones", "resultados"
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

// Catálogo de derivaciones: editable desde configuracion.html (colección
// "configuracion", doc "catalogos"). Debe coincidir EXACTAMENTE con las
// opciones de #derivacion-select en atencion.html: el tablero de indicadores
// agrupa el gráfico "Derivaciones" por el texto literal, así que un valor
// distinto crearía una barra aparte. Este es solo el respaldo por si el
// documento de Firestore aún no existe.
const DERIVACIONES_DEFAULT = ["No requerida", "Psiquiatría", "Psicologia", "Neuropsicologia"];

// Quita tildes y pasa a minúsculas, para que la validación no dependa de
// mayúsculas/acentos al escribir en el Excel.
function normalizarTexto(texto) {
  return texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function construirMapaDerivaciones(lista) {
  const mapa = {};
  lista.forEach((texto) => {
    mapa[normalizarTexto(texto)] = texto;
  });
  return mapa;
}

// Se refresca antes de cada validación de archivo y antes de generar la
// plantilla, con el catálogo real; mientras tanto queda con el respaldo.
let derivacionesValidas = construirMapaDerivaciones(DERIVACIONES_DEFAULT);

async function obtenerCatalogoDerivaciones() {
  try {
    const snap = await getDoc(doc(dbPsico, CONFIGURACION_COLLECTION, "catalogos"));
    if (snap.exists() && Array.isArray(snap.data().derivaciones) && snap.data().derivaciones.length) {
      return snap.data().derivaciones;
    }
  } catch (err) {
    console.warn("No se pudo cargar el catálogo de derivaciones; se usan las opciones por defecto:", err);
  }
  return DERIVACIONES_DEFAULT;
}

const importToggle = document.getElementById("import-toggle");
const importBody = document.getElementById("import-body");
const importChevron = document.getElementById("import-chevron");
const downloadTemplateBtn = document.getElementById("download-template-btn");
const importFile = document.getElementById("import-file");
const importStatus = document.getElementById("import-status");
const importErrors = document.getElementById("import-errors");
const importBtn = document.getElementById("import-btn");
const downloadReportBtn = document.getElementById("download-report-btn");

// Mismo orden que COLUMNAS, más los datos de identidad que salen de la ficha
// social (proyecto autenticado): así el reporte se puede leer solo, sin
// tener que cruzar el DNI a mano contra otro sistema.
const COLUMNAS_REPORTE = [
  "dni", "nombre", "area", "cargo", "sede", "fecha", "hora", "estado",
  "modalidad", "riesgo", "prioridad", "frecuencia", "motivo", "evolucion",
  "aptitud", "derivacion", "diagnosticos", "acciones", "resultados"
];

let sesionesValidas = [];

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
// y múltiples, y filas con campos opcionales vacíos.
const FILAS_EJEMPLO = [
  ["10000001", "2026-05-13", "18:00", "virtual", "no", "media", "Semanal", "", "Se brindan recomendaciones generales.", "apto", "", "", "", ""],
  ["10000002", "2026-05-13", "10:00", "llamada", "no", "media", "a demanda", "Refiere afectación emocional por el fallecimiento de un familiar cercano.", "Se brindan recomendaciones para el manejo del proceso de duelo.", "no apto", "", "", "", ""],
  ["10000003", "2026-06-03", "10:00", "llamada", "no", "media", "Semanal", "Refiere sentirse afectado emocionalmente por una pérdida reciente; primera vez que atraviesa una situación así.", "Se brindan recomendaciones para el manejo del duelo; se le informa sobre grupos de apoyo voluntarios.", "no apto", "", "", "", ""],
  ["10000004", "2026-05-06", "08:00", "presencial", "no", "baja", "a demanda", "Refiere síntomas físicos de ansiedad y preocupación por su salud.", "Se brindan recomendaciones para el manejo de la ansiedad.", "apto", "", "", "", ""],
  ["10000005", "2026-06-23", "14:40", "llamada", "no", "media", "Quincenal", "Sesión de seguimiento; se registran avances y pendientes.", "Se revisan los acuerdos de la sesión anterior y se ajusta el plan de seguimiento.", "no apto", "Neuropsicologia", "R45.8;F43.8", "Pruebas psicométricas aplicadas", "Se aplican pruebas complementarias."],
  ["10000005", "2026-07-24", "21:59", "", "si", "alta", "A demanda", "Caso de alta prioridad; requiere seguimiento inmediato.", "Se registra intervención de urgencia y coordinación con derivación especializada.", "no apto", "Psiquiatría", "F43.1", "Pruebas psicométricas aplicadas", "Pendiente de cierre."],
  ["10000006", "2026-06-23", "15:00", "llamada", "no", "baja", "Semanal", "Refiere afectación emocional por el fallecimiento de un familiar.", "Se le recomienda tomarse un tiempo para procesar la pérdida junto a su familia.", "apto", "Psicologia", "F41.2", "Recomendaciones compartidas verbalmente;Pruebas psicométricas aplicadas", "En proceso de cierre y codificación."]
];

// ---------- Plantilla Excel (hoja de datos + hoja de guía) ----------
downloadTemplateBtn.addEventListener("click", async () => {
  if (!sheetJsDisponible()) return;

  const filasSesiones = [COLUMNAS, ...FILAS_EJEMPLO];
  const catalogoDerivaciones = await obtenerCatalogoDerivaciones();

  const filasGuia = [
    ["Columna", "¿Obligatorio?", "Qué poner"],
    ["dni", "SÍ", "8 dígitos. Debe existir en la app de fichas para que salgan nombre, área, edad y género."],
    ["fecha", "SÍ", "Fecha real de la sesión: 2026-05-14 o 14/05/2026."],
    ["hora", "No", "Formato 10:30 (si se deja vacío, se asume 12:00)."],
    ["modalidad", "No", "presencial, virtual (o video), llamada."],
    ["riesgo", "No", "si / no. Los riesgos históricos NO encienden la alerta de la agenda."],
    ["prioridad", "No", "baja / media / alta (vacío = media)."],
    ["frecuencia", "No", "Semanal, Quincenal, Mensual, A demanda."],
    ["motivo", "No", "Texto libre: motivo de consulta."],
    ["evolucion", "No", "Texto libre: evolución y observaciones."],
    ["aptitud", "No", "apto / restricciones / no_apto."],
    ["derivacion", "No", catalogoDerivaciones.join(", ") + " (vacío = No requerida). Debe ser una de estas opciones exactas: son las mismas del catálogo editable en Configuración."],
    ["diagnosticos", "No", "Cualquier código del catálogo CIE-10, con o sin punto (F41.1 o F411), separados por ; — el nombre se completa automáticamente al importar. Puede quedar vacío."],
    ["acciones", "No", "Separadas por ; — Ej.: Recomendaciones compartidas verbalmente; Pruebas psicométricas aplicadas."],
    ["resultados", "No", "Texto libre. Ej.: BDI-II: 24 puntos."],
    [],
    ["Nota", "", "Una fila = una sesión. Si subes el mismo archivo dos veces, las sesiones se sobreescriben (no se duplican)."],
    ["Nota", "", "Las filas de ejemplo son ficticias (DNI y datos inventados) — bórralas y reemplázalas por los datos reales antes de subir el archivo."],
    ["Nota", "", "Columnas adicionales (p. ej. seguimiento o restricciones de plantillas anteriores) se ignoran."]
  ];

  const libro = XLSX.utils.book_new();
  const hojaSesiones = hojaConAnchos(filasSesiones, COLUMNAS);
  const hojaGuia = XLSX.utils.aoa_to_sheet(filasGuia);
  hojaGuia["!cols"] = [{ wch: 14 }, { wch: 14 }, { wch: 95 }];

  XLSX.utils.book_append_sheet(libro, hojaSesiones, "Sesiones");
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

function validarFila(celdas, indices, numeroFila) {
  const valor = (col) => {
    if (indices[col] < 0) return "";
    const celda = celdas[indices[col]];
    return celda === undefined || celda === null ? "" : String(celda).trim();
  };

  const dni = valor("dni").replace(/\D/g, "");
  if (!/^\d{8,9}$/.test(dni)) return { error: `Fila ${numeroFila}: DNI inválido ("${valor("dni")}").` };

  // Excel puede entregar la hora como "10:30", "10:30:00" o con AM/PM:
  // se extrae siempre el patrón HH:MM.
  const horaMatch = valor("hora").match(/(\d{1,2}):(\d{2})/);
  const hora = horaMatch ? `${horaMatch[1].padStart(2, "0")}:${horaMatch[2]}` : "";

  const fechaParseada = parseFecha(valor("fecha"), hora);
  if (!fechaParseada) return { error: `Fila ${numeroFila}: fecha inválida ("${valor("fecha")}"). Usa AAAA-MM-DD o DD/MM/AAAA.` };

  const prioridadTexto = valor("prioridad").toLowerCase();
  if (prioridadTexto && !PRIORIDADES[prioridadTexto]) {
    return { error: `Fila ${numeroFila}: prioridad "${valor("prioridad")}" no válida (baja / media / alta).` };
  }

  const modalidadTexto = valor("modalidad").toLowerCase();
  if (modalidadTexto && !MODALIDADES_ALIAS[modalidadTexto]) {
    return { error: `Fila ${numeroFila}: modalidad "${valor("modalidad")}" no válida (presencial / virtual / llamada).` };
  }

  const aptitudTexto = valor("aptitud").toLowerCase();
  if (aptitudTexto && !APTITUDES[aptitudTexto]) {
    return { error: `Fila ${numeroFila}: aptitud "${valor("aptitud")}" no válida (apto / restricciones / no_apto).` };
  }

  const derivacionTexto = normalizarTexto(valor("derivacion"));
  if (derivacionTexto && !derivacionesValidas[derivacionTexto]) {
    return {
      error: `Fila ${numeroFila}: derivación "${valor("derivacion")}" no válida (${Object.values(derivacionesValidas).join(" / ")}).`
    };
  }

  // Diagnósticos: campo OPCIONAL. Si viene, cada código debe tener forma
  // CIE-10 (letra + números, con o sin punto). El nombre se resuelve después.
  const codigosDiagnostico = valor("diagnosticos").split(";").map((c) => c.trim()).filter(Boolean);
  const diagnosticos = [];
  for (const crudo of codigosDiagnostico) {
    const codigo = normalizarCodigoCie10(crudo);
    if (!esCodigoCie10Valido(codigo)) {
      return { error: `Fila ${numeroFila}: "${crudo}" no parece un código CIE-10 (ej.: F41.1 o F411).` };
    }
    diagnosticos.push({ codigo, label: codigo });
  }

  const acciones = valor("acciones").split(";").map((a) => a.trim()).filter(Boolean);
  const riesgo = ["si", "sí", "1", "true"].includes(valor("riesgo").toLowerCase());

  return {
    sesion: {
      dni,
      fechaISO: fechaParseada.iso,
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
        guardadoEn: Timestamp.fromDate(fechaParseada.fecha)
      }
    }
  };
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
      // Se usa la hoja "Sesiones" si existe (la de la plantilla); si no, la primera.
      const nombreHoja = libro.SheetNames.includes("Sesiones") ? "Sesiones" : libro.SheetNames[0];
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
      mostrarEstado('El encabezado debe incluir al menos las columnas "dni" y "fecha" (usa la hoja "Sesiones" de la plantilla).', true);
      return;
    }

    // Catálogo de derivaciones vigente (editable en configuracion.html), una
    // sola lectura por archivo validado, no por fila.
    derivacionesValidas = construirMapaDerivaciones(await obtenerCatalogoDerivaciones());

    const errores = [];
    for (let i = 1; i < filasConDatos.length; i++) {
      const resultado = validarFila(filasConDatos[i], indices, i + 1);
      if (resultado.error) errores.push(resultado.error);
      else sesionesValidas.push(resultado.sesion);
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

    if (sesionesValidas.length > 0) {
      mostrarEstado(
        `${sesionesValidas.length} sesiones listas para importar` +
          (errores.length ? ` (${errores.length} filas con error serán ignoradas).` : "."),
        false
      );
      importBtn.textContent = `Importar ${sesionesValidas.length} sesiones`;
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
importBtn.addEventListener("click", async () => {
  if (sesionesValidas.length === 0) return;

  importBtn.disabled = true;
  const LOTE = 400; // margen bajo el límite de 500 operaciones por batch
  const secuencia = new Map();

  try {
    for (let inicio = 0; inicio < sesionesValidas.length; inicio += LOTE) {
      const grupo = sesionesValidas.slice(inicio, inicio + LOTE);
      const batch = writeBatch(dbPsico);

      grupo.forEach((sesion) => {
        const claveDia = `${sesion.dni}-${sesion.fechaISO}`;
        const n = (secuencia.get(claveDia) || 0) + 1;
        secuencia.set(claveDia, n);
        const idDoc = `imp-${claveDia}-${n}`;
        batch.set(doc(dbPsico, PACIENTES_COLLECTION, sesion.dni, "sesiones", idDoc), sesion.data);
      });

      mostrarEstado(`Importando… ${Math.min(inicio + LOTE, sesionesValidas.length)} de ${sesionesValidas.length}`, false);
      await batch.commit();
    }

    mostrarEstado(`Importación completa: ${sesionesValidas.length} sesiones guardadas. Actualizando directorio…`, false);
    importBtn.classList.add("hidden");
    importFile.value = "";
    sesionesValidas = [];
    window.dispatchEvent(new Event("historico-importado"));
  } catch (err) {
    console.error("Error al importar el histórico:", err);
    mostrarEstado("Error al importar: " + (err.message || "revisa la consola."), true);
  } finally {
    importBtn.disabled = false;
  }
});

// ---------- Reporte maestro: consolidado de TODO lo cargado ----------
// Una sola collectionGroup query trae las sesiones de todos los pacientes
// (igual que en pacientes.js/agenda.js); los datos de identidad se piden por
// lotes a través del caché compartido de fichas.js. Incluye tanto lo
// importado por Excel como lo capturado a mano en Ficha de Atención.
downloadReportBtn.addEventListener("click", async () => {
  if (!sheetJsDisponible()) return;

  const originalHtml = downloadReportBtn.innerHTML;
  downloadReportBtn.disabled = true;
  downloadReportBtn.textContent = "Generando…";

  try {
    const snap = await getDocs(collectionGroup(dbPsico, "sesiones"));
    const sesiones = snap.docs
      .filter((d) => d.id !== "borrador-actual")
      .map((d) => ({ dni: d.ref.parent.parent.id, data: d.data() }));

    if (sesiones.length === 0) {
      alert("Todavía no hay sesiones registradas para exportar.");
      return;
    }

    const dnis = Array.from(new Set(sesiones.map((s) => s.dni)));
    const fichas = await fetchFichasPorDnis(dnis);

    sesiones.sort((a, b) => {
      const fa = a.data.guardadoEn && a.data.guardadoEn.toDate ? a.data.guardadoEn.toDate().getTime() : 0;
      const fb = b.data.guardadoEn && b.data.guardadoEn.toDate ? b.data.guardadoEn.toDate().getTime() : 0;
      return fb - fa;
    });

    const filas = [COLUMNAS_REPORTE];
    sesiones.forEach(({ dni, data }) => {
      const ficha = fichas.get(dni) || {};
      const fechaObj = data.guardadoEn && data.guardadoEn.toDate ? data.guardadoEn.toDate() : null;

      filas.push([
        dni,
        ficha.nombre || "",
        ficha.area || "",
        ficha.cargo || "",
        ficha.sede || "",
        fechaObj ? fechaObj.toISOString().slice(0, 10) : "",
        fechaObj ? fechaObj.toTimeString().slice(0, 5) : "",
        data.estado === "borrador" ? "Borrador" : "Completada",
        data.modalidad || "",
        data.riesgo ? "si" : "no",
        data.prioridad || "",
        data.frecuencia || "",
        data.motivoConsulta || "",
        data.evolucion || "",
        data.aptitud || "",
        data.derivacion || "",
        (data.diagnosticos || []).map((d) => d.label).join("; "),
        (data.accionesRealizadas || []).join("; "),
        data.resultadosPruebas || ""
      ]);
    });

    const libro = XLSX.utils.book_new();
    const hoja = hojaConAnchos(filas, COLUMNAS_REPORTE);
    XLSX.utils.book_append_sheet(libro, hoja, "Historial Completo");

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
