import Icono from "./Icono";
import { useEffect } from "react";

/** Ventana modal: Esc o clic fuera para cerrar; Enter envía el formulario. */
export default function Dialogo(props: {
  titulo: string;
  onCancel: () => void;
  onSubmit?: () => void;
  ancho?: number;
  children: React.ReactNode;
}) {
  const { onCancel } = props;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="overlay"
      onMouseDown={(ev) => ev.target === ev.currentTarget && props.onCancel()}
    >
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.titulo}
        style={props.ancho ? { width: `min(${props.ancho}px, 94vw)` } : undefined}
        onSubmit={(ev) => {
          ev.preventDefault();
          props.onSubmit?.();
        }}
      >
        <div className="modal-head">
          <h2>{props.titulo}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Cerrar"
            onClick={props.onCancel}
          >
            <Icono n="x" />
          </button>
        </div>
        {props.children}
      </form>
    </div>
  );
}
