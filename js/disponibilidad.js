// Lógica propia de Mi Disponibilidad (V7).
// Los bloques se leen y se guardan en Firestore (fb-psico), en la colección
// "disponibilidad", un documento por día de la semana ("lunes".."domingo").
// index.html (Paso 1 y Paso 2) lee de esta misma colección para armar las
// burbujas de reserva — por eso todo lo que se apague/agregue/edite/guarde
// aquí se refleja allá.
import { dbPsico, DISPONIBILIDAD_COLLECTION, DIAS_SEMANA } from "./fb-psico.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

var MODALIDAD_STYLES = {
  presencial: { label: "Presencial", classes: "bg-secondary text-on-secondary" },
  virtual: { label: "Video", classes: "bg-secondary-fixed border border-secondary text-on-secondary-fixed-variant" },
  llamada: { label: "Llamada", classes: "bg-tertiary-fixed border border-on-tertiary-fixed-variant text-on-tertiary-fixed-variant" },
  emergencia: { label: "Emergencia", classes: "hatched-bg border border-outline-variant text-on-surface-variant" }
};

// Datos de ejemplo con los que se siembra Firestore la primera vez (si la
// colección "disponibilidad" está vacía), para no arrancar con el calendario
// en blanco.
var DEFAULT_BLOQUES = {
  lunes: [{ id: "seed-lun-1", modalidad: "presencial", horaInicio: "09:00", horaFin: "12:00", activo: true }],
  martes: [{ id: "seed-mar-1", modalidad: "virtual", horaInicio: "13:00", horaFin: "17:00", activo: true }],
  miercoles: [
    { id: "seed-mie-1", modalidad: "presencial", horaInicio: "09:00", horaFin: "11:00", activo: true },
    { id: "seed-mie-2", modalidad: "emergencia", horaInicio: "15:00", horaFin: "17:00", activo: true }
  ],
  jueves: [{ id: "seed-jue-1", modalidad: "virtual", horaInicio: "10:00", horaFin: "13:00", activo: true }],
  viernes: [{ id: "seed-vie-1", modalidad: "llamada", horaInicio: "09:00", horaFin: "11:00", activo: true }],
  sabado: [],
  domingo: []
};

var estadoDisponibilidad = {};

function horaToRem(hora) {
  var partes = hora.split(":").map(Number);
  var decimal = partes[0] + partes[1] / 60;
  return (decimal - 8) * 5; // La grilla arranca en 08:00, 1 hora = 5rem.
}

function crearIdBloque() {
  return "b" + Date.now() + Math.floor(Math.random() * 1000);
}

// --- Encabezado: fechas reales de la semana actual ---
function pintarFechasSemana() {
  var hoy = new Date();
  var diaSemanaHoy = hoy.getDay(); // 0=domingo..6=sábado
  var offsetLunes = diaSemanaHoy === 0 ? -6 : 1 - diaSemanaHoy;
  var lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() + offsetLunes);

  DIAS_SEMANA.forEach(function (dia, index) {
    var fecha = new Date(lunes);
    fecha.setDate(lunes.getDate() + index);
    var span = document.getElementById("header-dia-" + dia);
    if (!span) return;
    span.textContent = String(fecha.getDate());
    if (fecha.toDateString() === hoy.toDateString()) {
      span.classList.add("text-secondary", "underline", "decoration-2", "underline-offset-4");
    }
  });
}

// --- Cargar (y sembrar si hace falta) la disponibilidad de los 7 días ---
async function fetchDisponibilidad() {
  var resultado = {};
  var snapshots = await Promise.all(
    DIAS_SEMANA.map(function (dia) {
      return getDoc(doc(dbPsico, DISPONIBILIDAD_COLLECTION, dia));
    })
  );

  var faltaSembrar = false;
  snapshots.forEach(function (snap, index) {
    var dia = DIAS_SEMANA[index];
    if (snap.exists()) {
      resultado[dia] = snap.data().bloques || [];
    } else {
      faltaSembrar = true;
      resultado[dia] = DEFAULT_BLOQUES[dia] || [];
    }
  });

  if (faltaSembrar) {
    await Promise.all(
      DIAS_SEMANA.map(function (dia) {
        return setDoc(doc(dbPsico, DISPONIBILIDAD_COLLECTION, dia), { bloques: resultado[dia] }, { merge: true });
      })
    );
  }

  return resultado;
}

