// Lógica propia de Reserva de Cita (V1, pantalla pública).
// Este paso registra DNI + fecha/hora elegidas: es una escritura sin
// autenticar contra el proyecto de fb-psico.js. El resto de la ficha
// (nombre, teléfono, área, modalidad) se completa más adelante, cuando esa
// parte del flujo se conecte.
import { dbPsico, PACIENTES_COLLECTION, DISPONIBILIDAD_COLLECTION, MODALIDADES, registrarHistorialCita } from "./fb-psico.js";
import {
  doc,
  setDoc,
  serverTimestamp,
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, ADMIN_EMAIL } from "./firebase-config.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const dniInput = document.getElementById("dni");
const confirmBtn = document.getElementById("confirm-btn");
const bookingFlow = document.getElementById("booking-flow");
const confirmationScreen = document.getElementById("confirmation-screen");
const summaryDni = document.getElementById("summary-dni");
const summaryDatetime = document.getElementById("summary-datetime");
const dateSummary = document.getElementById("date-summary");
const bookingSummary = document.getElementById("booking-summary");
const backToBookingBtn = document.getElementById("back-to-booking-btn");

const originalBtnHtml = confirmBtn.innerHTML;

// ---------- Paso 1 y 2: calendario del mes + horas, según Mi Disponibilidad ----------
// data-dia de disponibilidad va lunes..domingo; Date.getDay() va 0=domingo..6=sábado.
const DIA_KEY_POR_GETDAY = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DIAS_LARGOS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MESES_CORTOS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MESES_LARGOS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
];

const TIME_UNSELECTED_CLASS =
  "time-option py-3 px-2 rounded-full border border-outline-variant hover:border-[#10b981] bg-surface-container-lowest text-on-surface flex items-center justify-center gap-2 transition-colors group";
const TIME_SELECTED_CLASS =
  "time-option is-selected py-3 px-2 rounded-full border-2 border-secondary bg-secondary text-on-primary flex items-center justify-center gap-2 shadow-[0px_4px_12px_rgba(30,41,59,0.15)] transition-all";

const monthLabel = document.getElementById("calendar-month-label");
const daysGrid = document.getElementById("calendar-days-grid");
const timeOptionsContainer = document.getElementById("time-options");

const wspInput = document.getElementById("wsp-input");

let disponibilidadMap = {};
let intervaloMinutos = 30; // duración de cita; la configura el administrador
let horasOcupadas = new Set();
let calendarioMesActual = new Date();
let selectedFecha = null;
let selectedFechaLabel = null;
let selectedFechaLarga = null;
let selectedHora = null;
let selectedModalidad = null;
let selectedEnlace = "";

