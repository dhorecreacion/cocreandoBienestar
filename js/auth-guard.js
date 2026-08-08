// Protege las vistas del psicólogo/RRHH (V3-V9): si no hay sesión iniciada
// contra firebase-config.js, redirige a la pantalla de acceso (index.html).
// Además exige que sea uno de los correos autorizados (ADMIN_EMAILS): si
// alguien entrara con otra cuenta válida del mismo proyecto de Firebase, se
// cierra su sesión y se le redirige igual, en vez de dejarlo pasar.
// Esto es solo la barrera de UX; la barrera real vive en las reglas de
// Firestore de ese proyecto (deben exigir request.auth != null y, si aplica,
// restringir por UID/correo).
import { auth, ADMIN_EMAILS } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  if (!ADMIN_EMAILS.has((user.email || "").toLowerCase())) {
    signOut(auth).finally(() => {
      window.location.href = "index.html";
    });
  }
});
