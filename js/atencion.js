// Lógica propia de la Ficha de Atención (V4).
// El encabezado del paciente se llena solo: el DNI llega por la URL
// (?dni=... desde agenda.html). Los datos personales/laborales salen de la
// ficha social (proyecto de firebase-config.js, lectura autenticada); la
// fecha/hora de la cita sale del registro público (proyecto de fb-psico.js).
import { auth } from "./firebase-config.js";
import { fetchFicha } from "./fichas-cache.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  collection,
  query,
  orderBy,
  getDocs,
  setDoc,
  addDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { dbPsico, PACIENTES_COLLECTION, CONFIGURACION_COLLECTION, HISTORIAL_CITAS_SUBCOLLECTION, registrarHistorialCita } from "./fb-psico.js";

// Catálogos editables desde configuracion.html; estos son solo el respaldo
// por si el documento de Firestore aún no existe (primera vez).
const DERIVACIONES_DEFAULT = ["No requerida", "Psiquiatría", "Psicologia", "Neuropsicologia"];
const ACCIONES_DEFAULT = [
  "Recomendaciones compartidas verbalmente",
  "Envío de material psicoeducativo digital",
  "Pruebas psicométricas aplicadas"
];

// Llena el <select> de Derivación y las casillas de Acciones Realizadas con
// el catálogo guardado en configuracion.html. Se espera a que termine antes
// de precargar cualquier sesión (borrador o edición), para que los valores
// guardados encuentren su opción ya creada en el DOM.
async function cargarCatalogos() {
  let derivaciones = DERIVACIONES_DEFAULT;
  let acciones = ACCIONES_DEFAULT;

  try {
    const snap = await getDoc(doc(dbPsico, CONFIGURACION_COLLECTION, "catalogos"));
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.derivaciones) && data.derivaciones.length) derivaciones = data.derivaciones;
      if (Array.isArray(data.acciones) && data.acciones.length) acciones = data.acciones;
    }
  } catch (err) {
    console.warn("No se pudo cargar el catálogo; se usan las opciones por defecto:", err);
  }

  var derivacionSelect = document.getElementById("derivacion-select");
  derivacionSelect.innerHTML = "";
  derivaciones.forEach(function (texto) {
    var option = document.createElement("option");
    option.textContent = texto;
    derivacionSelect.appendChild(option);
  });

  var accionesContenedor = document.getElementById("acciones-checkboxes");
  accionesContenedor.innerHTML = "";
  acciones.forEach(function (texto) {
    var label = document.createElement("label");
    label.className = "flex items-center gap-3 cursor-pointer group";
    var checkbox = document.createElement("input");
    checkbox.className = "w-5 h-5 rounded border-outline-variant text-secondary focus:ring-secondary";
    checkbox.type = "checkbox";
    checkbox.value = texto;
    var span = document.createElement("span");
    span.className = "text-body-md group-hover:text-primary transition-colors";
    span.textContent = texto;
    label.appendChild(checkbox);
    label.appendChild(span);
    accionesContenedor.appendChild(label);
  });
}

const patientInitials = document.getElementById("patient-initials");
const patientName = document.getElementById("patient-name");
const patientAge = document.getElementById("patient-age");
const patientArea = document.getElementById("patient-area");
const patientCargo = document.getElementById("patient-cargo");
const patientSede = document.getElementById("patient-sede");
const patientSession = document.getElementById("patient-session");
const patientDatetime = document.getElementById("patient-datetime");

// Cita vigente del paciente (para copiar su modalidad a la sesión guardada).
let citaActual = null;