function capitalizar(texto) {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function formatearFechaISO(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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

async function fetchHorasOcupadas() {
  // Solo las citas de hoy en adelante: las pasadas no bloquean burbujas, y
  // así el costo de lecturas de la página pública no crece con el histórico.
  const hoyISO = formatearFechaISO(new Date());
  const citasFuturas = query(collection(dbPsico, PACIENTES_COLLECTION), where("fecha", ">=", hoyISO));
  const snap = await getDocs(citasFuturas);
  const ocupadas = new Set();
  snap.forEach((d) => {
    const data = d.data();
    if (data.fecha && data.hora) ocupadas.add(`${data.fecha}|${data.hora}`);
  });
  return ocupadas;
}

// Devuelve los turnos del día (cada "intervaloMinutos") con su modalidad y
// (si es video) el enlace de reunión del bloque al que pertenecen.
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
        const hh = String(Math.floor(actual / 60)).padStart(2, "0");
        const mm = String(actual % 60).padStart(2, "0");
        const clave = `${hh}:${mm}`;
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

function diaTieneAtencion(fecha) {
  const key = DIA_KEY_POR_GETDAY[fecha.getDay()];
  const bloques = disponibilidadMap[key] || [];
  return bloques.some((b) => b.activo && b.modalidad !== "emergencia");
}

function esFechaValida(fecha) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const comparar = new Date(fecha);
  comparar.setHours(0, 0, 0, 0);
  return comparar >= hoy && diaTieneAtencion(fecha);
}

function renderCalendarioMes() {
  const anio = calendarioMesActual.getFullYear();
  const mes = calendarioMesActual.getMonth();

  monthLabel.textContent = `${MESES_LARGOS[mes]} ${anio}`;

  const primerDiaMes = new Date(anio, mes, 1);
  const offsetInicio = (primerDiaMes.getDay() + 6) % 7; // semana empieza en lunes
  const diasEnMes = new Date(anio, mes + 1, 0).getDate();

  daysGrid.innerHTML = "";

  for (let i = 0; i < offsetInicio; i++) {
    daysGrid.appendChild(document.createElement("div"));
  }

  for (let dia = 1; dia <= diasEnMes; dia++) {
    const fecha = new Date(anio, mes, dia);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = String(dia);

    if (!esFechaValida(fecha)) {
      btn.disabled = true;
      btn.className =
        "aspect-square flex items-center justify-center rounded-lg text-body-md text-outline opacity-40 cursor-not-allowed";
    } else {
      const iso = formatearFechaISO(fecha);
      const seleccionado = iso === selectedFecha;
      btn.className = seleccionado
        ? "aspect-square flex items-center justify-center rounded-lg text-body-md font-semibold border-2 border-secondary bg-secondary/5 text-secondary transition-all"
        : "aspect-square flex items-center justify-center rounded-lg text-body-md border border-outline-variant hover:border-secondary transition-all bg-surface-container-lowest text-on-surface";
      btn.addEventListener("click", () => seleccionarFecha(fecha));
    }

    daysGrid.appendChild(btn);
  }
}

function limpiarSeleccionHora() {
  selectedHora = null;
  selectedModalidad = null;
  selectedEnlace = "";
}

function seleccionarFecha(fecha) {
  selectedFecha = formatearFechaISO(fecha);
  const diaSemana = fecha.getDay();
  selectedFechaLabel = `${DIAS_CORTOS[diaSemana]} ${fecha.getDate()} ${MESES_CORTOS[fecha.getMonth()]}`;
  selectedFechaLarga = `${DIAS_LARGOS[diaSemana]} ${fecha.getDate()} de ${capitalizar(MESES_LARGOS[fecha.getMonth()])}, ${fecha.getFullYear()}`;
  limpiarSeleccionHora();

  renderCalendarioMes();
  dateSummary.textContent = selectedFechaLarga;
  renderHorasDelDiaSeleccionado();
  updateBookingSummary();
}

function renderHorasDelDiaSeleccionado() {
  const fecha = new Date(`${selectedFecha}T00:00:00`);
  const key = DIA_KEY_POR_GETDAY[fecha.getDay()];
  const turnos = generarHorasDelDia(disponibilidadMap[key] || []);

  timeOptionsContainer.innerHTML = "";

  if (turnos.length === 0) {
    timeOptionsContainer.innerHTML =
      '<p class="col-span-full text-body-md text-on-surface-variant p-4">No hay horarios configurados para este día.</p>';
    return;
  }

  turnos.forEach((turno) => {
    const ocupada = horasOcupadas.has(`${selectedFecha}|${turno.hora}`);
    const icono = (MODALIDADES[turno.modalidad] || MODALIDADES.presencial).icon;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = (MODALIDADES[turno.modalidad] || MODALIDADES.presencial).label;

    if (ocupada) {
      btn.disabled = true;
      btn.className =
        "py-3 px-2 rounded-full border border-outline-variant bg-surface-container-low text-outline flex items-center justify-center gap-1 cursor-not-allowed opacity-70";
      btn.innerHTML = `<span class="material-symbols-outlined text-[16px]">lock</span><span class="font-label-md text-label-md">${turno.hora}</span>`;
    } else {
      const seleccionada = turno.hora === selectedHora;
      btn.className = seleccionada ? TIME_SELECTED_CLASS : TIME_UNSELECTED_CLASS;
      btn.innerHTML = seleccionada
        ? `<span class="material-symbols-outlined text-[16px]">${icono}</span><span class="font-label-md text-label-md font-semibold">${turno.hora}</span>`
        : `<span class="material-symbols-outlined text-[16px] text-[#10b981] group-hover:scale-110 transition-transform">${icono}</span><span class="font-label-md text-label-md">${turno.hora}</span>`;
      btn.addEventListener("click", () => seleccionarHora(turno));
    }

    timeOptionsContainer.appendChild(btn);
  });
}

function seleccionarHora(turno) {
  selectedHora = turno.hora;
  selectedModalidad = turno.modalidad;
  selectedEnlace = turno.enlace || "";

  renderHorasDelDiaSeleccionado();
  updateBookingSummary();
}

function updateBookingSummary() {
  if (selectedFechaLabel && selectedHora) {
    const modalidadLabel = selectedModalidad ? ` · ${(MODALIDADES[selectedModalidad] || {}).label || ""}` : "";
    bookingSummary.textContent = `Resumen: ${selectedFechaLabel}, ${selectedHora}${modalidadLabel}`;
  } else if (selectedFechaLabel) {
    bookingSummary.textContent = `Resumen: ${selectedFechaLabel}, elige una hora`;
  } else {
    bookingSummary.textContent = "Resumen: selecciona fecha y hora";
  }
}

// Pantalla de confirmación: modalidad elegida y su dato de contacto
// (número al que llamarán, o enlace de la videollamada).
function renderResumenModalidad(telefonoWsp) {
  const summaryModalidad = document.getElementById("summary-modalidad");
  const extraRow = document.getElementById("summary-extra-row");
  const extraLabel = document.getElementById("summary-extra-label");
  const extraValue = document.getElementById("summary-extra-value");

  summaryModalidad.textContent = (MODALIDADES[selectedModalidad] || {}).label || "—";
  extraValue.textContent = "";

  if (selectedModalidad === "llamada") {
    extraLabel.textContent = "Te llamarán al";
    extraValue.textContent = telefonoWsp;
    extraRow.classList.remove("hidden");
  } else if (selectedModalidad === "virtual") {
    extraLabel.textContent = "Enlace de la reunión";
    if (selectedEnlace && /^https?:\/\//i.test(selectedEnlace)) {
      const enlaceA = document.createElement("a");
      enlaceA.href = selectedEnlace;
      enlaceA.target = "_blank";
      enlaceA.rel = "noopener";
      enlaceA.className = "text-secondary underline";
      enlaceA.textContent = "Unirse a la videollamada";
      extraValue.appendChild(enlaceA);
    } else {
      extraValue.textContent = "Te lo enviarán antes de la cita";
    }
    extraRow.classList.remove("hidden");
  } else {
    extraRow.classList.add("hidden");
  }
}

document.getElementById("calendar-prev-month").addEventListener("click", () => {
  calendarioMesActual = new Date(calendarioMesActual.getFullYear(), calendarioMesActual.getMonth() - 1, 1);
  renderCalendarioMes();
});

document.getElementById("calendar-next-month").addEventListener("click", () => {
  calendarioMesActual = new Date(calendarioMesActual.getFullYear(), calendarioMesActual.getMonth() + 1, 1);
  renderCalendarioMes();
});

async function inicializarCalendario() {
  try {
    [disponibilidadMap, horasOcupadas] = await Promise.all([fetchDisponibilidadMap(), fetchHorasOcupadas()]);
  } catch (err) {
    console.error("Error al cargar la disponibilidad:", err);
    disponibilidadMap = {};
    horasOcupadas = new Set();
  }
  renderCalendarioMes();
}

inicializarCalendario();

// ---------- Paso 3: registrar DNI (+ fecha/hora elegidas) ----------
confirmBtn.addEventListener("click", async () => {
  const dni = dniInput.value.trim();

  if (!selectedFecha || !selectedHora) {
    alert("Selecciona una fecha y una hora antes de registrar.");
    return;
  }

  if (!dni) {
    dniInput.classList.add("border-error");
    dniInput.focus();
    return;
  }
  dniInput.classList.remove("border-error");

  // El celular es obligatorio para toda reserva (celular peruano: 9 dígitos
  // empezando en 9): sirve para coordinar, recordar y, si la atención es
  // por llamada, para llamar a la persona.
  const telefonoWsp = wspInput.value.trim();
  if (!/^9\d{8}$/.test(telefonoWsp)) {
    wspInput.classList.add("border-error");
    wspInput.focus();
    return;
  }
  wspInput.classList.remove("border-error");

  confirmBtn.disabled = true;
  confirmBtn.textContent = "Registrando...";

  try {
    await setDoc(
      doc(dbPsico, PACIENTES_COLLECTION, dni),
      {
        dni,
        fecha: selectedFecha,
        fechaLabel: selectedFechaLabel,
        hora: selectedHora,
        modalidad: selectedModalidad,
        enlace: selectedModalidad === "virtual" ? selectedEnlace : "",
        telefonoWsp: telefonoWsp,
        // Una nueva reserva siempre arranca el ciclo de nuevo: si la persona
        // ya había sido atendida (o no asistió), esta es otra cita.
        estado: "reservada",
        creadoEn: serverTimestamp()
      },
      { merge: true }
    );

    try {
      await registrarHistorialCita(dni, {
        estado: "reservada",
        fecha: selectedFecha,
        hora: selectedHora,
        modalidad: selectedModalidad
      });
    } catch (historialErr) {
      // La reserva ya quedó guardada; si esto falla solo se pierde un punto
      // del historial de tendencia, no la reserva en sí.
      console.warn("No se pudo registrar el historial de la cita:", historialErr);
    }

    horasOcupadas.add(`${selectedFecha}|${selectedHora}`);
    summaryDni.textContent = dni;
    summaryDatetime.textContent = `${selectedFechaLabel}, ${selectedHora}`;
    renderResumenModalidad(telefonoWsp);

    limpiarSeleccionHora();
    wspInput.value = "";
    renderHorasDelDiaSeleccionado();
    updateBookingSummary();

    bookingFlow.classList.add("hidden");
    confirmationScreen.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    console.error("Error al registrar el DNI:", err);
    alert("No se pudo registrar tu DNI. Intenta nuevamente.");
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = originalBtnHtml;
  }
});

// Desde la confirmación, volver al flujo de reserva (Pasos 1-2-3).
backToBookingBtn.addEventListener("click", () => {
  confirmationScreen.classList.add("hidden");
  bookingFlow.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---------- Acceso del personal (psicólogo/RRHH) ----------
const adminLoginTrigger = document.getElementById("admin-login-trigger");
const adminLoginModal = document.getElementById("admin-login-modal");
const adminLoginClose = document.getElementById("admin-login-close");
const adminEmailInput = document.getElementById("admin-email");
const adminPasswordInput = document.getElementById("admin-password");
const adminLoginError = document.getElementById("admin-login-error");
const adminLoginSubmit = document.getElementById("admin-login-submit");

function openAdminLoginModal() {
  adminLoginError.classList.add("hidden");
  adminLoginModal.classList.remove("hidden");
  adminEmailInput.focus();
}

function closeAdminLoginModal() {
  adminLoginModal.classList.add("hidden");
  adminEmailInput.value = "";
  adminPasswordInput.value = "";
}

adminLoginTrigger.addEventListener("click", openAdminLoginModal);
adminLoginClose.addEventListener("click", closeAdminLoginModal);
adminLoginModal.addEventListener("click", (e) => {
  if (e.target === adminLoginModal) closeAdminLoginModal();
});

async function submitAdminLogin() {
  const email = adminEmailInput.value.trim();
  const password = adminPasswordInput.value;

  if (!email || !password) {
    adminLoginError.textContent = "Ingresa tu correo y contraseña.";
    adminLoginError.classList.remove("hidden");
    return;
  }

  // Solo el correo autorizado puede entrar al panel; se corta acá antes de
  // gastar un intento contra Firebase con cualquier otra cuenta.
  if (email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    adminLoginError.textContent = "Correo o contraseña incorrectos.";
    adminLoginError.classList.remove("hidden");
    return;
  }

  adminLoginSubmit.disabled = true;
  adminLoginSubmit.textContent = "Ingresando...";
  adminLoginError.classList.add("hidden");

  try {
    await signInWithEmailAndPassword(auth, email, password);
    window.location.href = "agenda.html";
  } catch (err) {
    console.error("Error de acceso:", err);
    adminLoginError.textContent = "Correo o contraseña incorrectos.";
    adminLoginError.classList.remove("hidden");
  } finally {
    adminLoginSubmit.disabled = false;
    adminLoginSubmit.textContent = "Ingresar";
  }
}

adminLoginSubmit.addEventListener("click", submitAdminLogin);
adminPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitAdminLogin();
});
