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
import { dbPsico, PACIENTES_COLLECTION } from "./fb-psico.js";

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

  var diagnosticosTexto = (data.diagnosticos || []).map(function (d) { return d.label; }).join(", ") || "—";
  var accionesTexto = (data.accionesRealizadas || []).join(", ") || "—";

  item.innerHTML =
    '<button type="button" class="historial-item-toggle w-full flex items-center justify-between gap-3 p-3 hover:bg-surface-container-low transition-colors text-left">' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<span class="font-body-md font-semibold text-primary">' + formatFechaGuardado(data.guardadoEn) + '</span>' +
        estadoBadge + riesgoBadge +
      "</div>" +
      '<span class="material-symbols-outlined text-on-surface-variant text-[20px]">expand_more</span>' +
    "</button>" +
    '<div class="hidden border-t border-outline-variant p-4 space-y-2 text-body-md">' +
      "<p><strong>Motivo:</strong> " + (data.motivoConsulta || "—") + "</p>" +
      "<p><strong>Evolución:</strong> " + (data.evolucion || "—") + "</p>" +
      "<p><strong>Frecuencia:</strong> " + (data.frecuencia || "—") + " · <strong>Prioridad:</strong> " + (data.prioridad || "—") + "</p>" +
      "<p><strong>Aptitud:</strong> " + (data.aptitud || "—") + " · <strong>Seguimiento:</strong> " + (data.seguimiento || data.tratamiento || "—") + "</p>" +
      "<p><strong>Restricciones:</strong> " + (data.restricciones || "—") + "</p>" +
      "<p><strong>Derivación:</strong> " + (data.derivacion || "—") + "</p>" +
      "<p><strong>Diagnósticos:</strong> " + diagnosticosTexto + "</p>" +
      "<p><strong>Acciones realizadas:</strong> " + accionesTexto + "</p>" +
      "<p><strong>Resultados de pruebas:</strong> " + (data.resultadosPruebas || "—") + "</p>" +
    "</div>";

  item.querySelector(".historial-item-toggle").addEventListener("click", function () {
    item.lastElementChild.classList.toggle("hidden");
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
    const [ficha, cita, borrador, historial] = await Promise.all([
      fetchFicha(dni),
      fetchCita(dni),
      fetchBorrador(dni),
      fetchHistorialSesiones(dni)
    ]);

    if (!ficha) {
      patientName.textContent = "No se encontró una ficha social para este DNI";
    } else {
      renderFichaSocial(ficha);
    }

    citaActual = cita;
    patientDatetime.textContent = cita && cita.fechaLabel && cita.hora ? `${cita.fechaLabel} — ${cita.hora}` : "—";

    // Número de la sesión que se está por registrar: las ya completadas + 1.
    const completadas = historial.filter((s) => s.estado !== "borrador").length;
    patientSession.textContent = "#" + (completadas + 1);

    if (borrador) {
      renderFormFromSesion(borrador);
      document.getElementById("draft-indicator").classList.remove("hidden");
    }
    renderHistorial(historial);
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
  loadPatientData(dni);
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
var historialToggle = document.getElementById("historial-toggle");
var historialListContainer = document.getElementById("historial-list");
var historialChevron = document.getElementById("historial-chevron");

historialToggle.addEventListener("click", function () {
  historialListContainer.classList.toggle("hidden");
  historialChevron.textContent = historialListContainer.classList.contains("hidden") ? "expand_more" : "expand_less";
});

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
      Object.assign({}, datos, { estado: "borrador", guardadoEn: serverTimestamp() }),
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
      Object.assign({}, datos, {
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
  document.getElementById("derivacion-select").selectedIndex = 0;
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
