import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Cobrador,
  Conectado,
  Datos,
  Estado,
  InfoDb,
  Menu,
  Migracion,
  Participante,
  Sondeo,
  aCentimos,
  deCentimos,
  eur,
  fmtFecha,
  hoy,
  normalizar,
} from "./types";
import AboutDialog from "./components/AboutDialog";
import DonateButton from "./components/DonateButton";
import { ToastStack, useToasts } from "./components/Toasts";
import BaseDatosDialog from "./components/BaseDatosDialog";
import Dialogo from "./components/Dialogo";
import CeldaTexto from "./components/CeldaTexto";
import CeldaSelect from "./components/CeldaSelect";
import GastosView from "./components/Gastos";
import TraspasosView from "./components/Traspasos";
import { copiar, informeCsv, nombreArchivo, textoPendientes } from "./exportar";

type Modal = null | "unlock" | "setup" | "config" | "password" | "about" | "db" | "importar";

// Cada cuánto se comprueba si otro equipo ha guardado algo
const SONDEO_MS = 2500;
const RECONEXION_MS = 5000;
type Filtro = "todos" | "pendientes" | "pagados";
type Vista = "personas" | "gastos" | "traspasos";
type Columna = "estado" | "nombre" | "importe" | "cobro";
type Orden = { col: Columna; dir: 1 | -1 };

// Preferencias de cobro recordadas entre sesiones
const LS_COBRADOR = "celebracion.cobrador";
const LS_METODO = "celebracion.metodo";
const LS_VISTA = "celebracion.vista";
const LS_CAJA = "celebracion.caja";
const leerLS = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const guardarLS = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* sin almacenamiento: se ignora */
  }
};

const METODOS: { id: string; txt: string; ico: string }[] = [
  { id: "efectivo", txt: "Efectivo", ico: "💶" },
  { id: "bizum", txt: "Bizum", ico: "📱" },
];

