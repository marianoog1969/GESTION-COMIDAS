import { Datos, eur, fmtFecha } from "./types";

/** Importe para Excel: 4500 → "45,00" (coma decimal, como espera Excel en español). */
const num = (c: number): string => (c / 100).toFixed(2).replace(".", ",");

/** Entrecomilla solo si hace falta; el separador es «;». */
const campo = (v: string | number): string => {
  const t = String(v);
  return /[";\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};

const fila = (...celdas: (string | number)[]): string => celdas.map(campo).join(";");

const METODO: Record<string, string> = { efectivo: "Efectivo", bizum: "Bizum" };

/**
 * Informe completo en CSV: resumen, participantes, gastos, traspasos y caja por
 * cobrador. Se abre con doble clic en Excel.
 */
export function informeCsv(d: Datos): string {
  const { config: c, resumen: r } = d;
  const L: string[] = [];

  L.push(fila(c.evento || "Celebración"));
  if (c.fecha) L.push(fila("Fecha / lugar", c.fecha));
  if (c.regalo_desc) L.push(fila("Regalo", c.regalo_desc));
  L.push(fila("Informe generado el", new Date().toLocaleString("es-ES")));
  L.push("");

  L.push(fila("RESUMEN"));
  L.push(fila("Concepto", "Importe", "Personas"));
  L.push(fila("Total previsto", num(r.total_esperado), r.total_personas));
  L.push(fila("Cobrado", num(r.cobrado), r.pagados));
  L.push(fila("Falta por cobrar", num(r.pendiente), r.pendientes));
  L.push(fila("Recaudado para el regalo", num(r.cobrado_regalo), ""));
  if (r.aportes_regalo > 0) L.push(fila("Dinero extra añadido al regalo", num(r.aportes_regalo), ""));
  if (r.aportes_comida > 0) L.push(fila("Dinero extra apartado para la comida", num(r.aportes_comida), ""));
  L.push(fila("Gastado en el regalo", num(r.gastado), r.gastos));
  if (r.homenajeados > 0) L.push(fila("Comida de homenajeados (a cargo del regalo)", num(r.comida_homenajeados), r.homenajeados));
  L.push(fila("Disponible para el regalo", num(r.disponible_regalo), ""));
  L.push(fila("Cobrado en efectivo", num(r.cobrado_efectivo), ""));
  L.push(fila("Cobrado por Bizum", num(r.cobrado_bizum), ""));
  L.push(fila("En manos de los cobradores", num(r.cobrado - r.gastado), ""));
  L.push("");

  L.push(fila("PARTICIPANTES"));
  L.push(fila("Nombre", "Modalidad", "Menú", "Regalo", "Importe", "Estado", "Fecha de pago", "Cobrado por", "Método", "Notas"));
  for (const p of d.participantes) {
    L.push(
      fila(
        p.nombre,
        p.homenajeado ? "Homenajeado" : p.comida ? "Comida + regalo" : "Solo regalo",
        p.menu ?? "",
        num(p.importe_regalo ?? d.config.precio_regalo),
        num(p.debe),
        p.homenajeado ? "Homenaje" : p.pagado ? "Pagado" : "Pendiente",
        fmtFecha(p.fecha_pago),
        p.cobrador ?? "",
        p.metodo ? METODO[p.metodo] ?? p.metodo : "",
        p.notas
      )
    );
  }
  L.push(fila("TOTAL", "", "", "", num(r.total_esperado), `${r.pagados} pagados / ${r.pendientes} pendientes`, "", "", "", ""));
  L.push("");
  if (d.menus.length > 0) {
    L.push(fila("MENÚS"));
    L.push(fila("Menú", "Personas"));
    for (const m of d.menus) L.push(fila(m.nombre, String(m.personas)));
    const sin = d.participantes.filter((p) => p.comida && !p.menu_id).length;
    if (sin > 0) L.push(fila("(sin elegir)", String(sin)));
    L.push("");
  }

  if (d.gastos.length > 0) {
    L.push(fila("GASTOS DEL REGALO"));
    L.push(fila("Fecha", "Concepto", "Pagado por", "Importe"));
    for (const g of d.gastos) {
      L.push(fila(fmtFecha(g.fecha), g.concepto, g.cobrador ?? "", num(g.importe)));
    }
    L.push(fila("", "", "Total", num(r.gastado)));
    L.push("");
  }

  if (d.traspasos.length > 0) {
    L.push(fila("TRASPASOS ENTRE COBRADORES"));
    L.push(fila("Fecha", "Entrega", "Recibe", "Importe", "Nota"));
    for (const t of d.traspasos) {
      L.push(fila(fmtFecha(t.fecha), t.de ?? "", t.a ?? "", num(t.importe), t.nota));
    }
    L.push("");
  }

  if (d.cobradores.length > 0) {
    L.push(fila("CAJA POR COBRADOR"));
    L.push(
      fila("Cobrador", "Cobros", "Cobrado", "En efectivo", "Por Bizum", "Gastado", "Traspasado de otros", "Traspasado a otros", "Tiene ahora")
    );
    for (const k of d.cobradores) {
      L.push(
        fila(
          k.nombre,
          k.cobros,
          num(k.total),
          num(k.efectivo),
          num(k.bizum),
          num(k.gastado),
          num(k.recibido),
          num(k.entregado),
          num(k.saldo)
        )
      );
    }
  }

  return L.join("\r\n") + "\r\n";
}

/** Nombre propuesto: «Jubilación de Ana - 2026-11-08.csv», sin caracteres prohibidos. */
export function nombreArchivo(d: Datos): string {
  const base = (d.config.evento || "celebracion").replace(/[\\/:*?"<>|]/g, "-").trim();
  return `${base} - ${new Date().toLocaleDateString("sv-SE")}.csv`;
}

/** Lista de quien falta por pagar, lista para pegar en WhatsApp o en un correo. */
export function textoPendientes(d: Datos): string {
  const pendientes = d.participantes.filter((p) => !p.pagado && !p.homenajeado);
  const L = [`${d.config.evento || "Celebración"}${d.config.fecha ? ` (${d.config.fecha})` : ""}`];
  L.push(
    pendientes.length === 1
      ? "Falta por pagar 1 persona:"
      : `Faltan por pagar ${pendientes.length} personas:`
  );
  for (const p of pendientes) {
    L.push(`• ${p.nombre}: ${eur(p.debe)}${p.comida ? "" : " (solo regalo)"}`);
  }
  L.push(`Total pendiente: ${eur(d.resumen.pendiente)}`);
  return L.join("\n");
}

/** Copia al portapapeles; en el WebView la API moderna puede fallar, de ahí el plan B. */
export async function copiar(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = texto;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
