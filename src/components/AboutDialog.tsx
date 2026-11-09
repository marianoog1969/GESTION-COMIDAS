import { useEffect, useState } from "react";
import { CREDITS } from "../credits";
import DonateButton from "./DonateButton";

interface Props {
  onClose: () => void;
}

export default function AboutDialog({ onClose }: Props) {
  const [manual, setManual] = useState(false);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()}>
        <h2>Acerca de</h2>
        <p>
          <strong>{CREDITS.appName}</strong> · v{CREDITS.version}
        </p>
        <p>Creado por {CREDITS.author}</p>
        <p className="muted">{CREDITS.tech}</p>
        <p className="muted">© {CREDITS.year}</p>

        {manual && (
          <div className="manual">
            <ol>
              <li>
                Pulsa <b>🔒 Administrador</b> e introduce la contraseña (la primera vez se
                crea).
              </li>
              <li>
                En <b>⚙ Parámetros</b> fija el precio de la comida, la aportación al regalo,
                los datos del evento y los cobradores.
              </li>
              <li>
                Añade participantes en la fila superior de la tabla (<kbd>Ctrl</kbd>+
                <kbd>N</kbd>): todos aportan al regalo; elige <b>Comida + regalo</b> si
                también comen.
              </li>
              <li>
                Elige en <b>Al cobrar</b> quién recoge el dinero y si es efectivo o Bizum, y
                pulsa <b>Cobrar</b> en la fila de cada persona.
              </li>
              <li>
                ¿Te has equivocado? Pulsa <b>Deshacer</b> en el aviso que aparece abajo a la
                derecha.
              </li>
              <li>
                Pulsa las tarjetas <b>Cobrado</b> o <b>Falta por cobrar</b> para filtrar la
                lista.
              </li>
              <li>
                En <b>🎁 Gastos del regalo</b> apunta lo que cada cobrador paga con el dinero
                recogido. Se descuenta de lo recaudado para el regalo y de lo que tiene ese
                cobrador en «¿Dónde está el dinero?».
              </li>
              <li>
                En <b>⇄ Traspasos</b> apunta el dinero que un cobrador le pasa a otro. El total
                recaudado no cambia, solo quién lo tiene.
              </li>
              <li>
                <b>Atajos</b>: escribe cualquier letra para buscar (o <kbd>Ctrl</kbd>+
                <kbd>F</kbd>); si la búsqueda deja a una sola persona pendiente,{" "}
                <kbd>Enter</kbd> le cobra. <kbd>Ctrl</kbd>+<kbd>N</kbd> añade una fila nueva y{" "}
                <kbd>Ctrl</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> cambia de pestaña.
              </li>
              <li>
                <b>📋 Copiar lista</b> (en el filtro «Pendientes») copia quién falta por pagar,
                para pegarlo en WhatsApp o en un correo. <b>⬇ Exportar</b> guarda un informe
                completo en CSV que se abre con Excel.
              </li>
              <li>
                <b>Varios equipos a la vez</b>: todos abren el mismo programa desde la red y
                comparten los datos. El indicador verde de arriba muestra quién está
                conectado.
              </li>
            </ol>
          </div>
        )}

        <div className="actions">
          <button className="btn" onClick={() => setManual((m) => !m)}>
            {manual ? "Ocultar manual" : "Manual"}
          </button>
          <DonateButton />
          <button className="btn primary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