async function guardarBloquesDia(dia, bloques) {
  await setDoc(doc(dbPsico, DISPONIBILIDAD_COLLECTION, dia), { bloques: bloques });
}

// --- Render de los bloques de un día ---
function renderBloquesDia(dia, bloques) {
  var columna = document.querySelector('[data-dia="' + dia + '"]');
  if (!columna) return;
  columna.innerHTML = "";

  bloques.forEach(function (bloque) {
    var estilo = MODALIDAD_STYLES[bloque.modalidad] || MODALIDAD_STYLES.presencial;
    var top = horaToRem(bloque.horaInicio);
    var alto = horaToRem(bloque.horaFin) - top;

    var div = document.createElement("div");
    div.className =
      "absolute left-1 right-1 rounded-lg p-2 group shadow-sm cursor-pointer " +
      estilo.classes +
      (bloque.activo ? "" : " opacity-30 grayscale");
    div.style.top = top + "rem";
    div.style.height = alto + "rem";
    div.dataset.editBloque = bloque.id;

    div.innerHTML =
      '<div class="flex justify-between items-start">' +
        '<span class="text-label-md font-bold">' + estilo.label + "</span>" +
        '<button type="button" class="material-symbols-outlined text-[18px] opacity-0 group-hover:opacity-100 transition-opacity" data-toggle-bloque="' +
          bloque.id +
          '">power_settings_new</button>' +
      "</div>" +
      '<div class="text-[10px] mt-1 opacity-80">' + bloque.horaInicio + " - " + bloque.horaFin + "</div>";

    columna.appendChild(div);
  });

  var addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className =
    "absolute bottom-2 left-1 right-1 py-2 border-2 border-dashed border-outline-variant rounded-lg text-[10px] text-secondary font-bold uppercase tracking-widest hover:bg-secondary/5 hover:border-secondary/40 transition-colors";
  addBtn.textContent = "+ Agregar bloque";
  addBtn.dataset.addBloque = dia;
  columna.appendChild(addBtn);
}

function renderTodo() {
  DIAS_SEMANA.forEach(function (dia) {
    renderBloquesDia(dia, estadoDisponibilidad[dia] || []);
  });
}

async function cargarYRenderizar() {
  try {
    estadoDisponibilidad = await fetchDisponibilidad();
    renderTodo();
  } catch (err) {
    console.error("Error al cargar la disponibilidad:", err);
  }
}

pintarFechasSemana();
cargarYRenderizar();

// ---------- Duración de cada cita (documento "config" en la misma colección).
// index.html y la reprogramación de la agenda generan las burbujas con este
// intervalo. ----------
var intervaloSelect = document.getElementById("intervalo-select");

async function cargarIntervalo() {
  try {
    var snap = await getDoc(doc(dbPsico, DISPONIBILIDAD_COLLECTION, "config"));
    var minutos = snap.exists() ? Number(snap.data().intervaloMinutos) : 30;
    if ([20, 30, 45, 60].includes(minutos)) intervaloSelect.value = String(minutos);
  } catch (err) {
    console.error("Error al cargar la duración de cita:", err);
  }
}

intervaloSelect.addEventListener("change", async function () {
  try {
    await setDoc(
      doc(dbPsico, DISPONIBILIDAD_COLLECTION, "config"),
      { intervaloMinutos: Number(intervaloSelect.value) },
      { merge: true }
    );
  } catch (err) {
    console.error("Error al guardar la duración de cita:", err);
    alert("No se pudo guardar la duración de cita.");
  }
});

cargarIntervalo();

// ---------- Toggle rápido de encendido/apagado (sin abrir el modal) ----------
var calendarBody = document.getElementById("calendar-body");