function getInitials(fullName) {
  return fullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function calcularEdad(fechaNacimiento) {
  const nacimiento = new Date(fechaNacimiento);
  if (!fechaNacimiento || Number.isNaN(nacimiento.getTime())) return null;

  const hoy = new Date();
  let edad = hoy.getFullYear() - nacimiento.getFullYear();
  const noHaCumplidoAun =
    hoy.getMonth() < nacimiento.getMonth() ||
    (hoy.getMonth() === nacimiento.getMonth() && hoy.getDate() < nacimiento.getDate());
  if (noHaCumplidoAun) edad -= 1;

  return edad;
}

function renderFichaSocial(ficha) {
  const nombreCompleto = ficha.nombre || "Sin nombre registrado";

  patientInitials.textContent = getInitials(nombreCompleto) || "—";
  patientName.textContent = nombreCompleto;

  const edad = calcularEdad(ficha.nacimiento);
  patientAge.textContent = edad !== null ? `${edad} años` : "—";
  patientArea.textContent = ficha.area || "—";
  patientCargo.textContent = ficha.cargo || "—";
  patientSede.textContent = ficha.sede || "—";
}

async function fetchCita(dni) {
  const snap = await getDoc(doc(dbPsico, PACIENTES_COLLECTION, dni));
  return snap.exists() ? snap.data() : null;
}

// Recupera SOLO el borrador a medio guardar (si existe). Las sesiones ya
// cerradas no se precargan: una atención nueva arranca con el formulario en
// blanco, y lo anterior se consulta en el panel "Historial de Sesiones".
async function fetchBorrador(dniValue) {
  const borradorSnap = await getDoc(doc(sesionesCollection(dniValue), "borrador-actual"));
  return borradorSnap.exists() ? borradorSnap.data() : null;
}

// Todas las sesiones guardadas para este DNI, agrupadas y ordenadas de más
// reciente a más antigua, para el panel "Historial de Sesiones".
async function fetchHistorialSesiones(dniValue) {
  const historialQuery = query(sesionesCollection(dniValue), orderBy("guardadoEn", "desc"));
  const snap = await getDocs(historialQuery);
  return snap.docs.map(function (d) {
    return Object.assign({ id: d.id }, d.data());
  });
}

// Historial de citas (reservada/no_asistio/reprogramada/atendida) de este
// DNI: a diferencia de "Historial de Sesiones" (contenido clínico), esto es
// el registro de asistencia real — cada evento queda para siempre, aunque
// pacientes/{dni} se sobreescriba en cada reserva nueva.
function citasCollection(dniValue) {
  return collection(dbPsico, PACIENTES_COLLECTION, dniValue, HISTORIAL_CITAS_SUBCOLLECTION);
}

async function fetchHistorialCitas(dniValue) {
  const citasQuery = query(citasCollection(dniValue), orderBy("registradoEn", "desc"));
  const snap = await getDocs(citasQuery);
  return snap.docs.map(function (d) {
    return d.data();
  });
}

function formatFechaGuardado(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== "function") return "—";
  return timestamp.toDate().toLocaleString("es-PE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildHistorialItem(data) {
  var item = document.createElement("div");
  item.className = "border border-outline-variant rounded-lg overflow-hidden";

  var estadoBadge =
    data.estado === "borrador"
      ? '<span class="bg-orange-100 text-orange-800 text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider">Borrador</span>'
      : '<span class="bg-green-100 text-green-800 text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider">Completada</span>';

  var riesgoBadge = data.riesgo
    ? '<span class="bg-error-container text-on-error-container text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider">Riesgo</span>'
    : "";

  // "Familiar" es una etiqueta fija (segura); el nombre y parentesco vienen
  // del formulario público sin autenticar, así que se llenan aparte con
  // textContent (ver más abajo) y nunca se interpolan en este HTML.
  var familiarBadge = data.esParaFamiliar
    ? '<span class="bg-secondary-fixed text-on-secondary-fixed-variant text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider">Familiar</span>'
    : "";
  var familiarDetalleHtml = data.esParaFamiliar
    ? '<p><strong>Atendido:</strong> <span data-familiar-detalle></span></p>'
    : "";

  var diagnosticosTexto = (data.diagnosticos || []).map(function (d) { return d.label; }).join(", ") || "—";
  var accionesTexto = (data.accionesRealizadas || []).join(", ") || "—";

  item.innerHTML =
    '<button type="button" class="historial-item-toggle w-full flex items-center justify-between gap-3 p-3 hover:bg-surface-container-low transition-colors text-left">' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<span class="font-body-md font-semibold text-primary">' + formatFechaGuardado(data.guardadoEn) + '</span>' +
        estadoBadge + riesgoBadge + familiarBadge +
      "</div>" +
      '<span class="material-symbols-outlined text-on-surface-variant text-[20px]">expand_more</span>' +
    "</button>" +
    '<div class="hidden border-t border-outline-variant p-4 space-y-2 text-body-md">' +
      familiarDetalleHtml +
      "<p><strong>Motivo:</strong> " + (data.motivoConsulta || "—") + "</p>" +
      "<p><strong>Evolución:</strong> " + (data.evolucion || "—") + "</p>" +
      "<p><strong>Frecuencia:</strong> " + (data.frecuencia || "—") + " · <strong>Prioridad:</strong> " + (data.prioridad || "—") + "</p>" +
      "<p><strong>Aptitud:</strong> " + (data.aptitud || "—") + "</p>" +
      "<p><strong>Derivación:</strong> " + (data.derivacion || "—") + "</p>" +
      "<p><strong>Diagnósticos:</strong> " + diagnosticosTexto + "</p>" +
      "<p><strong>Acciones realizadas:</strong> " + accionesTexto + "</p>" +
      "<p><strong>Resultados de pruebas:</strong> " + (data.resultadosPruebas || "—") + "</p>" +
      '<div class="pt-2">' +
        '<button type="button" class="historial-edit-btn flex items-center gap-2 text-secondary font-semibold text-body-md hover:underline">' +
          '<span class="material-symbols-outlined text-lg">edit</span> Editar esta sesión' +
        "</button>" +
      "</div>" +
    "</div>";

  if (data.esParaFamiliar) {
    var detalleEl = item.querySelector("[data-familiar-detalle]");
    if (detalleEl) {
      var partes = [data.familiarNombre, data.familiarParentesco].filter(Boolean).join(" — ");
      detalleEl.textContent = partes || "Familiar (sin nombre registrado)";
    }
  }

  item.querySelector(".historial-item-toggle").addEventListener("click", function () {
    item.lastElementChild.classList.toggle("hidden");
  });

  item.querySelector(".historial-edit-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    iniciarEdicionSesion(data);
  });

  return item;
}

