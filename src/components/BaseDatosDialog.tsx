import Icono from "./Icono";
import { Conectado, InfoDb } from "../types";
import Dialogo from "./Dialogo";

/** Información de la base de datos compartida y de quién está conectado. */
export default function BaseDatosDialog(props: {
  info: InfoDb | null;
  conectados: Conectado[];
  onReintentar: () => Promise<void>;
  onCancel: () => void;
}) {
  const { info } = props;

  return (
    <Dialogo titulo="Base de datos compartida" onCancel={props.onCancel} ancho={600}>
      {info && (
        <div className={"db-actual " + (info.conectado ? "good" : "bad")}>
          <div className="db-tipo">{info.conectado ? <><Icono n="globe" /> Conectado</> : <><Icono n="alert" /> Sin conexión</>}</div>
          <code className="db-ruta">{info.ruta}</code>
          <div className="muted small">
            {info.origen === "ini"
              ? "Ubicación indicada en celebracion.ini"
              : "En la misma carpeta que el programa"}
          </div>
          {info.error && <div className="small">{info.error}</div>}
          {info.conectado && props.conectados.length > 0 && (
            <div className="db-conectados">
              <span className="muted small">Conectados ahora:</span>
              {props.conectados.map((c) => (
                <span key={c.equipo + c.usuario} className="pill">
                  <Icono n="monitor" /> {c.equipo}
                  {c.usuario && <span className="muted"> · {c.usuario}</span>}
                  {c.yo && <b> (tú)</b>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <details className="manual-db">
        <summary>¿Cómo funciona entre varios equipos?</summary>
        <ol>
          <li>
            Todos abren el mismo programa desde la carpeta de red, y los datos se guardan en{" "}
            <code>celebracion.db</code> junto a él. No hay que configurar nada.
          </li>
          <li>
            Lo que cobra un equipo aparece en los demás en 2–3 segundos. Si dos equipos cobran
            a la misma persona a la vez, el segundo recibe un aviso y no se cobra dos veces.
          </li>
          <li>
            Todos necesitan <b>permiso de escritura</b> en esa carpeta (no solo en el archivo).
          </li>
          <li>
            Si la carpeta del programa tiene que ser de solo lectura, crea junto al .exe un
            archivo <code>celebracion.ini</code> con la línea{" "}
            <code>datos=\\servidor\carpeta\celebracion.db</code>.
          </li>
          <li>
            No pongas el programa en carpetas sincronizadas (OneDrive, Dropbox, Google Drive):
            tiene que ser una carpeta compartida de red real.
          </li>
        </ol>
      </details>

      <div className="actions">
        {info && !info.conectado && (
          <button type="button" className="btn" onClick={props.onReintentar}>
            Reintentar
          </button>
        )}
        <button type="button" className="btn primary" onClick={props.onCancel}>
          Cerrar
        </button>
      </div>
    </Dialogo>
  );
}
