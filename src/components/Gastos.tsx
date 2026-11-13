import Icono from "./Icono";
import { RefObject, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Aporte,
  Cobrador,
  Config,
  Gasto,
  Resumen,
  aCentimos,
  deCentimos,
  eur,
  fmtFecha,
  hoy,
  normalizar,
} from "../types";
import CeldaTexto from "./CeldaTexto";
import CeldaSelect from "./CeldaSelect";

export type Ejecutar = (
  fn: () => Promise<unknown>,
  exito?: { texto: string; deshacer?: () => void }
) => Promise<boolean>;

export const importeValido = (t: string) => (aCentimos(t) ?? 0) > 0;

/** Vista de los gastos del regalo: resumen, alta rápida y lista editable. */
export default function GastosView(props: {
  gastos: Gasto[];
  aportes: Aporte[];
  resumen: Resumen;
  config: Config;
  cobradores: Cobrador[];
  defCobrador: number | null;
  busqueda: string;
  resaltados: Set<string>;
  resaltar: (clave: string) => void;
  ejecutar: Ejecutar;
  nuevoRef: RefObject<HTMLInputElement>;
}) {
  const { resumen: r, cobradores } = props;

  const lista = useMemo(() => {
    const q = normalizar(props.busqueda);
    return q
      ? props.gastos.filter((g) => normalizar(g.concepto + " " + (g.cobrador ?? "")).includes(q))
      : props.gastos;
  }, [props.gastos, props.busqueda]);

  const pctGastado =
    r.cobrado_regalo > 0 ? Math.min(100, Math.round((r.gastado / r.cobrado_regalo) * 100)) : 0;
  const excedido = r.disponible_regalo < 0;

  const actualizar = (g: Gasto, cambios: Record<string, unknown>) => {
    props.resaltar("g" + g.id);
    return props.ejecutar(() =>
      invoke("actualizar_gasto", {
        id: g.id,
        concepto: null,
        importe: null,
        fecha: null,
        cobradorId: null,
        ...cambios,
      })
    );
  };

  const eliminar = (g: Gasto) =>
    props.ejecutar(() => invoke("eliminar_gasto", { id: g.id }), {
      texto: `Gasto «${g.concepto}» (${eur(g.importe)}) eliminado`,
      deshacer: () =>
        props.ejecutar(() => invoke("restaurar_gasto", { gasto: g }), {
          texto: `Gasto «${g.concepto}» recuperado`,
        }),
    });

  return (
    <>
      <h2 className="print-only">Gastos del regalo</h2>
      <section className={"regalo-resumen" + (excedido ? " excedido" : "")}>
        <div className="rr-item">
          <div className="card-title">Recaudado para el regalo</div>
          <div className="rr-valor">{eur(r.cobrado_regalo)}</div>
          <div className="card-sub">
            de {eur(r.total_regalo)} previstos
            {r.pendiente_regalo > 0 && <> · faltan {eur(r.pendiente_regalo)}</>}
          </div>
        </div>
        {r.aportes_regalo > 0 && (
          <>
            <div className="rr-op">+</div>
            <div className="rr-item">
              <div className="card-title">Aportado (sobrante…)</div>
              <div className="rr-valor">{eur(r.aportes_regalo)}</div>
              <div className="card-sub">Dinero extra añadido al regalo</div>
            </div>
          </>
        )}
        <div className="rr-op">−</div>
        <div className="rr-item">
          <div className="card-title">Gastado</div>
          <div className="rr-valor">{eur(r.gastado)}</div>
          <div className="card-sub">
            {r.gastos} {r.gastos === 1 ? "gasto" : "gastos"}
          </div>
        </div>
        {r.comida_homenajeados > 0 && (
          <>
            <div className="rr-op">−</div>
            <div className="rr-item">
              <div className="card-title">Comida de homenajeados</div>
              <div className="rr-valor">{eur(r.comida_homenajeados - r.comida_cubierta)}</div>
              <div className="card-sub">
                {r.homenajeados} {r.homenajeados === 1 ? "persona" : "personas"} · no pagan
                {r.comida_cubierta > 0 && <> · {eur(r.comida_cubierta)} cubiertos con el dinero extra de la comida</>}
              </div>
            </div>
          </>
        )}
        <div className="rr-op">=</div>
        <div className={"rr-item destacado " + (excedido ? "bad" : "good")}>
          <div className="card-title">{excedido ? "Gastado de más" : "Disponible"}</div>
          <div className="rr-valor">{eur(Math.abs(r.disponible_regalo))}</div>
          <div className="card-sub">
            {excedido
              ? "Se ha gastado más de lo recaudado para el regalo"
              : props.config.regalo_desc
              ? `Para: ${props.config.regalo_desc}`
              : "Queda para el regalo"}
          </div>
        </div>
        <div className="rr-barra" aria-label={`${pctGastado}% del dinero del regalo gastado`}>
          <div className="bar" style={{ width: pctGastado + "%" }} />
        </div>
      </section>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="c-fecha">Fecha</th>
              <th>Concepto</th>
              <th className="c-cobrador">Pagado por</th>
              <th className="num c-importe">Importe</th>
              <th className="rowact" aria-label="Acciones"></th>
            </tr>
          </thead>
          <tbody>
            <FilaGastoNueva
              inputRef={props.nuevoRef}
              cobradores={cobradores}
              defCobrador={props.defCobrador}
              onAdd={(g) =>
                props.ejecutar(() => invoke("guardar_gasto", { gasto: g }), {
                  texto: `Gasto «${g.concepto.trim()}» de ${eur(g.importe)} apuntado`,
                })
              }
            />
            {lista.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  {props.gastos.length === 0 ? (
                    <>
                      <div className="empty-ico"><Icono n="receipt" size={36} /></div>
                      Aún no hay gastos.
                      <br />
                      Apunta en la fila de arriba lo que se vaya comprando para el regalo
                      (reloj, flores, tarjeta…).
                    </>
                  ) : (
                    <>Ningún gasto coincide con «{props.busqueda}».</>
                  )}
                </td>
              </tr>
            )}
            {lista.map((g) => (
              <tr key={g.id} className={props.resaltados.has("g" + g.id) ? "flash" : ""}>
                <td className="c-fecha">
                  <input
                    type="date"
                    className="cell date"
                    aria-label="Fecha del gasto"
                    value={g.fecha}
                    title={fmtFecha(g.fecha)}
                    onChange={(ev) => ev.target.value && actualizar(g, { fecha: ev.target.value })}
                  />
                </td>
                <td>
                  <CeldaTexto
                    valor={g.concepto}
                    requerido
                    etiqueta="Concepto"
                    onCommit={(v) => actualizar(g, { concepto: v })}
                  />
                </td>
                <td className="c-cobrador">
                  {cobradores.length > 0 ? (
                    <CeldaSelect
                      valor={g.cobrador_id}
                      opciones={cobradores.map((c) => ({ id: c.id, txt: c.nombre }))}
                      etiqueta="Pagado por"
                      falta="¿Quién?"
                      onChange={(v) => actualizar(g, { cobradorId: Number(v) })}
                    />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num c-importe">
                  <CeldaTexto
                    valor={deCentimos(g.importe)}
                    requerido
                    validar={importeValido}
                    inputMode="decimal"
                    clase="num"
                    etiqueta="Importe del gasto"
                    onCommit={(v) => actualizar(g, { importe: aCentimos(v) })}
                  />
                </td>
                <td className="rowact">
                  <button
                    className="icon-btn danger"
                    title={`Eliminar el gasto «${g.concepto}»`}
                    aria-label={`Eliminar el gasto ${g.concepto}`}
                    onClick={() => eliminar(g)}
                  >
                    <Icono n="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {props.gastos.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3} className="tfoot-label">
                  Total gastado
                </td>
                <td className="num tfoot-total">{eur(r.gastado)}</td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {r.sobrante_comida > 0 && (
        <p className="muted small">Sobrante apartado para la comida: {eur(r.sobrante_comida)}</p>
      )}
      <AportesSeccion aportes={props.aportes} ejecutar={props.ejecutar} />
    </>
  );
}

/** Dinero extra (p. ej. sobrante de otros años) que se añade al fondo del regalo o a la comida. */
function AportesSeccion(props: { aportes: Aporte[]; ejecutar: Ejecutar }) {
  const [concepto, setConcepto] = useState("");
  const [importe, setImporte] = useState("");
  const [destino, setDestino] = useState<"regalo" | "comida">("regalo");
  const [fecha, setFecha] = useState(hoy());
  const cents = aCentimos(importe);
  const listo = concepto.trim() !== "" && cents !== null && cents > 0;

  const anadir = async () => {
    if (!listo || cents === null) return;
    const ok = await props.ejecutar(
      () => invoke("guardar_aporte", { aporte: { id: null, concepto, importe: cents, fecha, destino } }),
      { texto: `Aportación de ${eur(cents)} añadida al ${destino === "regalo" ? "regalo" : "fondo de la comida"}` }
    );
    if (ok) {
      setConcepto("");
      setImporte("");
    }
  };

  return (
    <section className="aportes">
      <h3 className="sub">Dinero extra (sobrante de otros años…)</h3>
      <p className="muted small">
        Se suma al fondo del regalo o se aparta para la comida. No lo paga ningún participante.
      </p>
      <div className="addrow">
        <input
          placeholder="Concepto (p. ej. Sobrante de 2025)"
          aria-label="Concepto de la aportación"
          value={concepto}
          onChange={(ev) => setConcepto(ev.target.value)}
          onKeyDown={(ev) => ev.key === "Enter" && anadir()}
        />
        <input
          inputMode="decimal"
          placeholder="Importe"
          aria-label="Importe de la aportación"
          value={importe}
          onChange={(ev) => setImporte(ev.target.value)}
          onKeyDown={(ev) => ev.key === "Enter" && anadir()}
        />
        <select aria-label="Destino" value={destino} onChange={(ev) => setDestino(ev.target.value as "regalo" | "comida")}>
          <option value="regalo">Al regalo</option>
          <option value="comida">A la comida</option>
        </select>
        <input type="date" aria-label="Fecha" value={fecha} max={hoy()} onChange={(ev) => ev.target.value && setFecha(ev.target.value)} />
        <button className="btn primary" disabled={!listo} onClick={anadir}>
          Añadir
        </button>
      </div>
      {props.aportes.length > 0 && (
        <ul className="aportes-lista">
          {props.aportes.map((a) => (
            <li key={a.id}>
              <span>
                {fmtFecha(a.fecha)} · {a.concepto} · <b>{a.destino === "regalo" ? "Regalo" : "Comida"}</b>
              </span>
              <b>{eur(a.importe)}</b>
              <button
                className="icon-btn danger"
                title="Eliminar esta aportación"
                aria-label={`Eliminar la aportación ${a.concepto}`}
                onClick={() =>
                  props.ejecutar(() => invoke("eliminar_aporte", { id: a.id }), {
                    texto: `Aportación «${a.concepto}» eliminada`,
                  })
                }
              >
                <Icono n="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilaGastoNueva(props: {
  inputRef: RefObject<HTMLInputElement>;
  cobradores: Cobrador[];
  defCobrador: number | null;
  onAdd: (g: Gasto) => Promise<boolean>;
}) {
  const [fecha, setFecha] = useState(hoy());
  const [concepto, setConcepto] = useState("");
  const [cobrador, setCobrador] = useState<number | null>(null);
  const [importe, setImporte] = useState("");
  const [ocupado, setOcupado] = useState(false);

  // Mientras no se elija otro, se usa lo seleccionado en «Al cobrar»
  const quien =
    cobrador !== null && props.cobradores.some((c) => c.id === cobrador)
      ? cobrador
      : props.defCobrador;
  const cents = aCentimos(importe);
  const listo = concepto.trim() !== "" && cents !== null && cents > 0 && !ocupado;

  const anadir = async () => {
    if (!listo) return;
    setOcupado(true);
    const ok = await props.onAdd({
      id: null,
      concepto: concepto.trim(),
      importe: cents as number,
      fecha,
      cobrador_id: quien,
      cobrador: null,
    });
    setOcupado(false);
    if (ok) {
      setConcepto("");
      setImporte("");
    }
    props.inputRef.current?.focus();
  };
  const enter = (ev: React.KeyboardEvent) => ev.key === "Enter" && anadir();

  return (
    <tr className="newrow">
      <td className="c-fecha">
        <input
          type="date"
          className="cell date"
          aria-label="Fecha del nuevo gasto"
          value={fecha}
          onChange={(ev) => setFecha(ev.target.value || hoy())}
        />
      </td>
      <td>
        <input
          ref={props.inputRef}
          className="cell"
          placeholder="Concepto: reloj, flores, tarjeta…"
          aria-label="Concepto del nuevo gasto"
          value={concepto}
          onChange={(ev) => setConcepto(ev.target.value)}
          onKeyDown={enter}
        />
      </td>
      <td className="c-cobrador">
        {props.cobradores.length > 0 ? (
          <select
            className="inline"
            aria-label="Quién paga el nuevo gasto"
            value={quien ?? ""}
            onChange={(ev) => setCobrador(Number(ev.target.value))}
          >
            {props.cobradores.map((c) => (
              <option key={c.id} value={c.id}>
                <Icono n="user" /> {c.nombre}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted small">Sin cobradores</span>
        )}
      </td>
      <td className="num c-importe">
        <div className="money-cell">
          <input
            className={"cell num" + (importe.trim() && !(cents && cents > 0) ? " invalid" : "")}
            inputMode="decimal"
            placeholder="0,00"
            aria-label="Importe del nuevo gasto"
            value={importe}
            onChange={(ev) => setImporte(ev.target.value)}
            onKeyDown={enter}
          />
          <span>€</span>
        </div>
      </td>
      <td className="rowact">
        <button className="btn small primary" disabled={!listo} onClick={anadir}>
          Añadir
        </button>
      </td>
    </tr>
  );
}
