// Configuración (V-nueva): cambio de contraseña del psicólogo + ajustes que
// antes estaban fijos en el código (umbral de "Casos Sin Seguimiento" en
// indicadores.js, catálogos de Derivación y Acciones Realizadas en
// atencion.html). Todo lo de esta página, salvo la contraseña, se guarda en
// fb-psico (colección "configuracion") y lo leen atencion.js, indicadores.js
// e importador.js.
import { auth } from "./firebase-config.js";
import {
  onAuthStateChanged,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { dbPsico, CONFIGURACION_COLLECTION } from "./fb-psico.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const DERIVACIONES_DEFAULT = ["No requerida", "Psiquiatría", "Psicologia", "Neuropsicologia"];
const ACCIONES_DEFAULT = [
  "Recomendaciones compartidas verbalmente",
  "Envío de material psicoeducativo digital",
  "Pruebas psicométricas aplicadas"
];
const UMBRAL_DEFAULT = 30;
const DERIVACION_FIJA = "No requerida"; // opción por defecto del formulario; no se puede borrar

// Clases extra que cada tarjeta ya trae en el HTML (además de
// "text-body-md font-semibold"), para no perderlas al fijar el color.
const CLASES_EXTRA_ESTADO = {
  "password-status": "sm:col-span-2",
  "umbral-status": "w-full",
  "derivaciones-status": "mt-3",
  "acciones-catalogo-status": "mt-3"
};

function mostrarEstado(id, mensaje, esError) {
  const el = document.getElementById(id);
  el.textContent = mensaje;
  el.className = "text-body-md font-semibold " + (esError ? "text-error" : "text-primary") + " " + (CLASES_EXTRA_ESTADO[id] || "");
  el.classList.remove("hidden");
}

// ---------- Cambiar contraseña ----------
// Firebase exige una sesión "reciente" para operaciones sensibles como
// cambiar la contraseña; por eso se reautentica con la contraseña actual
// antes de aplicar la nueva.
const passwordForm = document.getElementById("password-form");
const currentPasswordInput = document.getElementById("current-password");
const newPasswordInput = document.getElementById("new-password");
const confirmPasswordInput = document.getElementById("confirm-password");
const passwordSubmit = document.getElementById("password-submit");

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const actual = currentPasswordInput.value;
  const nueva = newPasswordInput.value;
  const confirmacion = confirmPasswordInput.value;

  if (nueva.length < 6) {
    mostrarEstado("password-status", "La contraseña nueva debe tener al menos 6 caracteres.", true);
    return;
  }
  if (nueva !== confirmacion) {
    mostrarEstado("password-status", "La confirmación no coincide con la contraseña nueva.", true);
    return;
  }

  const originalText = passwordSubmit.textContent;
  passwordSubmit.disabled = true;
  passwordSubmit.textContent = "Actualizando...";

  try {
    const credencial = EmailAuthProvider.credential(auth.currentUser.email, actual);
    await reauthenticateWithCredential(auth.currentUser, credencial);
    await updatePassword(auth.currentUser, nueva);
    mostrarEstado("password-status", "Contraseña actualizada.", false);
    passwordForm.reset();
  } catch (err) {
    console.error("Error al cambiar la contraseña:", err);
    const mensaje =
      err.code === "auth/wrong-password" || err.code === "auth/invalid-credential"
        ? "La contraseña actual no es correcta."
        : "No se pudo actualizar la contraseña.";
    mostrarEstado("password-status", mensaje, true);
  } finally {
    passwordSubmit.disabled = false;
    passwordSubmit.textContent = originalText;
  }
});

// ---------- Umbral de "Casos Sin Seguimiento" ----------
const umbralForm = document.getElementById("umbral-form");
const umbralInput = document.getElementById("umbral-input");

async function cargarUmbral() {
  try {
    const snap = await getDoc(doc(dbPsico, CONFIGURACION_COLLECTION, "general"));
    const valor = snap.exists() ? Number(snap.data().umbralSeguimientoDias) : NaN;
    umbralInput.value = Number.isInteger(valor) && valor > 0 ? valor : UMBRAL_DEFAULT;
  } catch (err) {
    console.error("Error al cargar el umbral de seguimiento:", err);
    umbralInput.value = UMBRAL_DEFAULT;
  }
}

umbralForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const valor = Number(umbralInput.value);
  if (!Number.isInteger(valor) || valor < 1) {
    mostrarEstado("umbral-status", "Ingresa un número entero mayor a 0.", true);
    return;
  }

  try {
    await setDoc(doc(dbPsico, CONFIGURACION_COLLECTION, "general"), { umbralSeguimientoDias: valor }, { merge: true });
    mostrarEstado("umbral-status", "Guardado. El tablero de indicadores lo usará desde la próxima carga.", false);
  } catch (err) {
    console.error("Error al guardar el umbral de seguimiento:", err);
    mostrarEstado("umbral-status", "No se pudo guardar.", true);
  }
});