function renderHistorial(sesiones) {
  var historialCount = document.getElementById("historial-count");
  var historialList = document.getElementById("historial-list");

  historialCount.textContent = "(" + sesiones.length + ")";
  historialList.innerHTML = "";

  if (sesiones.length === 0) {
    historialList.innerHTML = '<p class="text-body-md text-on-surface-variant">Todavía no hay sesiones guardadas para este DNI.</p>';
    return;
  }

  sesiones.forEach(function (sesion) {
    historialList.appendChild(buildHistorialItem(sesion));
  });
}

async function refreshHistorial(dniValue) {
  if (!dniValue) return;
  try {
    renderHistorial(await fetchHistorialSesiones(dniValue));
  } catch (err) {
    console.error("Error al cargar el historial de sesiones:", err);
  }
}

var ESTADO_CITA_META = {
  atendida: { label: "Atendida", badge: "bg-green-100 text-green-800", texto: "text-on-surface-variant" },
  no_asistio: { label: "No Asistió", badge: "bg-error-container text-on-error-container", texto: "text-error" },
  reprogramada: { label: "Reprogramada", badge: "bg-orange-100 text-orange-800", texto: "text-orange-700" },
  reservada: { label: "Reservada", badge: "bg-secondary-fixed text-on-secondary-fixed-variant", texto: "text-secondary" }
};

// Resumen rápido (badges) arriba de "Historial de Citas": cuenta solo los
// desenlaces (reservada no es un desenlace, no suma aquí).
function renderCitasResumen(citas) {
  var contenedor = document.getElementById("citas-historial-resumen");
  contenedor.innerHTML = "";

  if (citas.length === 0) {
    contenedor.innerHTML = '<p class="text-body-md text-on-surface-variant">Todavía no hay citas registradas para este DNI.</p>';
    return;
  }

  var conteo = { atendida: 0, no_asistio: 0, reprogramada: 0 };
  citas.forEach(function (cita) {
    if (Object.prototype.hasOwnProperty.call(conteo, cita.estado)) conteo[cita.estado]++;
  });

  ["atendida", "no_asistio", "reprogramada"].forEach(function (clave) {
    if (conteo[clave] === 0) return;
    var meta = ESTADO_CITA_META[clave];
    var badge = document.createElement("span");
    badge.className = "text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider " + meta.badge;
    badge.textContent = conteo[clave] + " " + meta.label + (conteo[clave] > 1 && clave !== "no_asistio" ? "s" : "");
    contenedor.appendChild(badge);
  });
}

// Cada vez que aparece un evento "reservada" empieza un ciclo de cita nuevo;
// los eventos siguientes (no_asistio/reprogramada/atendida) de esa misma
// cita quedan con el mismo número, hasta la próxima "reservada". También se
// abre un ciclo nuevo si cambia entre "propia" y "familiar" (o entre dos
// familiares distintos) — una cita del trabajador y una de su familiar son
// hilos distintos, aunque estén una al lado de la otra en el tiempo, así
// que nunca deben compartir el mismo número. Se recorre en orden
// cronológico real (registradoEn ascendente) para detectar los cortes
// correctamente, sin importar en qué orden se vaya a mostrar después.
function asignarCiclosDeCita(citas) {
  var ascendente = citas.slice().sort(function (a, b) {
    var ta = a.registradoEn && a.registradoEn.toDate ? a.registradoEn.toDate().getTime() : 0;
    var tb = b.registradoEn && b.registradoEn.toDate ? b.registradoEn.toDate().getTime() : 0;
    return ta - tb;
  });

  var ciclo = 0;
  var quienAnterior = null;
  ascendente.forEach(function (cita) {
    // "quién" identifica el hilo: el trabajador mismo, o un familiar en
    // particular (por nombre, ya que es lo único que los distingue).
    var quienActual = cita.esParaFamiliar ? "familiar:" + (cita.familiarNombre || "") : "propia";
    var cambioDeHilo = quienAnterior !== null && quienActual !== quienAnterior;
    if (cita.estado === "reservada" || ciclo === 0 || cambioDeHilo) ciclo++;
    cita.ciclo = ciclo;
    quienAnterior = quienActual;
  });
}

