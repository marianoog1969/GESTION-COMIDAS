import { useState } from "react";

export interface Opcion {
  id: string | number;
  txt: string;
}

/**
 * Muestra el valor como texto normal y solo se convierte en desplegable al pulsarlo.
 * Evita llenar la tabla de controles para datos que casi nunca se cambian.
 */
export default function CeldaSelect(props: {
  valor: string | number | null;
  opciones: Opcion[];
  etiqueta: string;
  onChange: (v: string) => void;
  /** Texto cuando no hay valor (p. ej. «¿Quién?») */
  falta?: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const actual = props.opciones.find((o) => String(o.id) === String(props.valor));

  if (!abierto) {
    return (
      <button
        className={"cell-link" + (actual ? "" : " missing")}
        aria-label={`${props.etiqueta}: ${actual?.txt ?? "sin asignar"}. Pulsa para cambiar`}
        onClick={() => setAbierto(true)}
      >
        {actual?.txt ?? props.falta ?? "¿?"}
      </button>
    );
  }

  return (
    <select
      autoFocus
      className={"inline" + (actual ? "" : " missing")}
      aria-label={props.etiqueta}
      value={actual ? String(props.valor) : ""}
      onChange={(ev) => {
        setAbierto(false);
        props.onChange(ev.target.value);
      }}
      onBlur={() => setAbierto(false)}
      onKeyDown={(ev) => ev.key === "Escape" && setAbierto(false)}
    >
      {!actual && (
        <option value="" disabled>
          {props.falta ?? "¿?"}
        </option>
      )}
      {props.opciones.map((o) => (
        <option key={o.id} value={o.id}>
          {o.txt}
        </option>
      ))}
    </select>
  );
}
