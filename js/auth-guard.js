// Protege las vistas del psicólogo/RRHH (V3-V9): si no hay sesión iniciada
// contra firebase-config.js, redirige a la pantalla de acceso (index.html).
// Esto es solo la barrera de UX; la barrera real vive en las reglas de
// Firestore de ese proyecto (deben exigir request.auth != null).
import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
  }
});