// Línea de tiempo detallada (colapsable): un renglón por cada evento tal
// cual se guardó (una cita puede pasar por varios estados — reservada →
// no_asistio → reprogramada → atendida — y cada uno es un documento
// distinto), agrupados visualmente por ciclo de cita.
function renderCitasHistorial(citas) {
  var lista = document.getElementById("citas-historial-list");
  lista.innerHTML = "";

  asignarCiclosDeCita(citas);

  var ultimoCiclo = null;
  citas.forEach(function (cita, indice) {
    var meta = ESTADO_CITA_META[cita.estado] || { label: cita.estado || "—", texto: "text-on-surface-variant" };
    var esNuevoCiclo = indice > 0 && cita.ciclo !== ultimoCiclo;
    ultimoCiclo = cita.ciclo;

    var fila = document.createElement("div");
    fila.className =
      "flex items-center justify-between gap-3 p-3 bg-surface-container-low rounded-lg border border-outline-variant/30 text-body-md" +
      (esNuevoCiclo ? " mt-4 pt-4 border-t-2 border-t-secondary/30" : "");

    var izquierda = document.createElement("div");
    izquierda.className = "flex items-center gap-2 flex-wrap";

    var cicloEl = document.createElement("span");
    cicloEl.className = "text-[10px] font-bold px-1.5 py-0.5 rounded bg-secondary/10 text-secondary uppercase tracking-wider flex-shrink-0";
    cicloEl.textContent = "Cita " + cita.ciclo;
    izquierda.appendChild(cicloEl);

    var fecha = document.createElement("span");
    fecha.className = "font-medium";
    fecha.textContent = (cita.fecha || "—") + (cita.hora ? " · " + cita.hora : "");
    izquierda.appendChild(fecha);

    if (cita.esParaFamiliar) {
      var familiarEl = document.createElement("span");
      familiarEl.className = "text-[10px] font-bold px-1.5 py-0.5 rounded bg-secondary-fixed text-on-secondary-fixed-variant uppercase tracking-wider flex-shrink-0";
      familiarEl.textContent = "Familiar";
      izquierda.appendChild(familiarEl);
    }

    var estado = document.createElement("span");
    estado.className = "font-bold " + meta.texto;
    estado.textContent = meta.label;

    fila.appendChild(izquierda);
    fila.appendChild(estado);
    lista.appendChild(fila);
  });
}

// Colapsar/expandir un panel con flecha: mismo comportamiento en "Historial
// de Sesiones" y en la línea de tiempo de "Historial de Citas" (el resumen
// de badges de este último queda siempre visible, solo se colapsa la lista).
function wireToggle(toggleId, listaId, chevronId) {
  var toggle = document.getElementById(toggleId);
  var lista = document.getElementById(listaId);
  var chevron = document.getElementById(chevronId);

  toggle.addEventListener("click", function () {
    lista.classList.toggle("hidden");
    chevron.textContent = lista.classList.contains("hidden") ? "expand_more" : "expand_less";
  });
}

wireToggle("citas-historial-toggle", "citas-historial-list", "citas-historial-chevron");

function renderFormFromSesion(data) {
  riskSignal.checked = !!data.riesgo;
  updateRiskGlow(riskSignal.checked);

  if (data.frecuencia) document.getElementById("frequency-select").value = data.frecuencia;
  if (data.prioridad) document.getElementById("priority-select").value = data.prioridad;
  document.getElementById("motivo-textarea").value = data.motivoConsulta || "";
  document.getElementById("evolucion-textarea").value = data.evolucion || "";

  if (data.aptitud) {
    var aptitudInput = document.querySelector('input[name="aptitud"][value="' + data.aptitud + '"]');
    if (aptitudInput) aptitudInput.checked = true;
  }

  if (data.derivacion) document.getElementById("derivacion-select").value = data.derivacion;

  diagnosisList.innerHTML = "";
  (data.diagnosticos || []).forEach(function (d) {
    diagnosisList.appendChild(buildDiagnosisRow(d.codigo, d.label));
  });

  var acciones = data.accionesRealizadas || [];
  document.querySelectorAll('#acciones-list input[type="checkbox"]').forEach(function (cb) {
    cb.checked = acciones.indexOf(cb.value) !== -1;
  });

  document.getElementById("resultados-input").value = data.resultadosPruebas || "";
}

