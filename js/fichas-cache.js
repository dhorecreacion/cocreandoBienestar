// Caché compartido de fichas de personal (nombre, área, cargo, sede, género,
// nacimiento) para reducir las lecturas al proyecto ficha-social.
//
// Estos datos casi nunca cambian, pero agenda, pacientes, indicadores y
// atención los releían de Firestore en CADA carga de página. Aquí se guardan
// en sessionStorage con vencimiento de 1 hora: la primera consulta paga las
// lecturas y las navegaciones siguientes salen gratis.
//
// A propósito se cachea SOLO información laboral (nunca sesiones clínicas ni
// diagnósticos), y en sessionStorage (se borra al cerrar la pestaña), en el
// navegador ya autenticado del psicólogo.
import { db } from "./firebase-config.js";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FICHAS_COLLECTION = "fichas";
const FICHAS_IN_CHUNK = 10; // límite seguro de valores por consulta "in"
const TTL_MS = 60 * 60 * 1000; // 1 hora
const STORAGE_KEY = "fichas-cache-v1";

function leerCache() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || {};
  } catch (err) {
    return {};
  }
}

function guardarCache(cache) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (err) {
    // Sin espacio o storage deshabilitado: se sigue funcionando sin caché.
  }
}

// Devuelve Map dni -> { nombre, area, cargo, sede, genero, nacimiento, activo }.
// "activo" sale de meta.activo (ficha_social): indica si el trabajador sigue
// habilitado o no; si el documento no trae ese campo, se asume activo (true)
// para no descartar por error fichas viejas sin ese dato.
// Los DNIs sin ficha también se recuerdan (como null) para no volver a
// consultarlos en cada carga.
export async function fetchFichasPorDnis(dnis) {
  const ahora = Date.now();
  const cache = leerCache();
  const resultado = new Map();
  const faltantes = [];

  dnis.forEach((dni) => {
    const entrada = cache[dni];
    if (entrada && ahora - entrada.t < TTL_MS) {
      if (entrada.f) resultado.set(dni, entrada.f);
    } else {
      faltantes.push(dni);
    }
  });

  if (faltantes.length > 0) {
    const chunks = [];
    for (let i = 0; i < faltantes.length; i += FICHAS_IN_CHUNK) {
      chunks.push(faltantes.slice(i, i + FICHAS_IN_CHUNK));
    }

    const snapshots = await Promise.all(
      chunks.map((chunk) => getDocs(query(collection(db, FICHAS_COLLECTION), where("personal.doc", "in", chunk))))
    );

    const encontrados = new Map();
    snapshots.forEach((snap) => {
      snap.forEach((d) => {
        const data = d.data();
        const personal = data.personal || {};
        const laboral = data.laboral || {};
        const meta = data.meta || {};
        if (!personal.doc) return;
        encontrados.set(personal.doc, {
          nombre: [personal.nombres, personal.apellidos].filter(Boolean).join(" "),
          area: laboral.area || "",
          cargo: laboral.cargo || "",
          sede: laboral.sede || "",
          genero: personal.genero || "",
          nacimiento: personal.nacimiento || "",
          activo: typeof meta.activo === "boolean" ? meta.activo : true
        });
      });
    });

    faltantes.forEach((dni) => {
      const ficha = encontrados.get(dni) || null;
      cache[dni] = { t: ahora, f: ficha };
      if (ficha) resultado.set(dni, ficha);
    });

    guardarCache(cache);
  }

  return resultado;
}

// Atajo para una sola persona (ficha de atención).
export async function fetchFicha(dni) {
  const mapa = await fetchFichasPorDnis([dni]);
  return mapa.get(dni) || null;
}