calendarBody.addEventListener("click", async function (e) {
  var toggleBtn = e.target.closest("[data-toggle-bloque]");
  if (toggleBtn) {
    e.stopPropagation();
    var dia = toggleBtn.closest("[data-dia]").dataset.dia;
    var bloques = estadoDisponibilidad[dia] || [];
    var bloque = bloques.find(function (b) {
      return b.id === toggleBtn.dataset.toggleBloque;
    });
    if (!bloque) return;

    bloque.activo = !bloque.activo;
    renderBloquesDia(dia, bloques);

    try {
      await guardarBloquesDia(dia, bloques);
    } catch (err) {
      console.error("Error al actualizar el bloque:", err);
      alert("No se pudo guardar el cambio.");
    }
    return;
  }

  var addBtn = e.target.closest("[data-add-bloque]");
  if (addBtn) {
    abrirModalBloque(addBtn.dataset.addBloque, null);
    return;
  }

  var editDiv = e.target.closest("[data-edit-bloque]");
  if (editDiv) {
    var diaEditar = editDiv.closest("[data-dia]").dataset.dia;
    abrirModalBloque(diaEditar, editDiv.dataset.editBloque);
  }
});

// ---------- Modal: Agregar / Editar bloque ----------
var bloqueModal = document.getElementById("bloque-modal");
var bloqueModalTitle = document.getElementById("bloque-modal-title");
var bloqueModalClose = document.getElementById("bloque-modal-close");
var bloqueModalidadOptions = document.getElementById("bloque-modalidad-options");
var bloqueHoraInicio = document.getElementById("bloque-hora-inicio");
var bloqueHoraFin = document.getElementById("bloque-hora-fin");
var bloqueModalError = document.getElementById("bloque-modal-error");
var bloqueModalDelete = document.getElementById("bloque-modal-delete");
var bloqueModalSave = document.getElementById("bloque-modal-save");

var modalDiaActual = null;
var modalBloqueIdActual = null;
var modalidadSeleccionada = null;

var MODALIDAD_OPTION_BASE = "modalidad-option flex items-center gap-2 p-3 rounded-lg border-2 transition-all";
var MODALIDAD_OPTION_INACTIVE = MODALIDAD_OPTION_BASE + " border-outline-variant hover:border-secondary";
var MODALIDAD_OPTION_ACTIVE = MODALIDAD_OPTION_BASE + " border-secondary bg-secondary/5";

var bloqueEnlaceWrap = document.getElementById("bloque-enlace-wrap");
var bloqueEnlace = document.getElementById("bloque-enlace");

function marcarModalidadSeleccionada(modalidad) {
  modalidadSeleccionada = modalidad;
  bloqueModalidadOptions.querySelectorAll("[data-modalidad]").forEach(function (btn) {
    btn.className = btn.dataset.modalidad === modalidad ? MODALIDAD_OPTION_ACTIVE : MODALIDAD_OPTION_INACTIVE;
  });
  // El enlace de reunión solo aplica a bloques de Video.
  bloqueEnlaceWrap.classList.toggle("hidden", modalidad !== "virtual");
}

bloqueModalidadOptions.querySelectorAll("[data-modalidad]").forEach(function (btn) {
  btn.addEventListener("click", function () {
    marcarModalidadSeleccionada(btn.dataset.modalidad);
  });
});

function abrirModalBloque(dia, bloqueId) {
  modalDiaActual = dia;
  modalBloqueIdActual = bloqueId;
  bloqueModalError.classList.add("hidden");

  var bloqueExistente = bloqueId
    ? (estadoDisponibilidad[dia] || []).find(function (b) {
        return b.id === bloqueId;
      })
    : null;

  if (bloqueExistente) {
    bloqueModalTitle.textContent = "Editar bloque";
    marcarModalidadSeleccionada(bloqueExistente.modalidad);
    bloqueHoraInicio.value = bloqueExistente.horaInicio;
    bloqueHoraFin.value = bloqueExistente.horaFin;
    bloqueEnlace.value = bloqueExistente.enlace || "";
    bloqueModalDelete.classList.remove("hidden");
  } else {
    bloqueModalTitle.textContent = "Agregar bloque";
    marcarModalidadSeleccionada("presencial");
    bloqueHoraInicio.value = "09:00";
    bloqueHoraFin.value = "10:00";
    bloqueEnlace.value = "";
    bloqueModalDelete.classList.add("hidden");
  }

  bloqueModal.classList.remove("hidden");
}

