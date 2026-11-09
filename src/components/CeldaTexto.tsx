import { useEffect, useRef, useState } from "react";

/** Texto editable en la celda: se guarda al salir del campo o con Enter; Esc cancela. */
export default function CeldaTexto(props: {
  valor: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  etiqueta?: string;
  requerido?: boolean;
  /** Validación extra: si devuelve false no se guarda y se restaura el valor */
  validar?: (v: string) => boolean;
  clase?: string;
  inputMode?: "decimal" | "text";
}) {
  const [v, setV] = useState(props.valor);
  const [invalido, setInvalido] = useState(false);
  const editando = useRef(false);
  // Si otro equipo cambia el valor, se actualiza… salvo mientras se está escribiendo aquí
  useEffect(() => {
    if (!editando.current) setV(props.valor);
  }, [props.valor]);

  const esValido = (t: string) =>
    !(props.requerido && t.trim() === "") && (!props.validar || props.validar(t));

  const confirmar = () => {
    editando.current = false;
    setInvalido(false);
    if (v.trim() === props.valor.trim() || !esValido(v)) {
      setV(props.valor);
      return;
    }
    props.onCommit(v);
  };

  return (
    <input
      className={"cell" + (invalido ? " invalid" : "") + (props.clase ? " " + props.clase : "")}
      value={v}
      inputMode={props.inputMode}
      aria-label={props.etiqueta}
      placeholder={props.placeholder}
      title={invalido ? "Valor no válido: se restaurará el anterior" : v.length > 24 ? v : undefined}
      onChange={(ev) => {
        setV(ev.target.value);
        setInvalido(!esValido(ev.target.value));
      }}
      onFocus={(ev) => {
        editando.current = true;
        if (props.inputMode === "decimal") ev.target.select();
      }}
      onBlur={confirmar}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
        if (ev.key === "Escape") {
          ev.stopPropagation();
          setV(props.valor);
          setInvalido(false);
          editando.current = false;
          const el = ev.target as HTMLInputElement;
          window.setTimeout(() => el.blur(), 0);
        }
      }}
    />
  );
}