async function loadPatientData(dni) {
  if (!dni) {
    patientName.textContent = "Sin DNI en la URL";
    return;
  }

  try {
    const [ficha, cita, borrador, historial, citas] = await Promise.all([
      fetchFicha(dni),
      fetchCita(dni),
      fetchBorrador(dni),
      fetchHistorialSesiones(dni),
      fetchHistorialCitas(dni)
    ]);

    if (!ficha) {
      patientName.textContent = "No se encontró una ficha social para este DNI";
    } else {
      renderFichaSocial(ficha);
    }

    citaActual = cita;
    patientDatetime.textContent = cita && cita.fechaLabel && cita.hora ? `${cita.fechaLabel} — ${cita.hora}` : "—";

    const familiarBanner = document.getElementById("familiar-banner");
    if (cita && cita.esParaFamiliar) {
      var detalleFamiliar = [cita.familiarNombre, cita.familiarParentesco].filter(Boolean).join(" — ");
      document.getElementById("familiar-banner-texto").textContent =
        "Esta cita es para un familiar" + (detalleFamiliar ? ": " + detalleFamiliar : "");
      familiarBanner.classList.remove("hidden");
      familiarBanner.classList.add("flex");
    } else {
      familiarBanner.classList.add("hidden");
      familiarBanner.classList.remove("flex");
    }

    // Número de la sesión que se está por registrar: las ya completadas + 1.
    const completadas = historial.filter((s) => s.estado !== "borrador").length;
    patientSession.textContent = "#" + (completadas + 1);

    if (borrador) {
      renderFormFromSesion(borrador);
      document.getElementById("draft-indicator").classList.remove("hidden");
    }
    renderHistorial(historial);
    renderCitasResumen(citas);
    renderCitasHistorial(citas);
  } catch (err) {
    console.error("Error al consultar los datos del paciente:", err);
    patientName.textContent = "Error al cargar los datos del paciente";
  }
}

const dni = new URLSearchParams(window.location.search).get("dni");

onAuthStateChanged(auth, (user) => {
  if (!user) {
    // Sin sesión de psicólogo: las reglas de Firestore deben rechazar la
    // lectura igualmente; esto solo evita una consulta innecesaria.
    console.warn("No hay psicólogo autenticado; no se consulta Firestore.");
    patientName.textContent = "Inicia sesión para ver los datos del paciente";
    return;
  }
  // El catálogo debe estar en el DOM antes de precargar cualquier sesión
  // (borrador o edición), para que el valor guardado encuentre su <option>.
  cargarCatalogos().finally(() => loadPatientData(dni));
});

// Resaltar el caso de inmediato cuando se marca una señal de riesgo.
var riskSignal = document.getElementById("risk-signal");
var sessionSection = document.getElementById("section-session");
var patientBanner = document.getElementById("patient-banner");

function updateRiskGlow(checked) {
  if (checked) {
    sessionSection.classList.add("border-error", "risk-glow", "bg-error/5");
    patientBanner.classList.add("border-error/50");
  } else {
    sessionSection.classList.remove("border-error", "risk-glow", "bg-error/5");
    patientBanner.classList.remove("border-error/50");
  }
}

riskSignal.addEventListener("change", function (e) {
  updateRiskGlow(e.target.checked);
});

// Diagnóstico presuntivo: buscador con autocompletado contra el catálogo
// CIE-10 completo de la API pública de notasalud.com (JSON, CORS abierto,
// 120 búsquedas/min). Al tocar un resultado se agrega a la lista.
var diagnosisSearch = document.getElementById("diagnosis-search");
var diagnosisResults = document.getElementById("diagnosis-results");
var diagnosisCodeInput = document.getElementById("diagnosis-code");
var diagnosisList = document.getElementById("diagnosis-list");

var CIE10_API = "https://notasalud.com/buscar/cie-10";
var busquedaTimer = null;
var contadorBusquedas = 0; // descarta respuestas que llegan tarde (fuera de orden)

function buildDiagnosisRow(code, label) {
  var row = document.createElement("div");
  row.className = "flex items-center justify-between p-3 bg-surface-container-low rounded-lg border border-outline-variant";
  row.setAttribute("data-code", code);

  var text = document.createElement("span");
  text.className = "text-body-md font-medium text-primary";
  text.textContent = label;

  var removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "text-error hover:bg-error/10 p-1 rounded transition-colors";
  removeBtn.setAttribute("data-remove-diagnosis", "");
  removeBtn.innerHTML = '<span class="material-symbols-outlined text-sm">close</span>';

  row.appendChild(text);
  row.appendChild(removeBtn);
  return row;
}

// La API devuelve los códigos sin punto ("F411"); el formato estándar
// CIE-10 lleva punto tras el tercer carácter ("F41.1").
function formatearCodigoCie10(codigo) {
  return codigo.length > 3 ? codigo.slice(0, 3) + "." + codigo.slice(3) : codigo;
}

function ocultarResultados() {
  diagnosisResults.classList.add("hidden");
  diagnosisResults.innerHTML = "";
}

function mostrarMensajeResultados(mensaje) {
  diagnosisResults.innerHTML = "";
  var li = document.createElement("li");
  li.className = "px-4 py-2.5 text-body-md text-on-surface-variant";
  li.textContent = mensaje;
  diagnosisResults.appendChild(li);
  diagnosisResults.classList.remove("hidden");
}

function agregarDiagnostico(codigo, label) {
  diagnosisCodeInput.value = codigo;
  if (!diagnosisList.querySelector('[data-code="' + codigo + '"]')) {
    diagnosisList.appendChild(buildDiagnosisRow(codigo, label));
    formularioSucio = true;
  }
  diagnosisSearch.value = "";
  ocultarResultados();
}

