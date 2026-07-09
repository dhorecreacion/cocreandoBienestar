// Tokens de diseño compartidos por todas las vistas de PsycheLink.
// Se carga una sola vez por sesión de navegación (cache de navegador) en vez de
// repetir este objeto de ~100 líneas inline en cada HTML.
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "surface-variant": "#e4e2e3",
        "primary-fixed": "#d8e3fb",
        "surface-container-lowest": "#ffffff",
        "surface-container-high": "#eae7e9",
        "secondary-container": "#2170e4",
        "error": "#ba1a1a",
        "tertiary-fixed-dim": "#ddc39d",
        "surface-container-highest": "#e4e2e3",
        "on-surface": "#1b1b1d",
        "on-error-container": "#93000a",
        "surface-container-low": "#f5f3f4",
        "secondary-fixed": "#d8e2ff",
        "inverse-on-surface": "#f3f0f2",
        "outline-variant": "#c5c6cd",
        "secondary": "#0058be",
        "on-primary": "#ffffff",
        "surface-tint": "#545f73",
        "on-primary-container": "#8590a6",
        "inverse-surface": "#303032",
        "on-error": "#ffffff",
        "tertiary": "#1e1200",
        "primary": "#091426",
        "on-secondary": "#ffffff",
        "inverse-primary": "#bcc7de",
        "on-tertiary-container": "#a38c6a",
        "error-container": "#ffdad6",
        "primary-container": "#1e293b",
        "on-tertiary-fixed": "#271902",
        "on-secondary-fixed": "#001a42",
        "background": "#fbf8fa",
        "tertiary-container": "#35260c",
        "surface-container": "#f0edef",
        "primary-fixed-dim": "#bcc7de",
        "on-tertiary": "#ffffff",
        "on-primary-fixed": "#111c2d",
        "on-secondary-container": "#fefcff",
        "tertiary-fixed": "#fadfb8",
        "surface": "#fbf8fa",
        "secondary-fixed-dim": "#adc6ff",
        "on-surface-variant": "#45474c",
        "on-background": "#1b1b1d",
        "surface-bright": "#fbf8fa",
        "on-tertiary-fixed-variant": "#564427",
        "surface-dim": "#dcd9db",
        "outline": "#75777d",
        "on-secondary-fixed-variant": "#004395",
        "on-primary-fixed-variant": "#3c475a"
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        lg: "0.5rem",
        xl: "0.75rem",
        full: "9999px"
      },
      spacing: {
        "container-max": "1440px",
        unit: "4px",
        "margin-mobile": "16px",
        "margin-desktop": "32px",
        gutter: "24px"
      },
      fontFamily: {
        "headline-md": ["Inter"],
        "body-lg": ["Inter"],
        "body-md": ["Inter"],
        "label-md": ["Inter"],
        "headline-lg-mobile": ["Inter"],
        "headline-lg": ["Inter"]
      },
      fontSize: {
        "headline-md": ["20px", { lineHeight: "28px", fontWeight: "600" }],
        "body-lg": ["16px", { lineHeight: "24px", fontWeight: "400" }],
        "body-md": ["14px", { lineHeight: "20px", fontWeight: "400" }],
        "label-md": ["12px", { lineHeight: "16px", letterSpacing: "0.02em", fontWeight: "500" }],
        "headline-lg-mobile": ["24px", { lineHeight: "32px", letterSpacing: "-0.01em", fontWeight: "600" }],
        "headline-lg": ["32px", { lineHeight: "40px", letterSpacing: "-0.02em", fontWeight: "600" }]
      }
    }
  }
};