export default function App() {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [errorCarga, setErrorCarga] = useState("");
  const [estado, setEstado] = useState<Estado>({
    tiene_password: true,
    desbloqueado: false,
  });
  const [modal, setModal] = useState<Modal>(null);
  const [trasDesbloquear, setTrasDesbloquear] = useState<Modal>(null);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [busqueda, setBusqueda] = useState("");
  const [orden, setOrden] = useState<Orden>({ col: "nombre", dir: 1 });
  const [ultimoCobrador, setUltimoCobrador] = useState<number | null>(() => {
    const v = leerLS(LS_COBRADOR);
    return v ? Number(v) : null;
  });
  const [ultimoMetodo, setUltimoMetodo] = useState<string>(
    () => leerLS(LS_METODO) ?? "efectivo"
  );
  // Claves "p<id>" (participantes) y "g<id>" (gastos)
  const [resaltados, setResaltados] = useState<Set<string>>(new Set());
  const [vista, setVista] = useState<Vista>(() => {
    const v = leerLS(LS_VISTA);
    return v === "gastos" || v === "traspasos" ? v : "personas";
  });
  const [infoDb, setInfoDb] = useState<InfoDb | null>(null);
  const [conectados, setConectados] = useState<Conectado[]>([]);
  const [sinConexion, setSinConexion] = useState(false);
  const [migracion, setMigracion] = useState<Migracion | null>(null);
  const [cajaAbierta, setCajaAbierta] = useState(leerLS(LS_CAJA) === "1");
  const { toasts, avisar, cerrar } = useToasts();
  const versionRef = useRef<number | null>(null);
  const datosRef = useRef<Datos | null>(null);
  datosRef.current = datos;

  const buscarRef = useRef<HTMLInputElement>(null);
  const nuevoRef = useRef<HTMLInputElement>(null);
  const nuevoGastoRef = useRef<HTMLInputElement>(null);
  const nuevoTraspasoRef = useRef<HTMLInputElement>(null);
  const vistaRef = useRef(vista);
  vistaRef.current = vista;

  const cargarInfoDb = useCallback(async () => {
    try {
      setInfoDb(await invoke<InfoDb>("info_db"));
    } catch {
      /* se reintenta en el siguiente sondeo */
    }
  }, []);

  /** Recarga los datos. Con `remoto`, resalta las filas que ha cambiado otro equipo. */
  const refrescar = useCallback(async (remoto = false) => {
    try {
      const [d, e] = await Promise.all([
        invoke<Datos>("cargar"),
        invoke<Estado>("estado"),
      ]);
      const antes = datosRef.current;
      if (remoto && antes) {
        const previos = new Map<string, string>([
          ...antes.participantes.map((p) => ["p" + p.id, JSON.stringify(p)] as [string, string]),
          ...antes.gastos.map((g) => ["g" + g.id, JSON.stringify(g)] as [string, string]),
          ...antes.traspasos.map((t) => ["t" + t.id, JSON.stringify(t)] as [string, string]),
        ]);
        const cambiados = [
          ...d.participantes.map((p) => ["p" + p.id, JSON.stringify(p)]),
          ...d.gastos.map((g) => ["g" + g.id, JSON.stringify(g)]),
          ...d.traspasos.map((t) => ["t" + t.id, JSON.stringify(t)]),
        ]
          .filter(([k, v]) => previos.get(k) !== v)
          .map(([k]) => k);
        if (cambiados.length > 0) setResaltados(new Set(cambiados));
      }
      setDatos(d);
      setEstado(e);
      setErrorCarga("");
    } catch (err) {
      setErrorCarga(String(err));
    }
  }, []);

  useEffect(() => {
    (async () => {
      await refrescar();
      cargarInfoDb();
      // ¿Hay datos de una versión anterior guardados solo en este equipo?
      try {
        const m = await invoke<Migracion | null>("migracion_pendiente");
        if (m) {
          setMigracion(m);
          setModal("importar");
        }
      } catch {
        /* sin conexión: no se ofrece */
      }
    })();
  }, [refrescar, cargarInfoDb]);

  const reintentarConexion = useCallback(async () => {
    try {
      const info = await invoke<InfoDb>("reconectar");
      setInfoDb(info);
      if (info.conectado) {
        setSinConexion(false);
        versionRef.current = null;
      }
    } catch {
      /* se muestra el error en pantalla */
    }
    await refrescar();
  }, [refrescar]);

  // Sondeo: detecta cambios de otros equipos y quién está conectado
  useEffect(() => {
    let vivo = true;
    let ocupado = false;
    const tick = async () => {
      if (ocupado || document.hidden) return;
      ocupado = true;
      try {
        if (sinConexion) {
          const info = await invoke<InfoDb>("reconectar");
          if (!vivo) return;
          setInfoDb(info);
          if (info.conectado) {
            setSinConexion(false);
            versionRef.current = null;
            await refrescar();
            avisar({ tipo: "ok", texto: "Conexión recuperada" });
          }
        } else {
          const r = await invoke<Sondeo>("sondeo");
          if (!vivo) return;
          setConectados(r.conectados);
          if (versionRef.current !== null && r.version !== versionRef.current) {
            await refrescar(true);
          }
          versionRef.current = r.version;
        }
      } catch (err) {
        const msg = String(err);
        // Un bloqueo momentáneo por otro equipo no es una desconexión
        if (vivo && !msg.startsWith("Otro equipo")) {
          setSinConexion(true);
          cargarInfoDb();
        }
      } finally {
        ocupado = false;
      }
    };
    tick();
    const t = window.setInterval(tick, sinConexion ? RECONEXION_MS : SONDEO_MS);
    return () => {
      vivo = false;
      window.clearInterval(t);
    };
  }, [sinConexion, refrescar, cargarInfoDb, avisar]);

  // Atajos: Ctrl+F buscar · Ctrl+N añadir · Ctrl+1/2/3 cambiar de pestaña ·
  // escribir una letra salta al buscador
  useEffect(() => {
    const irA = (v: Vista) => {
      setVista(v);
      guardarLS(LS_VISTA, v);
      setBusqueda("");
    };
    const onKey = (ev: KeyboardEvent) => {
      if (modal) return;
      const el = ev.target as HTMLElement | null;
      const escribiendo =
        !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable);
      if (ev.ctrlKey || ev.metaKey) {
        const k = ev.key.toLowerCase();
        if (k === "f") {
          ev.preventDefault();
          buscarRef.current?.focus();
          buscarRef.current?.select();
        } else if (k === "n") {
          ev.preventDefault();
          const refs = { personas: nuevoRef, gastos: nuevoGastoRef, traspasos: nuevoTraspasoRef };
          refs[vistaRef.current].current?.focus();
        } else if (k === "1" || k === "2" || k === "3") {
          ev.preventDefault();
          irA((["personas", "gastos", "traspasos"] as Vista[])[Number(k) - 1]);
        }
        return;
      }
      // Empezar a escribir busca, sin tener que ir al cuadro de búsqueda
      if (!escribiendo && !ev.altKey && ev.key.length === 1 && ev.key !== " ") {
        buscarRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  // La fila «+ Nuevo» se pega justo bajo la cabecera: hay que medirla (cambia con el zoom)
  useEffect(() => {
    const medir = () => {
      const th = document.querySelector("thead th");
      if (th) {
        document.documentElement.style.setProperty(
          "--thead-h",
          Math.round(th.getBoundingClientRect().height) + "px"
        );
      }
    };
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, [vista, datos]);

  // Quitar el resaltado de las filas tocadas tras un momento
  useEffect(() => {
    if (resaltados.size === 0) return;
    const t = window.setTimeout(() => setResaltados(new Set()), 1600);
    return () => window.clearTimeout(t);
  }, [resaltados]);
  const resaltar = (clave: string) => setResaltados(new Set([clave]));
  const cambiarVista = (v: Vista) => {
    setVista(v);
    guardarLS(LS_VISTA, v);
    setBusqueda("");
  };

  /** Ejecuta una acción, refresca y avisa del resultado. Devuelve true si fue bien. */
  const ejecutar = async (
    fn: () => Promise<unknown>,
    exito?: { texto: string; deshacer?: () => void }
  ): Promise<boolean> => {
    try {
      await fn();
      await refrescar();
      if (exito) avisar({ tipo: "ok", ...exito });
      return true;
    } catch (err) {
      avisar({ tipo: "error", texto: String(err) });
      await refrescar();
      return false;
    }
  };

  const lista = useMemo(() => {
    if (!datos) return [];
    const q = normalizar(busqueda);
    const filtrados = datos.participantes.filter((p) => {
      if (filtro === "pendientes" && p.pagado) return false;
      if (filtro === "pagados" && !p.pagado) return false;
      if (q && !normalizar(p.nombre + " " + p.notas).includes(q)) return false;
      return true;
    });
    const cmpNombre = (a: Participante, b: Participante) =>
      a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" });
    const cmp = (a: Participante, b: Participante): number => {
      switch (orden.col) {
        case "estado":
          return Number(a.pagado) - Number(b.pagado);
        case "importe":
          return a.debe - b.debe;
        case "cobro":
          return (a.fecha_pago ?? "9999").localeCompare(b.fecha_pago ?? "9999");
        default:
          return cmpNombre(a, b);
      }
    };
    return [...filtrados].sort(
      (a, b) => cmp(a, b) * orden.dir || cmpNombre(a, b)
    );
  }, [datos, filtro, busqueda, orden]);

  /** Abre un diálogo de administración; si está bloqueado pide antes la contraseña. */
  const abrirAdmin = (destino: Modal) => {
    if (estado.desbloqueado) {
      setModal(destino);
    } else {
      setTrasDesbloquear(destino);
      setModal(estado.tiene_password ? "unlock" : "setup");
    }
  };

  const dialogoDb = modal === "db" && (
    <BaseDatosDialog
      info={infoDb}
      conectados={conectados}
      onReintentar={reintentarConexion}
      onCancel={() => setModal(null)}
    />
  );

  if (!datos) {
    return (
      <div className="loading">
        {errorCarga ? (
          <div className="loaderr">
            <b>No se han podido cargar los datos.</b>
            <p className="muted">{errorCarga}</p>
            {infoDb && (
              <p className="muted">
                Base de datos compartida: <code>{infoDb.ruta}</code>
              </p>
            )}
            <div className="actions center">
              <button className="btn primary" onClick={reintentarConexion}>
                Reintentar
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="spinner" /> Cargando…
          </>
        )}
      </div>
    );
  }

  const { config, resumen, cobradores } = datos;
  const reales = cobradores.filter((c) => c.id !== 0);
  const nombreCobrador = (id: number | null) =>
    reales.find((c) => c.id === id)?.nombre ?? null;

  const defCobrador: number | null =
    reales.length === 0
      ? null
      : reales.some((c) => c.id === ultimoCobrador)
      ? ultimoCobrador
      : reales[0].id;

  const elegirCobrador = (id: number) => {
    setUltimoCobrador(id);
    guardarLS(LS_COBRADOR, String(id));
  };
  const elegirMetodo = (m: string) => {
    setUltimoMetodo(m);
    guardarLS(LS_METODO, m);
  };

  // Si la búsqueda deja una sola persona y está pendiente, Enter la cobra
  const unicoPendiente =
    vista === "personas" && busqueda.trim() !== "" && lista.length === 1 && !lista[0].pagado
      ? lista[0]
      : null;

  const exportar = async () => {
    try {
      const ruta = await save({
        defaultPath: nombreArchivo(datos),
        filters: [{ name: "CSV para Excel", extensions: ["csv"] }],
      });
      if (typeof ruta !== "string") return;
      const guardado = await invoke<string>("exportar_csv", {
        ruta,
        contenido: informeCsv(datos),
      });
      avisar({ tipo: "ok", texto: `Informe guardado en ${guardado}` });
    } catch (err) {
      avisar({ tipo: "error", texto: String(err) });
    }
  };

  const exportarPdf = async () => {
    try {
      const { informePdf, nombrePdf } = await import("./informePdf");
      const ruta = await save({
        defaultPath: nombrePdf(datos),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof ruta !== "string") return;
      const guardado = await invoke<string>("exportar_pdf", {
        ruta,
        contenido: Array.from(informePdf(datos)),
      });
      avisar({ tipo: "ok", texto: `Resumen PDF guardado en ${guardado}` });
    } catch (err) {
      avisar({ tipo: "error", texto: String(err) });
    }
  };

  const copiarPendientes = async () => {
    const ok = await copiar(textoPendientes(datos));
    avisar(
      ok
        ? {
            tipo: "ok",
            texto: `Lista de ${resumen.pendientes} ${
              resumen.pendientes === 1 ? "persona pendiente copiada" : "personas pendientes copiada"
            }: pégala donde quieras`,
          }
        : { tipo: "error", texto: "No se ha podido copiar al portapapeles" }
    );
  };

  const sinPrecios = config.precio_comida === 0 && config.precio_regalo === 0;
  const pct =
    resumen.total_esperado > 0
      ? Math.round((resumen.cobrado / resumen.total_esperado) * 100)
      : 0;
  const todoCobrado = resumen.total_personas > 0 && resumen.pendientes === 0;

  // ─── Acciones ───

  const trasAcceso = async () => {
    await refrescar();
    setModal(trasDesbloquear);
    setTrasDesbloquear(null);
  };

  const restaurarPago = (p: Participante) =>
    invoke("marcar_pagado", {
      id: p.id,
      pagado: p.pagado,
      cobradorId: p.pagado ? p.cobrador_id : null,
      metodo: p.pagado ? p.metodo : null,
      fecha: p.pagado ? p.fecha_pago : null,
    });

  const marcar = (p: Participante, pagado: boolean) => {
    resaltar("p" + p.id);
    const metodoTxt = METODOS.find((m) => m.id === ultimoMetodo)?.txt ?? "";
    const quien = nombreCobrador(defCobrador);
    ejecutar(
      () =>
        invoke("marcar_pagado", {
          id: p.id,
          pagado,
          cobradorId: pagado ? defCobrador : null,
          metodo: pagado ? ultimoMetodo : null,
          // Lo que estaba viendo: si otro equipo lo ha cambiado, se rechaza
          desde: p.pagado,
        }),
      {
        texto: pagado
          ? `${p.nombre}: ${eur(p.debe)} cobrados en ${metodoTxt.toLowerCase()}${
              quien ? ` por ${quien}` : ""
            }`
          : `${p.nombre} vuelve a estar pendiente`,
        deshacer: () => ejecutar(() => restaurarPago(p)),
      }
    );
  };

  const cambiarCobro = (
    p: Participante,
    cambios: { cobradorId?: number; metodo?: string; fecha?: string }
  ) => {
    const cobradorId =
      reales.length === 0
        ? null
        : cambios.cobradorId ?? p.cobrador_id ?? defCobrador;
    const metodo = cambios.metodo ?? p.metodo ?? ultimoMetodo;
    ejecutar(() =>
      invoke("marcar_pagado", {
        id: p.id,
        pagado: true,
        cobradorId,
        metodo,
        fecha: cambios.fecha ?? p.fecha_pago,
      })
    );
  };

  /** Guarda solo los campos cambiados, para no pisar lo que otro equipo edite a la vez. */
  const guardarFila = (
    p: Participante,
    cambios: {
      nombre?: string;
      comida?: boolean;
      notas?: string;
      menuId?: number; // 0 = sin menú
      importeRegalo?: number; // céntimos; -1 = regalo general
    }
  ) => {
    resaltar("p" + p.id);
    return ejecutar(() =>
      invoke("actualizar_participante", {
        id: p.id,
        nombre: cambios.nombre ?? null,
        comida: cambios.comida ?? null,
        notas: cambios.notas ?? null,
        menuId: cambios.menuId ?? null,
        importeRegalo: cambios.importeRegalo ?? null,
      })
    );
  };

  /** Valor del selector de modalidad: «regalo», «comida» (sin menú) o «m:ID». */
  const modalidadDe = (p: Participante) =>
    !p.comida ? "regalo" : p.menu_id ? `m:${p.menu_id}` : "comida";

  const cambiarModalidad = (p: Participante, v: string) => {
    if (v === "regalo") return guardarFila(p, { comida: false });
    if (v === "comida") return guardarFila(p, { comida: true, menuId: 0 });
    return guardarFila(p, { comida: true, menuId: Number(v.slice(2)) });
  };

  const anadir = (p: Partial<Participante>) =>
    ejecutar(
      () =>
        invoke("guardar_participante", {
          participante: {
            id: null,
            nombre: "",
            comida: true,
            pagado: false,
            fecha_pago: null,
            notas: "",
            importe_regalo: null,
            debe: 0,
            cobrador_id: null,
            cobrador: null,
            metodo: null,
            menu_id: null,
            menu: null,
            ...p,
          },
        }),
      { texto: `${(p.nombre ?? "").trim()} añadido/a` }
    );

  const eliminar = (p: Participante) =>
    ejecutar(() => invoke("eliminar_participante", { id: p.id }), {
      texto: `${p.nombre} eliminado/a${p.pagado ? ` (había pagado ${eur(p.debe)})` : ""}`,
      deshacer: () =>
        ejecutar(() => invoke("restaurar_participante", { participante: p }), {
          texto: `${p.nombre} recuperado/a`,
        }),
    });

  const ordenarPor = (col: Columna) =>
    setOrden((o) => (o.col === col ? { col, dir: (o.dir * -1) as 1 | -1 } : { col, dir: 1 }));

  const cabecera = (col: Columna, txt: string, clase = "") => (
    <th className={"sortable " + clase} aria-sort={orden.col === col ? (orden.dir === 1 ? "ascending" : "descending") : "none"}>
      <button onClick={() => ordenarPor(col)}>
        {txt}
        <span className="sort-ico">
          {orden.col === col ? (orden.dir === 1 ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );

  // Primeros pasos: visibles mientras falte algo esencial
  const pasos = [
    {
      hecho: estado.tiene_password,
      txt: "Crea la contraseña de administrador",
      accion: () => abrirAdmin("config"),
      boton: "Crear",
    },
    {
      hecho: !sinPrecios,
      txt: "Fija el precio de comida y regalo",
      accion: () => abrirAdmin("config"),
      boton: "Configurar",
    },
    {
      hecho: reales.length > 0,
      txt: "Añade cobradores (opcional)",
      accion: () => abrirAdmin("config"),
      boton: "Añadir",
    },
    {
      hecho: resumen.total_personas > 0,
      txt: "Apunta a los participantes",
      accion: () => nuevoRef.current?.focus(),
      boton: "Añadir",
    },
  ];
  const mostrarPasos = sinPrecios || resumen.total_personas === 0;

  const conteo: Record<Filtro, number> = {
    todos: resumen.total_personas,
    pendientes: resumen.pendientes,
    pagados: resumen.pagados,
  };

  return (
    <div className={"app" + (sinConexion ? " offline" : "")}>
      <header className="topbar">
        <div className="titulo">
          <h1>{config.evento || "Comida de celebración"}</h1>
          <div className="meta">
            {config.fecha && <span>📅 {config.fecha}</span>}
            {config.regalo_desc && <span>🎁 {config.regalo_desc}</span>}
            {!sinPrecios && (
              <span>
                🍽 Comida {eur(config.precio_comida)} · 🎁 Regalo{" "}
                {eur(config.precio_regalo)} <span className="muted">por persona</span>
              </span>
            )}
          </div>
        </div>
        <div className="toolbar">
          <ChipConexion
            info={infoDb}
            conectados={conectados}
            sinConexion={sinConexion}
            onClick={() => setModal("db")}
          />
          {estado.desbloqueado ? (
            <div className="admin-group" role="group" aria-label="Administración">
              <span className="admin-badge">Administrador</span>
              <button className="btn ghost" onClick={() => setModal("config")}>
                ⚙ Parámetros
              </button>
              <button
                className="btn ghost"
                title="Cambiar contraseña"
                onClick={() => setModal("password")}
              >
                🔑
              </button>
              <button
                className="btn ghost"
                title="Salir del modo administrador"
                onClick={() =>
                  ejecutar(() => invoke("bloquear"), {
                    texto: "Modo administrador cerrado",
                  })
                }
              >
                🔓 Bloquear
              </button>
            </div>
          ) : (
            <button
              className="btn"
              title="Desbloquear para cambiar precios y cobradores"
              onClick={() => abrirAdmin(null)}
            >
              🔒 Administrador
            </button>
          )}
          <button
            className="btn"
            title="Guardar un informe en CSV para abrirlo con Excel"
            onClick={exportar}
          >
            ⬇ Exportar
          </button>
          <button
            className="btn"
            title="Generar un resumen completo en PDF"
            onClick={exportarPdf}
          >
            📄 Resumen PDF
          </button>
          <button className="btn" title="Imprimir listado" onClick={() => window.print()}>
            🖨 Imprimir
          </button>
          <button className="btn" title="Acerca de y manual" onClick={() => setModal("about")}>
            ℹ
          </button>
          <DonateButton compact />
        </div>
      </header>

      {sinConexion && (
        <div className="offline-banner" role="alert">
          <span className="spinner small" />
          <div>
            <b>Sin conexión con la base de datos compartida.</b> Reintentando cada pocos
            segundos… Mientras tanto no se pueden guardar cambios.
            {infoDb && (
              <div className="muted small">
                {infoDb.ruta}
                {infoDb.error ? ` · ${infoDb.error}` : ""}
              </div>
            )}
          </div>
          <button className="btn small" onClick={reintentarConexion}>
            Reintentar ahora
          </button>
        </div>
      )}

      {mostrarPasos && (
        <section className="onboarding">
          <h2>Primeros pasos</h2>
          <ol>
            {pasos.map((p, i) => (
              <li key={i} className={p.hecho ? "done" : ""}>
                <span className="step-ico">{p.hecho ? "✓" : i + 1}</span>
                <span className="step-txt">{p.txt}</span>
                {!p.hecho && (
                  <button className="btn small" onClick={p.accion}>
                    {p.boton}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="cards">
        <Card
          titulo="Participantes"
          valor={String(resumen.total_personas)}
          onClick={() => setFiltro("todos")}
        >
          {resumen.con_comida} con comida · {resumen.solo_regalo} solo regalo
        </Card>
        <Card titulo="Total previsto" valor={eur(resumen.total_esperado)}>
          Comida {eur(resumen.total_comida)} · Regalo {eur(resumen.total_regalo)}
        </Card>
        <Card
          titulo="Cobrado"
          valor={eur(resumen.cobrado)}
          clase="good"
          activo={filtro === "pagados"}
          onClick={() => setFiltro("pagados")}
        >
          <div className="mini-progress" aria-label={pct + "% cobrado"}>
            <div className="bar" style={{ width: pct + "%" }} />
          </div>
          {pct}% · {resumen.pagados} de {resumen.total_personas} han pagado
        </Card>
        {todoCobrado ? (
          <Card titulo="Falta por cobrar" valor="¡Todo cobrado!" clase="good done">
            No queda nadie pendiente 🎉
          </Card>
        ) : (
          <Card
            titulo="Falta por cobrar"
            valor={eur(resumen.pendiente)}
            clase="bad"
            activo={filtro === "pendientes"}
            onClick={() => setFiltro("pendientes")}
          >
            {resumen.pendientes} {resumen.pendientes === 1 ? "persona" : "personas"} ·
            Comida {eur(resumen.pendiente_comida)} · Regalo {eur(resumen.pendiente_regalo)}
          </Card>
        )}
      </section>

      {(resumen.pagados > 0 || resumen.gastos > 0) && (
        <section className="caja">
          <div className="caja-head">
            <button
              className="caja-toggle"
              aria-expanded={cajaAbierta}
              title={cajaAbierta ? "Ocultar el detalle por cobrador" : "Ver el detalle por cobrador"}
              onClick={() => {
                setCajaAbierta(!cajaAbierta);
                guardarLS(LS_CAJA, cajaAbierta ? "0" : "1");
              }}
            >
              <span className="chev">▶</span> ¿Dónde está el dinero?
            </button>
            <span className="pill" title="Lo cobrado menos lo gastado">
              En manos de los cobradores <b>{eur(resumen.cobrado - resumen.gastado)}</b>
            </span>
            <span className="muted small">
              Cobrado: 💶 {eur(resumen.cobrado_efectivo)} · 📱 {eur(resumen.cobrado_bizum)}
              {resumen.gastado > 0 && <> · gastado {eur(resumen.gastado)}</>}
            </span>
            {reales.length >= 2 && (
              <button
                className="btn small caja-btn"
                title="Apuntar dinero que un cobrador le pasa a otro"
                onClick={() => {
                  cambiarVista("traspasos");
                  window.setTimeout(() => nuevoTraspasoRef.current?.focus(), 50);
                }}
              >
                ⇄ Traspasar
              </button>
            )}
          </div>
          {cajaAbierta && cobradores.length > 0 && (
            <div className="caja-list">
              {cobradores.map((c) => (
                <div
                  className={"caja-item" + (c.id === 0 ? " sin" : "") + (c.saldo < 0 ? " negativo" : "")}
                  key={c.id}
                >
                  <div className="caja-nombre">
                    {c.id === 0 ? "⚠ " : "👤 "}
                    {c.nombre}
                  </div>
                  <div className="caja-total" title="Lo que debería tener ahora">
                    {eur(c.saldo)}
                  </div>
                  <div className="caja-desglose">
                    <span>
                      Cobrado {eur(c.total)}
                      {c.efectivo > 0 && c.bizum > 0 && (
                        <span className="muted">
                          {" "}
                          (💶 {eur(c.efectivo)} · 📱 {eur(c.bizum)})
                        </span>
                      )}
                      {c.efectivo > 0 && c.bizum === 0 && <span className="muted"> 💶</span>}
                      {c.bizum > 0 && c.efectivo === 0 && <span className="muted"> 📱</span>}
                    </span>
                    {c.gastado > 0 && <span className="neg">− gastado {eur(c.gastado)}</span>}
                    {c.recibido > 0 && (
                      <span className="pos">+ traspasado de otros {eur(c.recibido)}</span>
                    )}
                    {c.entregado > 0 && (
                      <span className="neg">− traspasado a otros {eur(c.entregado)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <nav className="vistas" role="tablist" aria-label="Sección">
        <button
          role="tab"
          aria-selected={vista === "personas"}
          className={vista === "personas" ? "on" : ""}
          onClick={() => cambiarVista("personas")}
        >
          👥 Participantes <span className="count">{resumen.total_personas}</span>
        </button>
        <button
          role="tab"
          aria-selected={vista === "gastos"}
          className={vista === "gastos" ? "on" : ""}
          onClick={() => cambiarVista("gastos")}
        >
          🎁 Gastos del regalo <span className="count">{resumen.gastos}</span>
          {resumen.cobrado_regalo > 0 && (
            <span className={"vista-extra" + (resumen.disponible_regalo < 0 ? " bad" : "")}>
              {resumen.disponible_regalo < 0 ? "excedido " : "quedan "}
              {eur(Math.abs(resumen.disponible_regalo))}
            </span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={vista === "traspasos"}
          className={vista === "traspasos" ? "on" : ""}
          onClick={() => cambiarVista("traspasos")}
        >
          ⇄ Traspasos <span className="count">{resumen.traspasos}</span>
        </button>
      </nav>

      <section className="listbar">
        <div className="searchbox">
          <span className="search-ico">⌕</span>
          <input
            ref={buscarRef}
            className="search"
            placeholder={
              vista === "gastos"
                ? "Buscar gasto por concepto o cobrador…  (Ctrl+F)"
                : vista === "traspasos"
                ? "Buscar traspaso por cobrador o nota…  (Ctrl+F)"
                : "Buscar por nombre o notas…  (Ctrl+F)"
            }
            value={busqueda}
            onChange={(ev) => setBusqueda(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") setBusqueda("");
              if (ev.key === "Enter" && unicoPendiente) {
                ev.preventDefault();
                marcar(unicoPendiente, true);
                setBusqueda("");
              }
            }}
          />
          {busqueda && (
            <button className="clear" aria-label="Borrar búsqueda" onClick={() => setBusqueda("")}>
              ✕
            </button>
          )}
        </div>
        {vista === "personas" && (
        <div className="seg" role="radiogroup" aria-label="Filtrar la lista">
          {(["todos", "pendientes", "pagados"] as Filtro[]).map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={filtro === f}
              className={filtro === f ? "on" : ""}
              onClick={() => setFiltro(f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
              <span className="count">{conteo[f]}</span>
            </button>
          ))}
        </div>
        )}
        {vista === "personas" && filtro === "pendientes" && resumen.pendientes > 0 && (
          <button
            className="btn small"
            title="Copiar la lista de quien falta por pagar, para pegarla en WhatsApp o en un correo"
            onClick={copiarPendientes}
          >
            📋 Copiar lista
          </button>
        )}

        {vista !== "traspasos" && (
        <div
          className="quickpay"
          title={
            vista === "gastos"
              ? "Valores propuestos para los gastos nuevos"
              : "Se aplica al pulsar «Cobrar» en cualquier fila"
          }
        >
          <span className="muted">{vista === "gastos" ? "Paga:" : "Al cobrar:"}</span>
          {reales.length > 0 && (
            <select
              className="inline"
              aria-label="Quién cobra"
              value={defCobrador ?? ""}
              onChange={(ev) => elegirCobrador(Number(ev.target.value))}
            >
              {reales.map((c) => (
                <option key={c.id} value={c.id}>
                  👤 {c.nombre}
                </option>
              ))}
            </select>
          )}
          {vista === "personas" && (
          <div className="seg small" role="radiogroup" aria-label="Método de pago">
            {METODOS.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={ultimoMetodo === m.id}
                className={ultimoMetodo === m.id ? "on" : ""}
                onClick={() => elegirMetodo(m.id)}
              >
                {m.ico} {m.txt}
              </button>
            ))}
          </div>
          )}
        </div>
        )}
      </section>

      {unicoPendiente && (
        <div className="enter-hint">
          <kbd>Enter</kbd> cobra a <b>{unicoPendiente.nombre}</b> · {eur(unicoPendiente.debe)}
        </div>
      )}

      {vista === "gastos" ? (
        <GastosView
          gastos={datos.gastos}
          resumen={resumen}
          config={config}
          cobradores={reales}
          defCobrador={defCobrador}
          busqueda={busqueda}
          resaltados={resaltados}
          resaltar={resaltar}
          ejecutar={ejecutar}
          nuevoRef={nuevoGastoRef}
        />
      ) : vista === "traspasos" ? (
        <TraspasosView
          traspasos={datos.traspasos}
          cobradores={reales}
          defCobrador={defCobrador}
          busqueda={busqueda}
          resaltados={resaltados}
          resaltar={resaltar}
          ejecutar={ejecutar}
          nuevoRef={nuevoTraspasoRef}
        />
      ) : (
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {cabecera("estado", "Estado", "c-estado")}
              {cabecera("nombre", "Nombre")}
              <th>Modalidad</th>
              <th className="num">Regalo</th>
              {cabecera("importe", "Importe", "num")}
              {cabecera("cobro", "Cobro")}
              <th>Notas</th>
              <th className="rowact" aria-label="Acciones"></th>
            </tr>
          </thead>
          <tbody>
            <FilaNueva
              inputRef={nuevoRef}
              precioRegalo={config.precio_regalo}
              precioComida={config.precio_comida}
              menus={datos.menus}
              nombres={datos.participantes.map((p) => p.nombre)}
              onAdd={anadir}
            />
            {lista.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  {datos.participantes.length === 0 ? (
                    <>
                      <div className="empty-ico">🎉</div>
                      Todavía no hay nadie apuntado.
                      <br />
                      Escribe un nombre en la fila de arriba y pulsa <kbd>Enter</kbd>.
                    </>
                  ) : (
                    <>
                      Nadie coincide con{" "}
                      {busqueda ? <b>«{busqueda}»</b> : "este filtro"}.{" "}
                      <button
                        className="btn linklike"
                        onClick={() => {
                          setBusqueda("");
                          setFiltro("todos");
                        }}
                      >
                        Ver a todos
                      </button>
                    </>
                  )}
                </td>
              </tr>
            )}
            {lista.map((p) => (
              <tr
                key={p.id ?? p.nombre}
                className={
                  (p.pagado ? "paid" : "unpaid") +
                  (resaltados.has("p" + p.id) ? " flash" : "")
                }
              >
                <td className="c-estado">
                  {p.pagado ? (
                    <button
                      className="status paid"
                      title="Pagado · pulsa para marcar como pendiente"
                      onClick={() => marcar(p, false)}
                    >
                      <span className="when-idle">✓ Pagado</span>
                      <span className="when-hover">↺ Anular</span>
                    </button>
                  ) : (
                    <button
                      className="status unpaid"
                      title={`Registrar el cobro de ${eur(p.debe)}`}
                      onClick={() => marcar(p, true)}
                    >
                      Cobrar
                    </button>
                  )}
                </td>
                <td className="c-nombre">
                  <CeldaTexto
                    valor={p.nombre}
                    requerido
                    etiqueta="Nombre"
                    onCommit={(v) => guardarFila(p, { nombre: v })}
                  />
                </td>
                <td>
                  <select
                    className={"inline tag-select " + (p.comida ? "t-full" : "t-gift")}
                    aria-label="Modalidad"
                    value={modalidadDe(p)}
                    onChange={(ev) => cambiarModalidad(p, ev.target.value)}
                  >
                    {datos.menus.length === 0 || (p.comida && !p.menu_id) ? (
                      <option value="comida">
                        🍽 {datos.menus.length === 0 ? "Comida + regalo" : "Comida (elegir menú)"}
                      </option>
                    ) : null}
                    {datos.menus.map((m) => (
                      <option key={m.id} value={`m:${m.id}`}>
                        🍽 {m.nombre} + regalo
                      </option>
                    ))}
                    <option value="regalo">🎁 Solo regalo</option>
                  </select>
                </td>
                <td className="num c-regalo">
                  <CeldaTexto
                    valor={deCentimos(p.importe_regalo ?? config.precio_regalo)}
                    inputMode="decimal"
                    etiqueta="Regalo de esta persona"
                    clase={p.importe_regalo !== null ? "custom" : ""}
                    validar={(t) => aCentimos(t) !== null}
                    onCommit={(v) => {
                      const c = aCentimos(v);
                      if (c === null) return;
                      guardarFila(p, {
                        importeRegalo: c === config.precio_regalo ? -1 : c,
                      });
                    }}
                  />
                </td>
                <td className="num importe">{eur(p.debe)}</td>
                <td className="c-cobro">
                  {p.pagado ? (
                    <div className="cobro">
                      <span className="fecha print-only">{fmtFecha(p.fecha_pago)}</span>
                      <input
                        type="date"
                        className="cell fecha-edit no-print"
                        title="Fecha de cobro (editable)"
                        aria-label="Fecha de cobro"
                        value={p.fecha_pago ?? ""}
                        max={hoy()}
                        onChange={(ev) =>
                          ev.target.value && cambiarCobro(p, { fecha: ev.target.value })
                        }
                      />
                      {reales.length > 0 && (
                        <CeldaSelect
                          valor={p.cobrador_id}
                          opciones={reales.map((c) => ({ id: c.id, txt: c.nombre }))}
                          etiqueta="Cobrado por"
                          falta="¿Quién?"
                          onChange={(v) => cambiarCobro(p, { cobradorId: Number(v) })}
                        />
                      )}
                      <CeldaSelect
                        valor={p.metodo}
                        opciones={METODOS.map((m) => ({ id: m.id, txt: `${m.ico} ${m.txt}` }))}
                        etiqueta="Método de pago"
                        falta="¿Cómo?"
                        onChange={(v) => cambiarCobro(p, { metodo: v })}
                      />
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="c-notas">
                  <CeldaTexto
                    valor={p.notas}
                    placeholder="Añadir nota"
                    etiqueta="Notas"
                    onCommit={(v) => guardarFila(p, { notas: v })}
                  />
                </td>
                <td className="rowact">
                  <button
                    className="icon-btn danger"
                    title={`Eliminar a ${p.nombre}`}
                    aria-label={`Eliminar a ${p.nombre}`}
                    onClick={() => eliminar(p)}
                  >
                    🗑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <p className="hint muted">
        Haz clic en una celda para editarla · <kbd>Enter</kbd> guarda · <kbd>Esc</kbd> cancela
        · <kbd>Ctrl</kbd>+<kbd>N</kbd> {vista === "gastos" ? "nuevo gasto" : vista === "traspasos" ? "nuevo traspaso" : "nueva persona"}
      </p>
      <p className="print-only print-foot">
        Listado impreso el {new Date().toLocaleString("es-ES")} · {resumen.pagados} de{" "}
        {resumen.total_personas} pagados · Cobrado {eur(resumen.cobrado)} · Pendiente{" "}
        {eur(resumen.pendiente)}
      </p>

      <ToastStack toasts={toasts} onClose={cerrar} />

      {modal === "about" && <AboutDialog onClose={() => setModal(null)} />}

      {dialogoDb}

      {modal === "importar" && migracion && (
        <ImportarDialog
          migracion={migracion}
          onCancel={() => setModal(null)}
          onImportar={async () => {
            const n = await invoke<number>("importar_local");
            setModal(null);
            setMigracion(null);
            versionRef.current = null;
            await refrescar();
            avisar({ tipo: "ok", texto: `${n} personas importadas a la base compartida` });
          }}
          onDescartar={async () => {
            await invoke("descartar_local").catch(() => undefined);
            setModal(null);
            setMigracion(null);
          }}
        />
      )}

      {modal === "unlock" && (
        <PasswordPrompt
          titulo="Acceso de administrador"
          texto="Introduce la contraseña para cambiar precios, datos del evento y cobradores."
          boton="Desbloquear"
          onCancel={() => {
            setModal(null);
            setTrasDesbloquear(null);
          }}
          onSubmit={async (pw) => {
            const ok = await invoke<boolean>("desbloquear", { password: pw });
            if (!ok) throw new Error("Contraseña incorrecta");
            await trasAcceso();
          }}
        />
      )}

      {modal === "setup" && (
        <PasswordPrompt
          titulo="Crear contraseña de administrador"
          texto="Protege los precios y los cobradores con una contraseña (mínimo 4 caracteres). Guárdala bien: no se puede recuperar."
          boton="Crear contraseña"
          confirmar
          onCancel={() => {
            setModal(null);
            setTrasDesbloquear(null);
          }}
          onSubmit={async (pw) => {
            await invoke("crear_password", { password: pw });
            await refrescar();
            setModal(trasDesbloquear ?? "config");
            setTrasDesbloquear(null);
            avisar({ tipo: "ok", texto: "Contraseña creada" });
          }}
        />
      )}

      {modal === "password" && (
        <CambiarPassword
          onCancel={() => setModal(null)}
          onDone={async () => {
            setModal(null);
            await refrescar();
            avisar({ tipo: "ok", texto: "Contraseña cambiada" });
          }}
        />
      )}

      {modal === "config" && (
        <ConfigDialog
          menus={datos.menus}
          config={config}
          cobradores={reales}
          onChanged={refrescar}
          onCancel={() => setModal(null)}
          onSave={async (c) => {
            await invoke("guardar_config", { config: c });
            setModal(null);
            await refrescar();
            avisar({ tipo: "ok", texto: "Parámetros guardados" });
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────── Componentes auxiliares ─────────────────────────

function ChipConexion(props: {
  info: InfoDb | null;
  conectados: Conectado[];
  sinConexion: boolean;
  onClick: () => void;
}) {
  const { info, conectados } = props;
  if (!info) return null;
  if (props.sinConexion || !info.conectado) {
    return (
      <button className="btn conn bad" onClick={props.onClick} title={info.ruta}>
        ⚠ Sin conexión
      </button>
    );
  }
  const otros = conectados.filter((c) => !c.yo);
  const lista = conectados
    .map((c) => `${c.yo ? "• (tú) " : "• "}${c.equipo}${c.usuario ? " — " + c.usuario : ""}`)
    .join("\n");
  return (
    <button
      className="btn conn good"
      onClick={props.onClick}
      title={`Base de datos compartida\n${info.ruta}\n\nConectados ahora:\n${lista}`}
    >
      <span className="dot" />
      {otros.length === 0
        ? "Conectado · solo tú"
        : `${conectados.length} conectados`}
    </button>
  );
}

function ImportarDialog(props: {
  migracion: Migracion;
  onCancel: () => void;
  onImportar: () => Promise<void>;
  onDescartar: () => Promise<void>;
}) {
  const { migracion: m } = props;
  const [err, setErr] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const importar = async () => {
    setOcupado(true);
    try {
      await props.onImportar();
    } catch (e) {
      setErr(String(e));
      setOcupado(false);
    }
  };
  return (
    <Dialogo titulo="Datos de una versión anterior" onCancel={props.onCancel} onSubmit={importar}>
      <p>
        En este equipo hay una lista guardada con una versión anterior del programa:{" "}
        <b>
          {m.personas} {m.personas === 1 ? "persona" : "personas"}
        </b>{" "}
        ({m.pagados} {m.pagados === 1 ? "ha pagado" : "han pagado"}).
      </p>
      <p className="muted">
        Ahora todos los equipos comparten la misma base de datos, que está vacía. ¿Quieres
        pasar esa lista a la base compartida? Se copian también los precios, los cobradores y
        la contraseña de administrador.
      </p>
      <p className="muted small">
        El archivo antiguo no se borra: se renombra para no volver a preguntar.
        <br />
        <code>{m.ruta}</code>
      </p>
      {err && <div className="error">{err}</div>}
      <div className="actions">
        <button type="button" className="btn" disabled={ocupado} onClick={props.onDescartar}>
          No, empezar de cero
        </button>
        <button type="button" className="btn ghost" onClick={props.onCancel}>
          Preguntar luego
        </button>
        <button type="submit" className="btn primary" disabled={ocupado}>
          Importar
        </button>
      </div>
    </Dialogo>
  );
}

function Card(props: {
  titulo: string;
  valor: string;
  clase?: string;
  activo?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const clase =
    "card " +
    (props.clase ?? "") +
    (props.onClick ? " clickable" : "") +
    (props.activo ? " active" : "");
  const contenido = (
    <>
      <div className="card-title">{props.titulo}</div>
      <div className="card-value">{props.valor}</div>
      <div className="card-sub">{props.children}</div>
    </>
  );
  return props.onClick ? (
    <button className={clase} onClick={props.onClick}>
      {contenido}
    </button>
  ) : (
    <div className={clase}>{contenido}</div>
  );
}

function PasswordInput(props: {
  etiqueta: string;
  valor: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [ver, setVer] = useState(false);
  return (
    <label>
      {props.etiqueta}
      <div className="pw">
        <input
          type={ver ? "text" : "password"}
          autoFocus={props.autoFocus}
          value={props.valor}
          onChange={(ev) => props.onChange(ev.target.value)}
        />
        <button
          type="button"
          className="pw-eye"
          tabIndex={-1}
          title={ver ? "Ocultar" : "Mostrar"}
          onClick={() => setVer((v) => !v)}
        >
          {ver ? "🙈" : "👁"}
        </button>
      </div>
    </label>
  );
}

function PasswordPrompt(props: {
  titulo: string;
  texto: string;
  boton: string;
  confirmar?: boolean;
  onCancel: () => void;
  onSubmit: (pw: string) => Promise<void>;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const corta = props.confirmar && pw.length > 0 && pw.length < 4;
  const distintas = props.confirmar && pw2.length > 0 && pw !== pw2;

  const enviar = async () => {
    if (!pw) return;
    if (props.confirmar && (pw.length < 4 || pw !== pw2)) {
      setErr(pw.length < 4 ? "Mínimo 4 caracteres" : "Las contraseñas no coinciden");
      return;
    }
    setOcupado(true);
    try {
      await props.onSubmit(pw);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPw("");
      setOcupado(false);
    }
  };

  return (
    <Dialogo titulo={props.titulo} onCancel={props.onCancel} onSubmit={enviar}>
      <p className="muted">{props.texto}</p>
      <PasswordInput etiqueta="Contraseña" valor={pw} onChange={(v) => { setPw(v); setErr(""); }} autoFocus />
      {corta && <div className="field-hint">Mínimo 4 caracteres</div>}
      {props.confirmar && (
        <>
          <PasswordInput etiqueta="Repetir contraseña" valor={pw2} onChange={(v) => { setPw2(v); setErr(""); }} />
          {distintas && <div className="field-hint">No coinciden</div>}
        </>
      )}
      {err && <div className="error">{err}</div>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button type="submit" className="btn primary" disabled={!pw || ocupado}>
          {props.boton}
        </button>
      </div>
    </Dialogo>
  );
}

function CambiarPassword(props: {
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [nueva2, setNueva2] = useState("");
  const [err, setErr] = useState("");

  const enviar = async () => {
    if (nueva.length < 4) {
      setErr("La contraseña nueva debe tener al menos 4 caracteres");
      return;
    }
    if (nueva !== nueva2) {
      setErr("Las contraseñas nuevas no coinciden");
      return;
    }
    try {
      await invoke("cambiar_password", { actual, nueva });
      await props.onDone();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <Dialogo titulo="Cambiar contraseña" onCancel={props.onCancel} onSubmit={enviar}>
      <PasswordInput etiqueta="Contraseña actual" valor={actual} onChange={setActual} autoFocus />
      <PasswordInput etiqueta="Contraseña nueva" valor={nueva} onChange={setNueva} />
      <PasswordInput etiqueta="Repetir contraseña nueva" valor={nueva2} onChange={setNueva2} />
      {nueva2.length > 0 && nueva !== nueva2 && <div className="field-hint">No coinciden</div>}
      {err && <div className="error">{err}</div>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button type="submit" className="btn primary" disabled={!actual || !nueva}>
          Cambiar
        </button>
      </div>
    </Dialogo>
  );
}

function ConfigDialog(props: {
  config: Datos["config"];
  cobradores: Cobrador[];
  menus: Menu[];
  onChanged: () => Promise<void>;
  onCancel: () => void;
  onSave: (c: Datos["config"]) => Promise<void>;
}) {
  const [nuevoCobrador, setNuevoCobrador] = useState("");
  const [nuevoMenu, setNuevoMenu] = useState("");
  const [evento, setEvento] = useState(props.config.evento);
  const [fecha, setFecha] = useState(props.config.fecha);
  const [regaloDesc, setRegaloDesc] = useState(props.config.regalo_desc);
  const [comida, setComida] = useState(deCentimos(props.config.precio_comida));
  const [regalo, setRegalo] = useState(deCentimos(props.config.precio_regalo));
  const [err, setErr] = useState("");

  const pc = aCentimos(comida);
  const pr = aCentimos(regalo);
  const cambiado =
    evento !== props.config.evento ||
    fecha !== props.config.fecha ||
    regaloDesc !== props.config.regalo_desc ||
    pc !== props.config.precio_comida ||
    pr !== props.config.precio_regalo;

  const cancelar = () => {
    if (cambiado && !window.confirm("Hay cambios sin guardar. ¿Descartarlos?")) return;
    props.onCancel();
  };

  const anadirCobrador = async () => {
    if (!nuevoCobrador.trim()) return;
    try {
      setErr("");
      await invoke("guardar_cobrador", { nombre: nuevoCobrador });
      setNuevoCobrador("");
      await props.onChanged();
    } catch (e) {
      setErr(String(e));
    }
  };

  const anadirMenu = async () => {
    if (!nuevoMenu.trim()) return;
    try {
      setErr("");
      await invoke("guardar_menu", { nombre: nuevoMenu });
      setNuevoMenu("");
      await props.onChanged();
    } catch (e) {
      setErr(String(e));
    }
  };

  const quitarMenu = async (m: Menu) => {
    try {
      setErr("");
      await invoke("eliminar_menu", { id: m.id });
      await props.onChanged();
    } catch (e) {
      setErr(String(e));
    }
  };

  const quitarCobrador = async (c: Cobrador) => {
    if (c.cobros > 0 || c.gastos > 0 || c.traspasos > 0) {
      setErr(
        `${c.nombre} tiene ${c.cobros} cobro(s), ${c.gastos} gasto(s) y ${c.traspasos} traspaso(s). Reasígnalos o elimínalos antes de quitar este cobrador.`
      );
      return;
    }
    try {
      setErr("");
      await invoke("eliminar_cobrador", { id: c.id });
      await props.onChanged();
    } catch (e) {
      setErr(String(e));
    }
  };

  const guardar = async () => {
    if (pc === null || pr === null) {
      setErr("Introduce importes válidos (por ejemplo 25,50)");
      return;
    }
    try {
      await props.onSave({
        evento,
        fecha,
        regalo_desc: regaloDesc,
        precio_comida: pc,
        precio_regalo: pr,
      });
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <Dialogo titulo="Parámetros del evento" onCancel={cancelar} onSubmit={guardar} ancho={560}>
      <h3 className="sub flat">Evento</h3>
      <label>
        Nombre del evento
        <input
          autoFocus
          value={evento}
          placeholder="Ej.: Jubilación de Ana"
          onChange={(ev) => setEvento(ev.target.value)}
        />
      </label>
      <div className="two">
        <label>
          Fecha / lugar
          <input
            value={fecha}
            placeholder="Ej.: 20/12 · Restaurante El Puerto"
            onChange={(ev) => setFecha(ev.target.value)}
          />
        </label>
        <label>
          Regalo
          <input
            value={regaloDesc}
            placeholder="Ej.: Reloj y ramo de flores"
            onChange={(ev) => setRegaloDesc(ev.target.value)}
          />
        </label>
      </div>

      <h3 className="sub">Importes por persona</h3>
      <div className="two">
        <label>
          Comida
          <div className={"money" + (pc === null && comida.trim() ? " invalid" : "")}>
            <input
              inputMode="decimal"
              value={comida}
              placeholder="0,00"
              onChange={(ev) => setComida(ev.target.value)}
              onFocus={(ev) => ev.target.select()}
            />
            <span>€</span>
          </div>
        </label>
        <label>
          Regalo (general; cada persona puede tener otro)
          <div className={"money" + (pr === null && regalo.trim() ? " invalid" : "")}>
            <input
              inputMode="decimal"
              value={regalo}
              placeholder="0,00"
              onChange={(ev) => setRegalo(ev.target.value)}
              onFocus={(ev) => ev.target.select()}
            />
            <span>€</span>
          </div>
        </label>
      </div>
      {pc !== null && pr !== null && (
        <div className="preview">
          Cada persona pagará: <b>{eur(pc + pr)}</b> con comida · <b>{eur(pr)}</b> solo
          regalo
        </div>
      )}

      <h3 className="sub">Tipos de menú</h3>
      <p className="muted">
        Opciones de menú entre las que elegir al apuntar a cada persona (sin precio: la comida
        cuesta lo mismo). Se guardan al momento.
      </p>
      <div className="chips">
        {props.menus.length === 0 && <span className="muted">Aún no hay menús.</span>}
        {props.menus.map((m) => (
          <span key={m.id} className="chip-x">
            🍽 {m.nombre}
            {m.personas > 0 && (
              <span className="muted">
                {" "}
                · {m.personas} {m.personas === 1 ? "persona" : "personas"}
              </span>
            )}
            <button
              type="button"
              aria-label={`Eliminar menú ${m.nombre}`}
              title={m.personas > 0 ? "Hay personas con este menú" : "Eliminar"}
              disabled={m.personas > 0}
              onClick={() => quitarMenu(m)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="addrow">
        <input
          placeholder="Ej.: Carne, Pescado, Vegetariano"
          value={nuevoMenu}
          onChange={(ev) => setNuevoMenu(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              anadirMenu();
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={!nuevoMenu.trim()}
          onClick={anadirMenu}
        >
          ＋ Añadir
        </button>
      </div>

      <h3 className="sub">Cobradores</h3>
      <p className="muted">
        Quienes recogen el dinero. Se guardan al momento, sin pulsar «Guardar».
      </p>
      <div className="chips">
        {props.cobradores.length === 0 && (
          <span className="muted">Aún no hay cobradores.</span>
        )}
        {props.cobradores.map((c) => (
          <span key={c.id} className="chip-x">
            👤 {c.nombre}
            {c.cobros > 0 && (
              <span className="muted">
                {" "}
                · {c.cobros} {c.cobros === 1 ? "cobro" : "cobros"} · {eur(c.total)}
              </span>
            )}
            <button
              type="button"
              aria-label={`Eliminar cobrador ${c.nombre}`}
              title={
                c.cobros > 0 || c.gastos > 0 || c.traspasos > 0
                  ? "Tiene cobros, gastos o traspasos asignados"
                  : "Eliminar"
              }
              disabled={c.cobros > 0 || c.gastos > 0 || c.traspasos > 0}
              onClick={() => quitarCobrador(c)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="addrow">
        <input
          placeholder="Nombre del cobrador"
          value={nuevoCobrador}
          onChange={(ev) => setNuevoCobrador(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              anadirCobrador();
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={!nuevoCobrador.trim()}
          onClick={anadirCobrador}
        >
          ＋ Añadir
        </button>
      </div>

      {err && <div className="error">{err}</div>}
      <div className="actions">
        <button type="button" className="btn" onClick={cancelar}>
          Cancelar
        </button>
        <button type="submit" className="btn primary" disabled={pc === null || pr === null}>
          Guardar
        </button>
      </div>
    </Dialogo>
  );
}

// ───────────────────────── Edición en la propia fila ─────────────────────────

/** Fila fija para añadir personas sin abrir ventanas. */
function FilaNueva(props: {
  inputRef: React.RefObject<HTMLInputElement>;
  precioRegalo: number;
  precioComida: number;
  menus: Menu[];
  nombres: string[];
  onAdd: (p: Partial<Participante>) => Promise<boolean>;
}) {
  const [nombre, setNombre] = useState("");
  const [modalidad, setModalidad] = useState("comida");
  const [notas, setNotas] = useState("");
  const comida = modalidad !== "regalo";
  const [ocupado, setOcupado] = useState(false);

  const debe = props.precioRegalo + (comida ? props.precioComida : 0);
  const duplicado =
    nombre.trim() !== "" &&
    props.nombres.some((n) => normalizar(n) === normalizar(nombre));

  const anadir = async () => {
    if (!nombre.trim() || ocupado) return;
    setOcupado(true);
    const ok = await props.onAdd({
      nombre: nombre.trim(),
      comida,
      menu_id: modalidad.startsWith("m:") ? Number(modalidad.slice(2)) : null,
      notas,
    });
    setOcupado(false);
    if (ok) {
      setNombre("");
      setNotas("");
    }
    props.inputRef.current?.focus();
  };
  const enter = (ev: React.KeyboardEvent) => ev.key === "Enter" && anadir();

  return (
    <tr className="newrow">
      <td className="plus c-estado">＋ Nuevo</td>
      <td className="c-nombre">
        <input
          ref={props.inputRef}
          className={"cell" + (duplicado ? " warn" : "")}
          placeholder="Nombre de la persona…"
          aria-label="Nombre de la nueva persona"
          value={nombre}
          onChange={(ev) => setNombre(ev.target.value)}
          onKeyDown={enter}
        />
        {duplicado && <div className="dup">Ya hay alguien con este nombre</div>}
      </td>
      <td>
        <select
          className={"inline tag-select " + (comida ? "t-full" : "t-gift")}
          aria-label="Modalidad de la nueva persona"
          value={modalidad}
          onChange={(ev) => setModalidad(ev.target.value)}
        >
          {props.menus.length === 0 && <option value="comida">🍽 Comida + regalo</option>}
          {props.menus.length > 0 && <option value="comida">🍽 Comida (elegir menú)</option>}
          {props.menus.map((m) => (
            <option key={m.id} value={`m:${m.id}`}>
              🍽 {m.nombre} + regalo
            </option>
          ))}
          <option value="regalo">🎁 Solo regalo</option>
        </select>
      </td>
      <td></td>
      <td className="num muted">{eur(debe)}</td>
      <td></td>
      <td className="c-notas">
        <input
          className="cell"
          placeholder="Notas (opcional)"
          aria-label="Notas de la nueva persona"
          value={notas}
          onChange={(ev) => setNotas(ev.target.value)}
          onKeyDown={enter}
        />
      </td>
      <td className="rowact">
        <button
          className="btn small primary"
          disabled={!nombre.trim() || ocupado}
          onClick={anadir}
        >
          Añadir
        </button>
      </td>
    </tr>
  );
}
