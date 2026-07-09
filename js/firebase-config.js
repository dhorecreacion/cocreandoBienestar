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

    export const ADMIN_UIDS = new Set([
    "bFsNvjtDXyZolGITD5KeZnBpE2B3"
    ]);

    export { app, auth, db, rtdb };