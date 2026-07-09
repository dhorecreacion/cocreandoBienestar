// Firebase para el registro público inicial (V1 - index.html).
// Proyecto separado de firebase-config.js a propósito: la pantalla pública no
// autentica al trabajador, así que solo debe poder ESCRIBIR su DNI aquí. Los
// datos clínicos completos viven en el proyecto de firebase-config.js, que
// solo se lee desde las vistas del psicólogo (ya autenticado).
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
export const DIAS_SEMANA = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];
