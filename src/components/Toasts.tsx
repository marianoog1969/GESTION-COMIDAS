import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
  id: number;
  texto: string;
  tipo: "ok" | "error" | "info";
  deshacer?: () => void;
}

type Nuevo = Omit<Toast, "id">;

/** Avisos flotantes con opción «Deshacer». */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const cerrar = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const avisar = useCallback((t: Nuevo) => {
    const id = ++seq.current;
    // Máximo 3 a la vez: los más antiguos se descartan
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    return id;
  }, []);

  return { toasts, avisar, cerrar };
}

export function ToastStack(props: {
  toasts: Toast[];
  onClose: (id: number) => void;
}) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {props.toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onClose={() => props.onClose(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const [pausa, setPausa] = useState(false);
  const duracion = toast.tipo === "error" ? 9000 : toast.deshacer ? 7000 : 3500;
  const cerrarRef = useRef(onClose);
  cerrarRef.current = onClose;

  useEffect(() => {
    if (pausa) return;
    const t = window.setTimeout(() => cerrarRef.current(), duracion);
    return () => window.clearTimeout(t);
  }, [pausa, duracion]);

  return (
    <div
      className={"toast " + toast.tipo}
      onMouseEnter={() => setPausa(true)}
      onMouseLeave={() => setPausa(false)}
    >
      <span className="toast-ico">
        {toast.tipo === "error" ? "⚠" : toast.tipo === "ok" ? "✓" : "ℹ"}
      </span>
      <span className="toast-txt">{toast.texto}</span>
      {toast.deshacer && (
        <button
          className="toast-undo"
          onClick={() => {
            toast.deshacer?.();
            onClose();
          }}
        >
          Deshacer
        </button>
      )}
      <button className="toast-x" aria-label="Cerrar aviso" onClick={onClose}>
        ✕
      </button>
      {!pausa && (
        <span className="toast-timer" style={{ animationDuration: duracion + "ms" }} />
      )}
    </div>
  );
}
