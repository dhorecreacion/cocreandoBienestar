// Catálogo CIE-10 local (data/cie10.json): { "código": "nombre" }.
// Reemplaza la API pública de notasalud.com (dependía de internet y de un
// tercero) — ahora el psicólogo mantiene su propio diccionario editando ese
// archivo. Se usa desde atencion.js (buscador de Diagnóstico Presuntivo) e
// importador.js (nombres de diagnósticos al importar). Se carga una sola vez
// por página y se cachea en memoria.
let catalogoPromise = null;

export function cargarCie10() {
  if (!catalogoPromise) {
    catalogoPromise = fetch("data/cie10.json")
      .then((resp) => {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .catch((err) => {
        console.error("No se pudo cargar el catálogo CIE-10 local (data/cie10.json):", err);
        return {};
      });
  }
  return catalogoPromise;
}