function cerrarModalBloque() {
  bloqueModal.classList.add("hidden");
  modalDiaActual = null;
  modalBloqueIdActual = null;
}

bloqueModalClose.addEventListener("click", cerrarModalBloque);
bloqueModal.addEventListener("click", function (e) {
  if (e.target === bloqueModal) cerrarModalBloque();
});

function mostrarErrorModal(mensaje) {
  bloqueModalError.textContent = mensaje;
  bloqueModalError.classList.remove("hidden");
}

bloqueModalSave.addEventListener("click", async function () {
  var horaInicio = bloqueHoraInicio.value;
  var horaFin = bloqueHoraFin.value;

  if (!modalidadSeleccionada) {
    mostrarErrorModal("Elige una modalidad.");
    return;
  }
  if (!horaInicio || !horaFin || horaInicio >= horaFin) {
    mostrarErrorModal("La hora de fin debe ser posterior a la de inicio.");
    return;
  }

  var enlace = modalidadSeleccionada === "virtual" ? bloqueEnlace.value.trim() : "";
  var bloquesDia = estadoDisponibilidad[modalDiaActual] || [];

  if (modalBloqueIdActual) {
    var bloque = bloquesDia.find(function (b) {
      return b.id === modalBloqueIdActual;
    });
    if (bloque) {
      bloque.modalidad = modalidadSeleccionada;
      bloque.horaInicio = horaInicio;
      bloque.horaFin = horaFin;
      bloque.enlace = enlace;
    }
  } else {
    bloquesDia.push({
      id: crearIdBloque(),
      modalidad: modalidadSeleccionada,
      horaInicio: horaInicio,
      horaFin: horaFin,
      enlace: enlace,
      activo: true
    });
  }

  estadoDisponibilidad[modalDiaActual] = bloquesDia;
  renderBloquesDia(modalDiaActual, bloquesDia);

  var originalText = bloqueModalSave.textContent;
  bloqueModalSave.disabled = true;
  bloqueModalSave.textContent = "Guardando...";

  try {
    await guardarBloquesDia(modalDiaActual, bloquesDia);
    cerrarModalBloque();
  } catch (err) {
    console.error("Error al guardar el bloque:", err);
    mostrarErrorModal("No se pudo guardar el bloque.");
  } finally {
    bloqueModalSave.disabled = false;
    bloqueModalSave.textContent = originalText;
  }
});

bloqueModalDelete.addEventListener("click", async function () {
  if (!modalBloqueIdActual) return;

  var bloquesDia = (estadoDisponibilidad[modalDiaActual] || []).filter(function (b) {
    return b.id !== modalBloqueIdActual;
  });
  estadoDisponibilidad[modalDiaActual] = bloquesDia;
  renderBloquesDia(modalDiaActual, bloquesDia);

  try {
    await guardarBloquesDia(modalDiaActual, bloquesDia);
    cerrarModalBloque();
  } catch (err) {
    console.error("Error al eliminar el bloque:", err);
    mostrarErrorModal("No se pudo eliminar el bloque.");
  }
});

// ---------- Vista previa pública: abre la página de reserva tal como la ve
// el trabajador, en otra pestaña ----------
document.getElementById("vista-previa-btn").addEventListener("click", function () {
  window.open("index.html", "_blank");
});

// ---------- Guardar Cambios (re-sincroniza todo, por si acaso) ----------
var guardarCambiosBtn = document.getElementById("guardar-cambios-btn");
guardarCambiosBtn.addEventListener("click", async function () {
  var originalText = guardarCambiosBtn.textContent;
  guardarCambiosBtn.disabled = true;
  guardarCambiosBtn.textContent = "Guardando...";

  try {
    await Promise.all(
      DIAS_SEMANA.map(function (dia) {
        return guardarBloquesDia(dia, estadoDisponibilidad[dia] || []);
      })
    );
    alert("Cambios guardados.");
  } catch (err) {
    console.error("Error al guardar los cambios:", err);
    alert("No se pudieron guardar los cambios.");
  } finally {
    guardarCambiosBtn.disabled = false;
    guardarCambiosBtn.textContent = originalText;
  }
});
