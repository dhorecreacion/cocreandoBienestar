// Sidebar de navegación única para las vistas del psicólogo (V3-V9).
// Cada página solo declara <div id="sidebar-root" data-active="clave"></div>;
// este script arma el mismo menú en todas para que no queden versiones
// distintas (items, orden o estilos) por archivo.
//
// En pantallas chicas (< lg) el sidebar queda oculto fuera de pantalla y se
// abre con el botón hamburguesa (ver #app-sidebar / .sidebar-open en
// css/common.css); desde lg siempre está visible, como antes.
import { auth } from "./firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

var NAV_ITEMS = [
  { key: "agenda", label: "Agenda del día", href: "agenda.html", icon: "calendar_today" },
  { key: "pacientes", label: "Pacientes", href: "pacientes.html", icon: "groups" },
  { key: "disponibilidad", label: "Mi Disponibilidad", href: "disponibilidad.html", icon: "event_available" },
  { key: "indicadores", label: "Indicadores", href: "indicadores.html", icon: "analytics" },
  { key: "configuracion", label: "Configuración", href: "#", icon: "settings" }
];

var ACTIVE_CLASSES = "flex items-center gap-3 px-3 py-2.5 rounded-lg border-l-4 border-secondary bg-secondary/10 text-on-primary font-semibold transition-all";
var INACTIVE_CLASSES = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-on-primary/70 hover:text-on-primary hover:bg-primary-fixed-variant/20 transition-colors";

function navLinkHtml(item, activeKey) {
  var classes = item.key === activeKey ? ACTIVE_CLASSES : INACTIVE_CLASSES;
  return (
    '<a href="' + item.href + '" class="' + classes + '">' +
      '<span class="material-symbols-outlined text-[20px]">' + item.icon + "</span>" +
      '<span class="font-body-md text-body-md">' + item.label + "</span>" +
    "</a>"
  );
}

function abrirSidebar() {
  document.getElementById("app-sidebar").classList.add("sidebar-open");
  document.getElementById("sidebar-backdrop").classList.remove("hidden");
}

function cerrarSidebar() {
  document.getElementById("app-sidebar").classList.remove("sidebar-open");
  document.getElementById("sidebar-backdrop").classList.add("hidden");
}

function renderSidebar() {
  var root = document.getElementById("sidebar-root");
  if (!root) return;

  var activeKey = root.getAttribute("data-active") || "";
  var links = NAV_ITEMS.map(function (item) {
    return navLinkHtml(item, activeKey);
  }).join("");

  root.outerHTML =
    // Botón hamburguesa: solo visible antes de "lg", abre el sidebar.
    '<button type="button" id="sidebar-open-btn" class="lg:hidden fixed top-3 left-3 z-[60] p-2 rounded-full bg-primary text-on-primary shadow-lg">' +
      '<span class="material-symbols-outlined">menu</span>' +
    "</button>" +
    // Fondo oscuro detrás del sidebar cuando está abierto en móvil.
    '<div id="sidebar-backdrop" class="hidden lg:hidden fixed inset-0 bg-black/40 z-40"></div>' +
    '<aside id="app-sidebar" class="fixed left-0 top-0 h-full w-[240px] bg-primary flex flex-col py-gutter px-4 border-r border-outline-variant z-50">' +
      '<div class="mb-8 px-2 flex items-center justify-between">' +
        '<div>' +
          '<h1 class="font-headline-md text-headline-md font-bold text-on-primary tracking-tight">Psicología Ocupacional</h1>' +
          
        "</div>" +
        '<button type="button" id="sidebar-close-btn" class="lg:hidden p-1 text-on-primary/70 hover:text-on-primary">' +
          '<span class="material-symbols-outlined">close</span>' +
        "</button>" +
      "</div>" +
      '<nav class="flex-1 space-y-1">' + links + "</nav>" +
      '<div class="mt-auto pt-4 border-t border-on-primary/10 space-y-1">' +
        
        '<a href="#" class="flex items-center gap-3 px-3 py-2 rounded-lg text-on-primary/70 hover:text-on-primary transition-colors" id="sidebar-logout-link">' +
          '<span class="material-symbols-outlined text-[20px]">logout</span>' +
          '<span class="font-body-md">Cerrar Sesión</span>' +
        "</a>" +
      "</div>" +
    "</aside>";

  document.getElementById("sidebar-open-btn").addEventListener("click", abrirSidebar);
  document.getElementById("sidebar-close-btn").addEventListener("click", cerrarSidebar);
  document.getElementById("sidebar-backdrop").addEventListener("click", cerrarSidebar);

  // Al navegar a otra vista desde el menú (en móvil), no hace falta cerrar
  // a mano: la página siguiente arranca con el sidebar cerrado de nuevo.

  document.getElementById("sidebar-logout-link").addEventListener("click", async function (e) {
    e.preventDefault();
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Error al cerrar sesión:", err);
    }
    window.location.href = "index.html";
  });
}

document.addEventListener("DOMContentLoaded", renderSidebar);