// ---------- Catálogos (Derivaciones / Acciones Realizadas) ----------
// Comparten la misma lógica de lista editable; se guardan juntos en
// configuracion/catalogos para no multiplicar documentos.
let catalogoDerivaciones = [];
let catalogoAcciones = [];

function crearFilaCatalogo(texto, alEliminar) {
  const fila = document.createElement("div");
  fila.className = "flex items-center justify-between gap-3 p-3 bg-surface-container-low rounded-lg border border-outline-variant";

  const span = document.createElement("span");
  span.className = "text-body-md font-medium";
  span.textContent = texto;
  fila.appendChild(span);

  if (alEliminar) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "text-error hover:bg-error/10 p-1 rounded transition-colors";
    btn.innerHTML = '<span class="material-symbols-outlined text-sm">close</span>';
    btn.addEventListener("click", alEliminar);
    fila.appendChild(btn);
  } else {
    const nota = document.createElement("span");
    nota.className = "text-label-md text-on-surface-variant italic";
    nota.textContent = "Fija";
    fila.appendChild(nota);
  }

  return fila;
}

function renderDerivaciones() {
  const contenedor = document.getElementById("derivaciones-list");
  contenedor.innerHTML = "";
  catalogoDerivaciones.forEach((texto) => {
    const esFija = texto === DERIVACION_FIJA;
    contenedor.appendChild(
      crearFilaCatalogo(
        texto,
        esFija
          ? null
          : () => {
              catalogoDerivaciones = catalogoDerivaciones.filter((d) => d !== texto);
              renderDerivaciones();
              guardarCatalogos("Opción eliminada.");
            }
      )
    );
  });
}

function renderAcciones() {
  const contenedor = document.getElementById("acciones-catalogo-list");
  contenedor.innerHTML = "";
  catalogoAcciones.forEach((texto) => {
    contenedor.appendChild(
      crearFilaCatalogo(texto, () => {
        catalogoAcciones = catalogoAcciones.filter((a) => a !== texto);
        renderAcciones();
        guardarCatalogos("Acción eliminada.");
      })
    );
  });
}

async function guardarCatalogos(mensajeExito) {
  try {
    await setDoc(
      doc(dbPsico, CONFIGURACION_COLLECTION, "catalogos"),
      { derivaciones: catalogoDerivaciones, acciones: catalogoAcciones },
      { merge: true }
    );
    if (mensajeExito) {
      mostrarEstado("derivaciones-status", mensajeExito, false);
      mostrarEstado("acciones-catalogo-status", mensajeExito, false);
    }
  } catch (err) {
    console.error("Error al guardar los catálogos:", err);
    mostrarEstado("derivaciones-status", "No se pudo guardar el cambio.", true);
    mostrarEstado("acciones-catalogo-status", "No se pudo guardar el cambio.", true);
  }
}

async function cargarCatalogos() {
  try {
    const snap = await getDoc(doc(dbPsico, CONFIGURACION_COLLECTION, "catalogos"));
    const data = snap.exists() ? snap.data() : {};
    catalogoDerivaciones = Array.isArray(data.derivaciones) && data.derivaciones.length ? data.derivaciones : DERIVACIONES_DEFAULT.slice();
    catalogoAcciones = Array.isArray(data.acciones) && data.acciones.length ? data.acciones : ACCIONES_DEFAULT.slice();

    // Primera vez (documento inexistente): siembra Firestore con los valores
    // por defecto, igual que disponibilidad.js hace con los bloques.
    if (!snap.exists()) {
      await guardarCatalogos(null);
    }
  } catch (err) {
    console.error("Error al cargar los catálogos:", err);
    catalogoDerivaciones = DERIVACIONES_DEFAULT.slice();
    catalogoAcciones = ACCIONES_DEFAULT.slice();
  }

  renderDerivaciones();
  renderAcciones();
}

const derivacionNuevaInput = document.getElementById("derivacion-nueva");
document.getElementById("derivacion-agregar").addEventListener("click", () => {
  const texto = derivacionNuevaInput.value.trim();
  if (!texto) return;
  if (catalogoDerivaciones.some((d) => d.toLowerCase() === texto.toLowerCase())) {
    mostrarEstado("derivaciones-status", "Esa opción ya existe.", true);
    return;
  }
  catalogoDerivaciones.push(texto);
  derivacionNuevaInput.value = "";
  renderDerivaciones();
  guardarCatalogos("Opción agregada.");
});

const accionNuevaInput = document.getElementById("accion-nueva");
document.getElementById("accion-agregar").addEventListener("click", () => {
  const texto = accionNuevaInput.value.trim();
  if (!texto) return;
  if (catalogoAcciones.some((a) => a.toLowerCase() === texto.toLowerCase())) {
    mostrarEstado("acciones-catalogo-status", "Esa acción ya existe.", true);
    return;
  }
  catalogoAcciones.push(texto);
  accionNuevaInput.value = "";
  renderAcciones();
  guardarCatalogos("Acción agregada.");
});

// ---------- Inicio ----------
onAuthStateChanged(auth, (user) => {
  if (!user) return; // auth-guard.js ya redirige a index.html
  cargarUmbral();
  cargarCatalogos();
});