function renderResultadosCie10(items) {
  diagnosisResults.innerHTML = "";

  if (items.length === 0) {
    mostrarMensajeResultados("Sin resultados para esa búsqueda.");
    return;
  }

  items.forEach(function (item) {
    var codigo = formatearCodigoCie10(String(item.codigo || ""));
    var li = document.createElement("li");
    li.className =
      "px-4 py-2.5 text-body-md hover:bg-surface-container-low cursor-pointer border-b border-outline-variant/30";

    var codigoEl = document.createElement("span");
    codigoEl.className = "font-semibold text-secondary";
    codigoEl.textContent = codigo;
    li.appendChild(codigoEl);
    li.appendChild(document.createTextNode(" — " + (item.nombre || "")));

    li.addEventListener("click", function () {
      agregarDiagnostico(codigo, codigo + " - " + (item.nombre || ""));
    });

    diagnosisResults.appendChild(li);
  });

  diagnosisResults.classList.remove("hidden");
}

async function buscarCie10(texto) {
  var miBusqueda = ++contadorBusquedas;
  try {
    var resp = await fetch(CIE10_API + "?q=" + encodeURIComponent(texto) + "&limit=10");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var data = await resp.json();
    if (miBusqueda !== contadorBusquedas) return; // ya hay una búsqueda más nueva
    renderResultadosCie10(data.results || []);
  } catch (err) {
    if (miBusqueda !== contadorBusquedas) return;
    console.error("Error al buscar en el catálogo CIE-10:", err);
    mostrarMensajeResultados("No se pudo buscar. Revisa tu conexión a internet.");
  }
}

diagnosisSearch.addEventListener("input", function () {
  var texto = diagnosisSearch.value.trim();
  clearTimeout(busquedaTimer);

  if (texto.length < 3) {
    ocultarResultados();
    return;
  }
  // Espera 300 ms tras la última tecla para no disparar una consulta por letra.
  busquedaTimer = setTimeout(function () {
    buscarCie10(texto);
  }, 300);
});

diagnosisSearch.addEventListener("keydown", function (e) {
  if (e.key === "Escape") ocultarResultados();
});

document.addEventListener("click", function (e) {
  if (!e.target.closest("#diagnosis-search") && !e.target.closest("#diagnosis-results")) {
    ocultarResultados();
  }
});

diagnosisList.addEventListener("click", function (e) {
  var removeBtn = e.target.closest("[data-remove-diagnosis]");
  if (!removeBtn) return;
  removeBtn.closest("[data-code]").remove();
});

// Colapsar/expandir todo el panel de Historial de Sesiones.
wireToggle("historial-toggle", "historial-list", "historial-chevron");

// Pequeña animación de click en los botones de guardado.
document.querySelectorAll("button").forEach(function (btn) {
  btn.addEventListener("click", function () {
    if (btn.innerText.includes("Guardar")) {
      btn.classList.add("scale-95");
      setTimeout(function () {
        btn.classList.remove("scale-95");
      }, 100);
    }
  });
});

// Guardar la sesión clínica en fb-psico.js, como subcolección del paciente:
// pacientes/{dni}/sesiones/{...}. "Guardar Borrador" siempre pisa el mismo
// documento "borrador-actual"; "Guardar y Agendar Siguiente" crea un
// documento nuevo (queda en el historial) y borra el borrador.
var saveDraftBtn = document.getElementById("save-draft-btn");
var saveFinalBtn = document.getElementById("save-final-btn");

function sesionesCollection(dniValue) {
  return collection(dbPsico, PACIENTES_COLLECTION, dniValue, "sesiones");
}

function collectFormData() {
  var aptitudInput = document.querySelector('input[name="aptitud"]:checked');

  var diagnosticos = Array.from(diagnosisList.querySelectorAll("[data-code]")).map(function (row) {
    return { codigo: row.dataset.code, label: row.querySelector("span").textContent.trim() };
  });

  var acciones = Array.from(document.querySelectorAll('#acciones-list input[type="checkbox"]:checked')).map(function (cb) {
    return cb.value;
  });

  return {
    riesgo: riskSignal.checked,
    frecuencia: document.getElementById("frequency-select").value,
    prioridad: document.getElementById("priority-select").value,
    motivoConsulta: document.getElementById("motivo-textarea").value,
    evolucion: document.getElementById("evolucion-textarea").value,
    aptitud: aptitudInput ? aptitudInput.value : null,
    derivacion: document.getElementById("derivacion-select").value,
    diagnosticos: diagnosticos,
    accionesRealizadas: acciones,
    resultadosPruebas: document.getElementById("resultados-input").value
  };
}

// La sesión hereda si es para un familiar (y su nombre/parentesco) de la
// cita reservada — no es un dato que se edite en este formulario.
function datosFamiliarDeCitaActual() {
  if (!citaActual || !citaActual.esParaFamiliar) {
    return { esParaFamiliar: false, familiarNombre: null, familiarParentesco: null };
  }
  return {
    esParaFamiliar: true,
    familiarNombre: citaActual.familiarNombre || null,
    familiarParentesco: citaActual.familiarParentesco || null
  };
}

