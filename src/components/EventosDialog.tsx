import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { EventoInfo } from "../types";
import Dialogo from "./Dialogo";
import Icono from "./Icono";

/** Lista de eventos: abrir otro en una ventana nueva, cambiar a él o crear uno nuevo. */
export default function EventosDialog(props: { onCancel: () => void; admin: boolean; sinEvento?: boolean }) {
  const [eventos, setEventos] = useState<EventoInfo[] | null>(null);
  const [nombre, setNombre] = useState("");
  const [err, setErr] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [nombreMover, setNombreMover] = useState("");
  const [confirmando, setConfirmando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setEventos(await invoke<EventoInfo[]>("listar_eventos"));
    } catch (e) {
      setErr(String(e));
      setEventos([]);
    }
  }, []);
  useEffect(() => {
    cargar();
  }, [cargar]);

  const abrir = async (ev: EventoInfo, cambiar: boolean) => {
    try {
      setErr("");
      setOcupado(true);
      await invoke("abrir_evento", { ruta: ev.ruta, cambiar: cambiar || !!props.sinEvento });
      if (!cambiar && !props.sinEvento) props.onCancel();
    } catch (e) {
      setErr(String(e));
    } finally {
      setOcupado(false);
    }
  };

  const principalAbierta = eventos?.find((x) => x.actual && x.principal);

  const mover = async () => {
    if (!nombreMover.trim() || ocupado) return;
    try {
      setErr("");
      setOcupado(true);
      // Si todo va bien, esta ventana se cierra y se abre el evento en la nueva ubicación
      await invoke("mover_a_eventos", { nombre: nombreMover });
    } catch (e) {
      setErr(String(e));
      setConfirmando(false);
    } finally {
      setOcupado(false);
    }
  };

  const crear = async () => {
    if (!nombre.trim() || ocupado) return;
    try {
      setErr("");
      setOcupado(true);
      const ruta = await invoke<string>("crear_evento", { nombre });
      await invoke("abrir_evento", { ruta, cambiar: !!props.sinEvento });
      setNombre("");
      await cargar();
    } catch (e) {
      setErr(String(e));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Dialogo titulo="Eventos" onCancel={props.onCancel} onSubmit={crear} ancho={640}>
      {props.sinEvento && (
        <p>
          <b>No hay ningún evento abierto.</b> Elige uno de la lista o crea uno nuevo.
        </p>
      )}
      <p className="muted">
        Cada evento tiene su propia base de datos, independiente de los demás. Puedes tener
        varios abiertos a la vez, cada uno en su ventana.
      </p>
      <div className="eventos-lista">
        {eventos === null && <div className="muted">Buscando eventos…</div>}
        {eventos?.map((ev) => (
          <div key={ev.ruta} className={"evento-fila" + (ev.actual ? " actual" : "")}>
            <div className="evento-info">
              <div className="evento-nombre">
                <Icono n="folder" /> {ev.nombre}
                {ev.actual && <span className="pill">Abierto aquí</span>}
                {ev.principal && <span className="pill">Principal</span>}
              </div>
              <div className="muted small">
                {ev.error
                  ? ev.error
                  : `${ev.archivo} · ${ev.personas} ${ev.personas === 1 ? "persona" : "personas"} · ${ev.pagados} ${ev.pagados === 1 ? "pagada" : "pagadas"}`}
              </div>
            </div>
            <div className="evento-acc">
              <button
                type="button"
                className="btn"
                disabled={ocupado || !!ev.error}
                title="Abrirlo en una ventana nueva y mantener esta"
                onClick={() => abrir(ev, false)}
              >
                Abrir aparte
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={ocupado || ev.actual || !!ev.error}
                title="Cerrar esta ventana y abrir ese evento"
                onClick={() => abrir(ev, true)}
              >
                Cambiar a este
              </button>
            </div>
          </div>
        ))}
      </div>

      <h3 className="sub">Nuevo evento</h3>
      <div className="addrow">
        <input
          placeholder="Nombre del evento (p. ej. Comida de Navidad)"
          value={nombre}
          onChange={(ev) => setNombre(ev.target.value)}
          autoFocus
        />
        <button type="submit" className="btn primary" disabled={!nombre.trim() || ocupado}>
          Crear y abrir
        </button>
      </div>
      <p className="muted small">
        Los eventos nuevos se guardan en la carpeta «Eventos», junto a la base de datos principal,
        y se abren en una ventana nueva. Los demás equipos los ven si ejecutan el mismo programa
        desde esa carpeta. Cada evento tiene su propia contraseña de administrador.
      </p>
      {principalAbierta && (
        <>
          <h3 className="sub">Pasar la base actual a Eventos</h3>
          {!props.admin ? (
            <p className="muted small">
              Para mover la base principal a la carpeta «Eventos» con otro nombre, desbloquea
              antes el modo administrador.
            </p>
          ) : (
            <>
              <div className="addrow">
                <input
                  placeholder="Nombre que tendrá (p. ej. Comida JP)"
                  value={nombreMover}
                  onChange={(ev) => {
                    setNombreMover(ev.target.value);
                    setConfirmando(false);
                  }}
                />
                {!confirmando ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={!nombreMover.trim() || ocupado}
                    onClick={() => setConfirmando(true)}
                  >
                    Mover…
                  </button>
                ) : (
                  <button type="button" className="btn primary" disabled={ocupado} onClick={mover}>
                    Confirmar y mover
                  </button>
                )}
              </div>
              <p className="muted small">
                {confirmando
                  ? "Se moverá celebracion.db a la carpeta «Eventos» con ese nombre (también será el nombre del evento), esta ventana se cerrará y se abrirá de nuevo. Antes, cierra el programa en los demás equipos; si alguno lo tiene abierto, no se mueve nada."
                  : "Mueve la base de datos principal a la carpeta «Eventos» con el nombre que indiques. Los datos no se pierden."}
              </p>
            </>
          )}
        </>
      )}
      {err && <div className="error">{err}</div>}
    </Dialogo>
  );
}
