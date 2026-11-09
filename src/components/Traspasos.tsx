import { RefObject, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cobrador, Traspaso, aCentimos, deCentimos, eur, fmtFecha, hoy, normalizar } from "../types";
import CeldaTexto from "./CeldaTexto";
import CeldaSelect from "./CeldaSelect";
import { Ejecutar, importeValido } from "./Gastos";

/** Dinero que pasa de un cobrador a otro: no cambia el total, solo quién lo tiene. */
export default function TraspasosView(props: {
  traspasos: Traspaso[];
  cobradores: Cobrador[];
  defCobrador: number | null;
  busqueda: string;
  resaltados: Set<string>;
  resaltar: (clave: string) => void;
  ejecutar: Ejecutar;
  nuevoRef: RefObject<HTMLInputElement>;
}) {
  const { cobradores } = props;

  const lista = useMemo(() => {
    const q = normalizar(props.busqueda);
    return q
      ? props.traspasos.filter((t) =>
          normalizar(`${t.de ?? ""} ${t.a ?? ""} ${t.nota}`).includes(q)
        )
      : props.traspasos;
  }, [props.traspasos, props.busqueda]);

  const total = props.traspasos.reduce((s, t) => s + t.importe, 0);

  const actualizar = (t: Traspaso, cambios: Record<string, unknown>) => {
    props.resaltar("t" + t.id);
    return props.ejecutar(() =>
      invoke("actualizar_traspaso", {
        id: t.id,
        fecha: null,
        deId: null,
        aId: null,
        importe: null,
        nota: null,
        ...cambios,
      })
    );
  };

  const eliminar = (t: Traspaso) =>
    props.ejecutar(() => invoke("eliminar_traspaso", { id: t.id }), {
      texto: `Traspaso de ${eur(t.importe)} (${t.de} → ${t.a}) eliminado`,
      deshacer: () =>
        props.ejecutar(() => invoke("restaurar_traspaso", { traspaso: t }), {
          texto: "Traspaso recuperado",
        }),
    });

  if (cobradores.length < 2) {
    return (
      <div className="tablewrap">
        <div className="empty">
          <div className="empty-ico">⇄</div>
          Para traspasar dinero hacen falta al menos <b>dos cobradores</b>.
          <br />
          Añádelos en <b>⚙ Parámetros</b> (modo administrador).
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="vista-intro muted">
        Cuando un cobrador le pasa dinero a otro (por ejemplo, para que compre el regalo). No
        cambia el total recaudado, solo quién lo tiene: se ve en «¿Dónde está el dinero?».
      </p>
      <h2 className="print-only">Traspasos entre cobradores</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="c-fecha">Fecha</th>
              <th>Entrega</th>
              <th className="c-flecha" aria-hidden></th>
              <th>Recibe</th>
              <th className="num c-importe">Importe</th>
              <th>Nota</th>
              <th className="rowact" aria-label="Acciones"></th>
            </tr>
          </thead>
          <tbody>
            <FilaTraspasoNueva
              inputRef={props.nuevoRef}
              cobradores={cobradores}
              defCobrador={props.defCobrador}
              onAdd={(t) =>
                props.ejecutar(() => invoke("guardar_traspaso", { traspaso: t }), {
                  texto: `Traspaso de ${eur(t.importe)} apuntado`,
                })
              }
            />
            {lista.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  {props.traspasos.length === 0 ? (
                    <>
                      <div className="empty-ico">⇄</div>
                      Aún no hay traspasos entre cobradores.
                    </>
                  ) : (
                    <>Ningún traspaso coincide con «{props.busqueda}».</>
                  )}
                </td>
              </tr>
            )}
            {lista.map((t) => (
              <tr key={t.id} className={props.resaltados.has("t" + t.id) ? "flash" : ""}>
                <td className="c-fecha">
                  <input
                    type="date"
                    className="cell date"
                    aria-label="Fecha del traspaso"
                    value={t.fecha}
                    title={fmtFecha(t.fecha)}
                    onChange={(ev) => ev.target.value && actualizar(t, { fecha: ev.target.value })}
                  />
                </td>
                <td>
                  <CeldaSelect
                    valor={t.de_id}
                    opciones={cobradores.map((c) => ({ id: c.id, txt: c.nombre }))}
                    etiqueta="Entrega"
                    falta="¿Quién?"
                    onChange={(v) => actualizar(t, { deId: Number(v) })}
                  />
                </td>
                <td className="c-flecha" aria-hidden>
                  →
                </td>
                <td>
                  <CeldaSelect
                    valor={t.a_id}
                    opciones={cobradores.map((c) => ({ id: c.id, txt: c.nombre }))}
                    etiqueta="Recibe"
                    falta="¿Quién?"
                    onChange={(v) => actualizar(t, { aId: Number(v) })}
                  />
                </td>
                <td className="num c-importe">
                  <CeldaTexto
                    valor={deCentimos(t.importe)}
                    requerido
                    validar={importeValido}
                    inputMode="decimal"
                    clase="num"
                    etiqueta="Importe del traspaso"
                    onCommit={(v) => actualizar(t, { importe: aCentimos(v) })}
                  />
                </td>
                <td className="c-notas">
                  <CeldaTexto
                    valor={t.nota}
                    placeholder="Añadir nota"
                    etiqueta="Nota del traspaso"
                    onCommit={(v) => actualizar(t, { nota: v })}
                  />
                </td>
                <td className="rowact">
                  <button
                    className="icon-btn danger"
                    title="Eliminar el traspaso"
                    aria-label={`Eliminar el traspaso de ${t.de} a ${t.a}`}
                    onClick={() => eliminar(t)}
                  >
                    🗑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {props.traspasos.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={4} className="tfoot-label">
                  Total traspasado
                </td>
                <td className="num tfoot-total">{eur(total)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}

function SelectCobrador(props: {
  etiqueta: string;
  valor: number | null;
  cobradores: Cobrador[];
  onChange: (id: number) => void;
}) {
  const existe = props.cobradores.some((c) => c.id === props.valor);
  return (
    <select
      className={"inline" + (existe ? "" : " missing")}
      aria-label={props.etiqueta}
      value={existe ? props.valor ?? "" : ""}
      onChange={(ev) => props.onChange(Number(ev.target.value))}
    >
      {!existe && (
        <option value="" disabled>
          ¿Quién?
        </option>
      )}
      {props.cobradores.map((c) => (
        <option key={c.id} value={c.id}>
          👤 {c.nombre}
        </option>
      ))}
    </select>
  );
}

function FilaTraspasoNueva(props: {
  inputRef: RefObject<HTMLInputElement>;
  cobradores: Cobrador[];
  defCobrador: number | null;
  onAdd: (t: Traspaso) => Promise<boolean>;
}) {
  const ids = props.cobradores.map((c) => c.id);
  const [fecha, setFecha] = useState(hoy());
  const [de, setDe] = useState<number | null>(null);
  const [a, setA] = useState<number | null>(null);
  const [importe, setImporte] = useState("");
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState(false);

  // Por defecto entrega quien está seleccionado arriba y recibe el siguiente
  const deEf = de !== null && ids.includes(de) ? de : props.defCobrador ?? ids[0];
  const aEf = a !== null && ids.includes(a) && a !== deEf ? a : ids.find((i) => i !== deEf) ?? null;
  const cents = aCentimos(importe);
  const listo = cents !== null && cents > 0 && aEf !== null && deEf !== aEf && !ocupado;

  const anadir = async () => {
    if (!listo || aEf === null) return;
    setOcupado(true);
    const ok = await props.onAdd({
      id: null,
      fecha,
      de_id: deEf,
      de: null,
      a_id: aEf,
      a: null,
      importe: cents as number,
      nota: nota.trim(),
    });
    setOcupado(false);
    if (ok) {
      setImporte("");
      setNota("");
    }
    props.inputRef.current?.focus();
  };
  const enter = (ev: React.KeyboardEvent) => ev.key === "Enter" && anadir();

  // Intercambiar al elegir el mismo en ambos lados
  const elegirDe = (id: number) => {
    if (id === aEf) setA(deEf);
    setDe(id);
  };
  const elegirA = (id: number) => {
    if (id === deEf) setDe(aEf);
    setA(id);
  };

  return (
    <tr className="newrow">
      <td className="c-fecha">
        <input
          type="date"
          className="cell date"
          aria-label="Fecha del nuevo traspaso"
          value={fecha}
          onChange={(ev) => setFecha(ev.target.value || hoy())}
        />
      </td>
      <td>
        <SelectCobrador
          etiqueta="Entrega (nuevo traspaso)"
          valor={deEf}
          cobradores={props.cobradores}
          onChange={elegirDe}
        />
      </td>
      <td className="c-flecha">
        <button
          type="button"
          className="icon-btn"
          title="Intercambiar quién entrega y quién recibe"
          onClick={() => {
            setDe(aEf);
            setA(deEf);
          }}
        >
          ⇄
        </button>
      </td>
      <td>
        <SelectCobrador
          etiqueta="Recibe (nuevo traspaso)"
          valor={aEf}
          cobradores={props.cobradores}
          onChange={elegirA}
        />
      </td>
      <td className="num c-importe">
        <div className="money-cell">
          <input
            ref={props.inputRef}
            className={"cell num" + (importe.trim() && !(cents && cents > 0) ? " invalid" : "")}
            inputMode="decimal"
            placeholder="0,00"
            aria-label="Importe del nuevo traspaso"
            value={importe}
            onChange={(ev) => setImporte(ev.target.value)}
            onKeyDown={enter}
          />
          <span>€</span>
        </div>
      </td>
      <td className="c-notas">
        <input
          className="cell"
          placeholder="Nota (opcional)"
          aria-label="Nota del nuevo traspaso"
          value={nota}
          onChange={(ev) => setNota(ev.target.value)}
          onKeyDown={enter}
        />
      </td>
      <td className="rowact">
        <button className="btn small primary" disabled={!listo} onClick={anadir}>
          Añadir
        </button>
      </td>
    </tr>
  );
}