async function guardarBorrador() {
  if (!dni) {
    alert("No hay un DNI en la URL: no se puede guardar.");
    return;
  }

  var originalHtml = saveDraftBtn.innerHTML;
  saveDraftBtn.disabled = true;
  saveDraftBtn.textContent = "Guardando...";

  try {
    var datos = collectFormData();
    await setDoc(
      doc(sesionesCollection(dni), "borrador-actual"),
      Object.assign({}, datos, datosFamiliarDeCitaActual(), { estado: "borrador", guardadoEn: serverTimestamp() }),
      { merge: true }
    );
    formularioSucio = false; // lo escrito ya está a salvo en el borrador
    alert("Borrador guardado.");
    await refreshHistorial(dni);
  } catch (err) {
    console.error("Error al guardar el borrador:", err);
    alert("No se pudo guardar el borrador.");
  } finally {
    saveDraftBtn.disabled = false;
    saveDraftBtn.innerHTML = originalHtml;
  }
}

async function guardarYAgendarSiguiente() {
  if (!dni) {
    alert("No hay un DNI en la URL: no se puede guardar.");
    return;
  }

  var datos = collectFormData();
  if (!datos.motivoConsulta.trim() && !datos.evolucion.trim()) {
    alert("Registra al menos el motivo de consulta o la evolución antes de cerrar la sesión.");
    return;
  }

  var originalHtml = saveFinalBtn.innerHTML;
  saveFinalBtn.disabled = true;
  saveFinalBtn.textContent = "Guardando...";

  try {
    await addDoc(
      sesionesCollection(dni),
      Object.assign({}, datos, datosFamiliarDeCitaActual(), {
        estado: "completada",
        revisado: false,
        // La modalidad viene de la cita reservada; alimenta el gráfico
        // "Modalidades de Atención" del tablero de indicadores.
        modalidad: citaActual && citaActual.modalidad ? citaActual.modalidad : null,
        guardadoEn: serverTimestamp()
      })
    );

    try {
      await deleteDoc(doc(sesionesCollection(dni), "borrador-actual"));
    } catch (cleanupErr) {
      // El borrador puede no existir; no es un error real, se ignora.
    }

    // La cita de este paciente pasa a "atendida" (la agenda la pinta en gris).
    try {
      await setDoc(doc(dbPsico, PACIENTES_COLLECTION, dni), { estado: "atendida" }, { merge: true });
      registrarHistorialCita(dni, {
        estado: "atendida",
        fecha: citaActual && citaActual.fecha ? citaActual.fecha : null,
        hora: citaActual && citaActual.hora ? citaActual.hora : null,
        modalidad: citaActual && citaActual.modalidad ? citaActual.modalidad : null,
        esParaFamiliar: !!(citaActual && citaActual.esParaFamiliar),
        familiarNombre: (citaActual && citaActual.familiarNombre) || null,
        familiarParentesco: (citaActual && citaActual.familiarParentesco) || null
      }).catch((err) => console.warn("No se pudo registrar el historial de la cita:", err));
    } catch (estadoErr) {
      // La sesión ya quedó guardada; si esto falla solo queda mal el color
      // de la tarjeta en la agenda, no se pierde información clínica.
      console.warn("No se pudo actualizar el estado de la cita:", estadoErr);
    }

    formularioSucio = false; // ya está guardado: no avisar al salir
    window.location.href = "agenda.html";
  } catch (err) {
    console.error("Error al guardar la sesión:", err);
    alert("No se pudo guardar la sesión.");
    saveFinalBtn.disabled = false;
    saveFinalBtn.innerHTML = originalHtml;
  }
}

saveDraftBtn.addEventListener("click", guardarBorrador);
saveFinalBtn.addEventListener("click", guardarYAgendarSiguiente);

// ---------- Cambios sin guardar: avisar antes de salir de la página ----------
var formulario = document.getElementById("clinical-record-form");
var formularioSucio = false;

formulario.addEventListener("input", function () {
  formularioSucio = true;
});
formulario.addEventListener("change", function () {
  formularioSucio = true;
});

window.addEventListener("beforeunload", function (e) {
  if (!formularioSucio) return;
  e.preventDefault();
  e.returnValue = ""; // el navegador muestra su propio diálogo de confirmación
});

// ---------- Cancelar y Borrar: descarta lo escrito y elimina el borrador ----------
var cancelBtn = document.getElementById("cancel-btn");

