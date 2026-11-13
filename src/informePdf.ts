import jsPDF from "jspdf";
import autoTable from "jspdf-autotable/es";
import { Datos, eur, fmtFecha } from "./types";

type RGB = [number, number, number];
const AZUL: RGB = [29, 78, 216];
const AZUL_CLARO: RGB = [239, 244, 255];
const GRIS: RGB = [71, 85, 105];
const OSCURO: RGB = [30, 41, 59];
const ROJO: RGB = [185, 28, 28];
const VERDE: RGB = [21, 128, 61];
const METODO: Record<string, string> = { efectivo: "Efectivo", bizum: "Bizum" };

/** Nombre sugerido para el PDF: «Evento - AAAA-MM-DD.pdf». */
export function nombrePdf(d: Datos): string {
  const base = (d.config.evento || "celebracion").replace(/[\\/:*?"<>|]/g, "-").trim();
  return `${base} - resumen ${new Date().toLocaleDateString("sv-SE")}.pdf`;
}

/**
 * Informe completo del evento en PDF (A4), organizado en secciones numeradas:
 * 1 Cobros · 2 Comida · 3 Regalo · 4 Dinero y cobradores · 5 Participantes.
 */
export function informePdf(d: Datos): Uint8Array {
  const { config: c, resumen: r } = d;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const ancho = doc.internal.pageSize.getWidth();
  const m = 15;
  const util = ancho - 2 * m;
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "-");

  // ── Cabecera ──
  doc.setFont("helvetica", "bold").setFontSize(20).setTextColor(...AZUL);
  doc.text(c.evento || "Comida de celebración", m, 20);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...GRIS);
  let cur = 27;
  if (c.fecha) { doc.text(`Fecha / lugar: ${c.fecha}`, m, cur); cur += 5; }
  if (c.regalo_desc) { doc.text(`Regalo: ${c.regalo_desc}`, m, cur); cur += 5; }
  doc.text(`Informe generado el ${new Date().toLocaleString("es-ES")}`, m, cur);
  cur += 6;

  // ── Cuatro cifras clave ──
  {
    const cajas: { t: string; v: string; s: string; col: RGB }[] = [
      { t: "PARTICIPANTES", v: String(r.total_personas), s: `${r.con_comida} con comida · ${r.solo_regalo} solo regalo`, col: OSCURO },
      { t: "TOTAL PREVISTO", v: eur(r.total_esperado), s: `Comida ${eur(r.total_comida).replace(",00", "")} · Regalo ${eur(r.total_regalo).replace(",00", "")}`, col: OSCURO },
      { t: "RECOGIDO YA", v: eur(r.cobrado), s: `${r.pagados} personas · ${pct(r.cobrado, r.total_esperado)}`, col: VERDE },
      { t: "POR RECIBIR", v: eur(r.pendiente), s: `${r.pendientes} ${r.pendientes === 1 ? "persona" : "personas"}`, col: r.pendiente > 0 ? ROJO : VERDE },
    ];
    const gap = 3;
    const w = (util - gap * 3) / 4;
    cajas.forEach((k, i) => {
      const x = m + i * (w + gap);
      doc.setDrawColor(203, 213, 225).setFillColor(248, 250, 252).roundedRect(x, cur, w, 20, 2, 2, "FD");
      doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(...GRIS).text(k.t, x + 3, cur + 5);
      doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(...k.col).text(k.v, x + 3, cur + 12);
      doc.setFont("helvetica", "normal").setFontSize(6.5).setTextColor(...GRIS).text(k.s, x + 3, cur + 17, { maxWidth: w - 5 });
    });
    cur += 20;
  }

  // ── Utilidades de maquetación ──
  const nuevaPaginaSi = (hasta: number) => {
    if (cur > hasta) { doc.addPage(); cur = 18; }
  };
  /** Banda azul de sección numerada. */
  const seccion = (n: number, txt: string) => {
    nuevaPaginaSi(235);
    cur += 9;
    doc.setFillColor(...AZUL).roundedRect(m, cur, util, 8, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(255, 255, 255);
    doc.text(`${n}.  ${txt}`, m + 3, cur + 5.6);
    cur += 8;
  };
  /** Subtítulo dentro de una sección. */
  const sub = (txt: string, nota?: string) => {
    nuevaPaginaSi(250);
    cur += 7;
    doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...OSCURO).text(txt, m, cur);
    if (nota) {
      doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRIS);
      doc.text(nota, ancho - m, cur, { align: "right" });
    }
    cur += 2;
  };
  const texto = (txt: string) => {
    nuevaPaginaSi(270);
    cur += 5;
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...GRIS).text(txt, m, cur, { maxWidth: util });
  };
  type Opc = {
    head?: string[][];
    body: (string | number)[][];
    foot?: string[][];
    /** columnas alineadas a la derecha (importes) */
    der?: number[];
    ancho?: number[];
    fuente?: number;
    pie?: RGB;
    /** pinta de rojo la celda si devuelve true */
    rojo?: (fila: string[]) => boolean;
    verdeCol?: number;
    rojoCol?: number;
  };
  const tabla = (o: Opc) => {
    const der = o.der ?? [];
    const colStyles: Record<number, any> = {};
    der.forEach((i) => (colStyles[i] = { halign: "right" }));
    (o.ancho ?? []).forEach((w, i) => w && (colStyles[i] = { ...(colStyles[i] ?? {}), cellWidth: w }));
    autoTable(doc, {
      theme: "striped",
      styles: { font: "helvetica", fontSize: o.fuente ?? 9, cellPadding: 1.8 },
      headStyles: { fillColor: AZUL, textColor: 255 },
      footStyles: { fillColor: o.pie === ROJO ? [254, 242, 242] : AZUL_CLARO, textColor: o.pie ?? OSCURO, fontStyle: "bold" },
      margin: { left: m, right: m },
      startY: cur,
      head: o.head,
      body: o.body.map((f) => f.map(String)),
      foot: o.foot,
      showFoot: o.foot ? "lastPage" : "never",
      columnStyles: colStyles,
      didParseCell: (h) => {
        if (der.includes(h.column.index)) h.cell.styles.halign = "right";
        if (h.section === "body") {
          if (o.rojo && h.row.raw && o.rojo(h.row.raw as string[])) h.cell.styles.textColor = ROJO;
          if (o.verdeCol === h.column.index) h.cell.styles.textColor = VERDE;
          if (o.rojoCol === h.column.index && r.pendiente > 0) h.cell.styles.textColor = ROJO;
        }
      },
    });
    cur = (doc as any).lastAutoTable.finalY;
  };

  // ═══════════ 1. COBROS ═══════════
  seccion(1, "Cobros: recogido y por recibir");
  tabla({
    head: [["", "Previsto", "Recogido ya", "Por recibir", "% recogido"]],
    body: [
      ["Comida", eur(r.total_comida), eur(r.cobrado_comida), eur(r.pendiente_comida), pct(r.cobrado_comida, r.total_comida)],
      ["Regalo", eur(r.total_regalo), eur(r.cobrado_regalo), eur(r.pendiente_regalo), pct(r.cobrado_regalo, r.total_regalo)],
    ],
    foot: [["Total", eur(r.total_esperado), eur(r.cobrado), eur(r.pendiente), pct(r.cobrado, r.total_esperado)]],
    der: [1, 2, 3, 4],
    verdeCol: 2,
    rojoCol: 3,
  });
  texto(`Recogido en efectivo: ${eur(r.cobrado_efectivo)}   ·   por Bizum: ${eur(r.cobrado_bizum)}`);
  const debe = d.participantes.filter((p) => !p.pagado && !p.homenajeado).sort((x, y) => y.debe - x.debe);
  if (debe.length > 0) {
    sub(`Por recibir de ${debe.length} ${debe.length === 1 ? "persona" : "personas"}`);
    tabla({
      head: [["Nombre", "Modalidad", "Importe"]],
      body: debe.map((p) => [p.nombre, p.comida ? "Comida + regalo" : "Solo regalo", eur(p.debe)]),
      foot: [["", "Total por recibir", eur(r.pendiente)]],
      der: [2],
      pie: ROJO,
    });
  }

  // ═══════════ 2. COMIDA ═══════════
  if (r.con_comida > 0) {
    seccion(2, "Comida");
    sub("Asistentes");
    const con = d.participantes.filter((p) => p.comida && !p.homenajeado);
    const solo = d.participantes.filter((p) => !p.comida);
    const hom = d.participantes.filter((p) => p.homenajeado);
    const suma = (v: typeof con) => v.reduce((t, p) => t + p.debe, 0);
    tabla({
      head: [["Modalidad", "Personas", "Importe"]],
      body: [
        ["Van a la comida (comida + regalo)", con.length, eur(suma(con))],
        ...(hom.length > 0 ? [["Homenajeados (no pagan)", hom.length, eur(0)]] : []),
        ["Solo aportan al regalo", solo.length, eur(suma(solo))],
      ],
      foot: [["Total", String(d.participantes.length), eur(suma(d.participantes))]],
      der: [1, 2],
    });

    if (d.menus.length > 0) {
      const sin = d.participantes.filter((p) => p.comida && !p.menu_id).length;
      const filas: (string | number)[][] = d.menus.map((k) => [k.nombre, k.personas]);
      if (sin > 0) filas.push(["(sin elegir)", sin]);
      sub("Menús elegidos", "incluye homenajeados");
      tabla({
        head: [["Menú", "Personas"]],
        body: filas,
        foot: [["Total con comida", String(r.con_comida)]],
        der: [1],
      });
    }

    sub("Desglose de la comida");
    const delRegalo = r.comida_homenajeados - r.comida_cubierta;
    tabla({
      head: [["Concepto", "Importe"]],
      body: [
        ["Recogido para la comida", eur(r.cobrado_comida)],
        ["+ Falta por recibir", eur(r.pendiente_comida)],
        ...(r.homenajeados > 0 ? [[`+ Comida de homenajeados (${r.homenajeados})`, eur(r.comida_homenajeados)]] : []),
        ...(r.homenajeados > 0 && r.comida_cubierta > 0 ? [["      cubierta con dinero extra de la comida", eur(r.comida_cubierta)]] : []),
        ...(r.homenajeados > 0 && delRegalo > 0 ? [["      cubierta con el fondo del regalo", eur(delRegalo)]] : []),
        ...(r.sobrante_comida > 0 ? [["Sobrante del dinero extra de la comida", eur(r.sobrante_comida)]] : []),
      ],
      foot: [[`= Coste total de la comida (${r.con_comida} comensales)`, eur(r.total_comida + r.comida_homenajeados)]],
      der: [1],
    });
  }

  // ═══════════ 3. REGALO ═══════════
  seccion(3, "Regalo");
  sub("Resumen del regalo");
  tabla({
    head: [["Concepto", "Importe"]],
    body: [
      ["Total recaudado", eur(r.cobrado_regalo)],
      ...(r.aportes_regalo > 0 ? [["+ Dinero extra añadido (sobrante)", eur(r.aportes_regalo)]] : []),
      ["- Total gastado", eur(r.gastado)],
      ...(r.homenajeados > 0
        ? [[`- Comida de homenajeados (${r.homenajeados})${r.comida_cubierta > 0 ? ", tras dinero extra de la comida" : ""}`, eur(r.comida_homenajeados - r.comida_cubierta)]]
        : []),
    ],
    foot: [[r.disponible_regalo < 0 ? "= Gastado de más" : "= Disponible para el regalo", eur(Math.abs(r.disponible_regalo))]],
    der: [1],
    pie: r.disponible_regalo < 0 ? ROJO : VERDE,
  });
  if (r.pendiente_regalo > 0) {
    texto(`Previsto si pagan todos (faltan ${eur(r.pendiente_regalo)} por recibir): ${eur(r.disponible_regalo + r.pendiente_regalo)}`);
  }

  if (d.gastos.length > 0) {
    sub(`Gastos del regalo (${d.gastos.length})`);
    tabla({
      head: [["Fecha", "Concepto", "Pagado por", "Importe"]],
      body: d.gastos.map((g) => [fmtFecha(g.fecha), g.concepto, g.cobrador ?? "", eur(g.importe)]),
      foot: [["", "", "Total gastado", eur(r.gastado)]],
      der: [3],
      ancho: [26, 0, 40, 28],
    });
  }
  if (d.aportes.length > 0) {
    sub("Dinero extra (sobrante de otros años…)");
    tabla({
      head: [["Fecha", "Concepto", "Destino", "Importe"]],
      body: d.aportes.map((a) => [fmtFecha(a.fecha), a.concepto, a.destino === "regalo" ? "Regalo" : "Comida", eur(a.importe)]),
      foot: [["", "", "Total", eur(r.aportes_regalo + r.aportes_comida)]],
      der: [3],
      ancho: [26, 0, 40, 28],
    });
  }

  // ═══════════ 4. DINERO Y COBRADORES ═══════════
  if (d.cobradores.length > 0) {
    seccion(4, "Dinero y cobradores");
    sub("¿Dónde está el dinero?");
    tabla({
      head: [["Cobrador", "Cobros", "Cobrado", "Efectivo", "Bizum", "Gastado", "Recibido", "Entregado", "Tiene ahora"]],
      body: d.cobradores.map((k) => [
        k.nombre, k.cobros, eur(k.total), eur(k.efectivo), eur(k.bizum),
        eur(k.gastado), eur(k.recibido), eur(k.entregado), eur(k.saldo),
      ]),
      fuente: 8,
      der: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    if (d.traspasos.length > 0) {
      sub("Traspasos entre cobradores");
      tabla({
        head: [["Fecha", "Entrega", "Recibe", "Importe", "Nota"]],
        body: d.traspasos.map((t) => [fmtFecha(t.fecha), t.de ?? "", t.a ?? "", eur(t.importe), t.nota]),
        der: [3],
      });
    }
  }

  // ═══════════ 5. PARTICIPANTES ═══════════
  seccion(5, `Participantes (${r.pagados} de ${r.total_personas} han pagado)`);
  tabla({
    head: [["Nombre", "Modalidad", "Regalo", "Importe", "Estado", "Fecha", "Cobrado por", "Método"]],
    body: d.participantes.map((p) => [
      p.nombre,
      p.homenajeado ? (p.menu ? `${p.menu} (homenajeado)` : "Homenajeado") : p.comida ? (p.menu ? `${p.menu} + regalo` : "Comida + regalo") : "Solo regalo",
      p.homenajeado ? "" : eur(p.importe_regalo ?? c.precio_regalo),
      eur(p.debe),
      p.homenajeado ? "Homenaje" : p.pagado ? "Pagado" : "Pendiente",
      fmtFecha(p.fecha_pago),
      p.cobrador ?? "",
      p.metodo ? METODO[p.metodo] ?? p.metodo : "",
    ]),
    fuente: 8,
    der: [2, 3],
    rojo: (f) => f[4] === "Pendiente",
  });

  // ── Pie con número de página ──
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(203, 213, 225).line(m, 286, ancho - m, 286);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRIS);
    doc.text(c.evento || "Comida de celebración", m, 291);
    doc.text(`Página ${i} de ${n}`, ancho - m, 291, { align: "right" });
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
