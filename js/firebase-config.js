    import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
    import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
    import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
    import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

    const firebaseConfig = {
    apiKey: "AIzaSyD7I29Q12YILYAEyfc2JPnIGn1mr97YDH0",
    authDomain: "ficha-social-427a1.firebaseapp.com",
    databaseURL: "https://ficha-social-427a1-default-rtdb.firebaseio.com",
    projectId: "ficha-social-427a1",
    storageBucket: "ficha-social-427a1.firebasestorage.app",
    messagingSenderId: "793852990137",
    appId: "1:793852990137:web:a084b1e1bad17409dfc168"
    };

    const app  = getApps().some((a) => a.name === "[DEFAULT]") ? getApp() : initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db   = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
    const rtdb = getDatabase(app);

    console.log("firebase-config cargado");

    // Correos autorizados para entrar al panel del psicólogo. Se usan tanto
    // en el formulario de acceso (index.html) como en el guardia de las 5
    // páginas protegidas (js/auth-guard.js), para que no baste con una
    // cuenta cualquiera del proyecto de Firebase. Agregar una cuenta más
    // = agregar su correo aquí (en minúsculas); la cuenta debe existir ya
    // en el proyecto de Firebase Authentication.
    export const ADMIN_EMAILS = new Set([
      "pbernuy@mibsac.com" 
    ]);

    export { app, auth, db, rtdb };


    