function limpiarFormulario() {
  riskSignal.checked = false;
  updateRiskGlow(false);
  document.getElementById("frequency-select").selectedIndex = 0;
  document.getElementById("priority-select").value = "medium";
  document.getElementById("motivo-textarea").value = "";
  document.getElementById("evolucion-textarea").value = "";
  var aptitudMarcada = document.querySelector('input[name="aptitud"]:checked');
  if (aptitudMarcada) aptitudMarcada.checked = false;
  // "No requerida" es la opción fija del catálogo (configuracion.html no
  // permite borrarla); se selecciona por texto en vez de por índice porque
  // el admin puede reordenar el catálogo.
  document.getElementById("derivacion-select").value = "No requerida";
  diagnosisList.innerHTML = "";
  document.querySelectorAll('#acciones-list input[type="checkbox"]').forEach(function (cb) {
    cb.checked = false;
  });
  document.getElementById("resultados-input").value = "";
  document.getElementById("draft-indicator").classList.add("hidden");
  formularioSucio = false;
}

cancelBtn.addEventListener("click", async function () {
  if (!window.confirm("¿Descartar lo escrito y eliminar el borrador guardado de este paciente?")) return;

  limpiarFormulario();

  if (dni) {
    try {
      await deleteDoc(doc(sesionesCollection(dni), "borrador-actual"));
      await refreshHistorial(dni);
    } catch (err) {
      // Si no había borrador guardado, no hay nada que eliminar.
    }
  }
});

// ---------- Editar una sesión del historial ----------
// Reutiliza el mismo formulario: al tocar "Editar esta sesión" se precarga
// con renderFormFromSesion() y el pie de página cambia a un único botón
// "Actualizar" que sobrescribe ese mismo documento (no crea uno nuevo ni
// toca el borrador-actual).
var updateSessionBtn = document.getElementById("update-session-btn");
var editModeBanner = document.getElementById("edit-mode-banner");
var editModeFecha = document.getElementById("edit-mode-fecha");
var editModeCancel = document.getElementById("edit-mode-cancel");

var sesionEnEdicionId = null;
var sesionEnEdicionMeta = null; // { estado, modalidad, esParaFamiliar, familiarNombre, familiarParentesco } del documento original, para no perderlos al actualizar

function salirModoEdicion() {
  sesionEnEdicionId = null;
  sesionEnEdicionMeta = null;
  editModeBanner.classList.add("hidden");
  editModeBanner.classList.remove("flex");
  cancelBtn.classList.remove("hidden");
  saveDraftBtn.classList.remove("hidden");
  saveFinalBtn.classList.remove("hidden");
  updateSessionBtn.classList.add("hidden");
}

function iniciarEdicionSesion(data) {
  if (formularioSucio && !window.confirm("Hay cambios sin guardar en el formulario. ¿Deseas descartarlos y editar esta sesión?")) {
    return;
  }

  sesionEnEdicionId = data.id;
  sesionEnEdicionMeta = {
    estado: data.estado || "completada",
    modalidad: data.modalidad || null,
    esParaFamiliar: !!data.esParaFamiliar,
    familiarNombre: data.familiarNombre || null,
    familiarParentesco: data.familiarParentesco || null
  };

  renderFormFromSesion(data);
  document.getElementById("draft-indicator").classList.add("hidden");

  editModeFecha.textContent = formatFechaGuardado(data.guardadoEn);
  editModeBanner.classList.remove("hidden");
  editModeBanner.classList.add("flex");

  cancelBtn.classList.add("hidden");
  saveDraftBtn.classList.add("hidden");
  saveFinalBtn.classList.add("hidden");
  updateSessionBtn.classList.remove("hidden");

  formularioSucio = false;
  formulario.scrollIntoView({ behavior: "smooth", block: "start" });
}

editModeCancel.addEventListener("click", function () {
  limpiarFormulario();
  salirModoEdicion();
});

async function actualizarSesion() {
  if (!dni || !sesionEnEdicionId) return;

  var datos = collectFormData();
  if (!datos.motivoConsulta.trim() && !datos.evolucion.trim()) {
    alert("Registra al menos el motivo de consulta o la evolución antes de actualizar.");
    return;
  }

  var originalHtml = updateSessionBtn.innerHTML;
  updateSessionBtn.disabled = true;
  updateSessionBtn.textContent = "Actualizando...";

  try {
    await setDoc(
      doc(sesionesCollection(dni), sesionEnEdicionId),
      Object.assign({}, datos, {
        estado: sesionEnEdicionMeta.estado,
        modalidad: sesionEnEdicionMeta.modalidad,
        esParaFamiliar: sesionEnEdicionMeta.esParaFamiliar,
        familiarNombre: sesionEnEdicionMeta.familiarNombre,
        familiarParentesco: sesionEnEdicionMeta.familiarParentesco
      }),
      { merge: true }
    );

    formularioSucio = false;
    limpiarFormulario();
    salirModoEdicion();
    alert("Sesión actualizada.");
    await refreshHistorial(dni);
  } catch (err) {
    console.error("Error al actualizar la sesión:", err);
    alert("No se pudo actualizar la sesión.");
  } finally {
    updateSessionBtn.disabled = false;
    updateSessionBtn.innerHTML = originalHtml;
  }
}

updateSessionBtn.addEventListener("click", actualizarSesion);
