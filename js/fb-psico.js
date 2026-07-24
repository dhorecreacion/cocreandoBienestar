// Firebase para el registro público inicial (V1 - index.html).
// Proyecto separado de firebase-config.js a propósito: la pantalla pública no
// autentica al trabajador, así que solo debe poder ESCRIBIR su DNI aquí. Los
// datos clínicos completos viven en el proyecto de firebase-config.js, que
// solo se lee desde las vistas del psicólogo (ya autenticado).
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FB_PSICO_APP_NAME = "fb-psico";

const firebaseConfig = {
  apiKey: "AIzaSyC30C6vUPz7UJ9iSXXnmbbKIfHhf010fkk",
  authDomain: "conspsico-239e5.firebaseapp.com",
  projectId: "conspsico-239e5",
  storageBucket: "conspsico-239e5.firebasestorage.app",
  messagingSenderId: "605935156966",
  appId: "1:605935156966:web:54cda894a37849112b8527"
};

const app = getApps().some((a) => a.name === FB_PSICO_APP_NAME)
  ? getApp(FB_PSICO_APP_NAME)
  : initializeApp(firebaseConfig, FB_PSICO_APP_NAME);

export const dbPsico = getFirestore(app);
export const PACIENTES_COLLECTION = "pacientes";
export const DISPONIBILIDAD_COLLECTION = "disponibilidad";
export const HISTORIAL_CITAS_SUBCOLLECTION = "historial_citas";
// Ajustes generales del sistema, editables desde configuracion.html:
// configuracion/general (umbralSeguimientoDias) y configuracion/catalogos
// (derivaciones, acciones) — ver js/configuracion.js.
export const CONFIGURACION_COLLECTION = "configuracion";
export const DIAS_SEMANA = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];

// Registra un evento inmutable del ciclo de vida de una cita (reservada,
// no_asistio, reprogramada, atendida). A diferencia de pacientes/{dni} —que
// se sobreescribe en cada reserva nueva y por eso solo refleja el último
// desenlace— esto acumula un historial real, para poder calcular indicadores
// de tendencia (ej. % de asistencia) sin depender solo del estado actual.
// Se llama desde index.js (reservada), agenda.js (no_asistio/reprogramada)
// y atencion.js (atendida); si falla, no debe bloquear la acción principal
// (ya se guardó lo importante en pacientes/{dni}), solo se registra el error.
export async function registrarHistorialCita(dni, datos) {
  await addDoc(collection(dbPsico, PACIENTES_COLLECTION, dni, HISTORIAL_CITAS_SUBCOLLECTION), {
    ...datos,
    registradoEn: serverTimestamp()
  });
}

// Modalidades de atención (mismo vocabulario en disponibilidad, reserva,
// agenda e indicadores). "emergencia" existe solo como bloqueo de agenda,
// nunca como cita reservable.
export const MODALIDADES = {
  presencial: { label: "Presencial", icon: "domain" },
  virtual: { label: "Video", icon: "videocam" },
  llamada: { label: "Llamada telefónica", icon: "call" }
};
