import jsPDF from "jspdf";
import autoTable from "jspdf-autotable/es";
import { Datos, eur, fmtFecha } from "./types";

const AZUL: [number, number, number] = [29, 78, 216];
const GRIS: [number, number, number] = [71, 85, 105];
const METODO: Record<string, string> = { efectivo: "Efectivo", bizum: "Bizum" };

/** Nombre sugerido para el PDF: «Evento - AAAA-MM-DD.pdf». */
export function nombrePdf(d: Datos): string {
  const base = (d.config.evento || "celebracion").replace(/[\\/:*?"<>|]/g, "-").trim();
  return `${base} - resumen ${new Date().toLocaleDateString("sv-SE")}.pdf`;
}

/** Resumen completo del evento en PDF (A4): totales, menús, caja, participantes, gastos y traspasos. */
export function informePdf(d: Datos): Uint8Array {
  const { config: c, resumen: r } = d;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const ancho = doc.internal.pageSize.getWidth();
  const m = 15;

  doc.setFont("helvetica", "bold").setFontSize(20).setTextColor(...AZUL);
  doc.text(c.evento || "Comida de celebración", m, 20);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...GRIS);
  let y = 27;
  if (c.fecha) { doc.text(`Fecha / lugar: ${c.fecha}`, m, y); y += 5; }
  if (c.regalo_desc) { doc.text(`Regalo: ${c.regalo_desc}`, m, y); y += 5; }
  doc.text(`Informe generado el ${new Date().toLocaleString("es-ES")}`, m, y);
  y += 4;

  const estiloTabla = {
    theme: "striped" as const,
    styles: { font: "helvetica", fontSize: 9, cellPadding: 1.8 },
    headStyles: { fillColor: AZUL, textColor: 255 },
    margin: { left: m, right: m },
  };
  const titulo = (txt: string) => {
    const fin = (doc as any).lastAutoTable?.finalY ?? y;
    let ty = fin + 9;
    if (ty > 245) { doc.addPage(); ty = 20; }
    doc.setFont("helvetica", "bold").setFontSize(12).setTextColor(...AZUL);
    doc.text(txt, m, ty);
    return ty + 2;
  };
  const num = { halign: "right" as const };

  // Resumen
  autoTable(doc, {
    ...estiloTabla,
    startY: y + 2,
    head: [["Resumen", "Importe", "Personas"]],
    body: [
      ["Total previsto", eur(r.total_esperado), String(r.total_personas)],
      ["Cobrado", eur(r.cobrado), String(r.pagados)],
      ["Falta por cobrar", eur(r.pendiente), String(r.pendientes)],
      ["Recaudado para el regalo", eur(r.cobrado_regalo), ""],
      ...(r.aportes_regalo > 0 ? [["Dinero extra añadido al regalo", eur(r.aportes_regalo), ""]] : []),
      ...(r.aportes_comida > 0
        ? [["Dinero extra para la comida (cubre a homenajeados)", eur(r.aportes_comida), ""]]
        : []),
      ...(r.sobrante_comida > 0 ? [["Sobrante de la comida", eur(r.sobrante_comida), ""]] : []),
      ["Gastado en el regalo", eur(r.gastado), String(r.gastos)],
      ...(r.homenajeados > 0
        ? [["Comida de homenajeados (a cargo del regalo)", eur(r.comida_homenajeados), String(r.homenajeados)]]
        : []),
      ["Disponible para el regalo", eur(r.disponible_regalo), ""],
      ["Cobrado en efectivo", eur(r.cobrado_efectivo), ""],
      ["Cobrado por Bizum", eur(r.cobrado_bizum), ""],
    ],
    columnStyles: { 1: num, 2: num },
  });

  // Revisión de cobros: recogido ya y por recibir
  {
    const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "-");
    autoTable(doc, {
      ...estiloTabla,
      startY: titulo("Revisión de cobros: recogido y por recibir"),
      head: [["", "Previsto", "Recogido ya", "Por recibir", "% recogido"]],
      body: [
        ["Comida", eur(r.total_comida), eur(r.cobrado_comida), eur(r.pendiente_comida), pct(r.cobrado_comida, r.total_comida)],
        ["Regalo", eur(r.total_regalo), eur(r.cobrado_regalo), eur(r.pendiente_regalo), pct(r.cobrado_regalo, r.total_regalo)],
      ],
      foot: [["Total", eur(r.total_esperado), eur(r.cobrado), eur(r.pendiente), pct(r.cobrado, r.total_esperado)]],
      showFoot: "lastPage",
      footStyles: { fillColor: [239, 244, 255], textColor: [30, 41, 59], fontStyle: "bold" },
      columnStyles: { 1: num, 2: num, 3: num, 4: num },
      didParseCell: (h) => {
        if (h.column.index > 0 && h.column.index < 5) h.cell.styles.halign = "right";
        if (h.column.index === 3 && h.section !== "head" && r.pendiente > 0) h.cell.styles.textColor = [185, 28, 28];
        if (h.column.index === 2 && h.section !== "head") h.cell.styles.textColor = [21, 128, 61];
      },
    });
    const debe = d.participantes.filter((p) => !p.pagado && !p.homenajeado).sort((x, y) => y.debe - x.debe);
    if (debe.length > 0) {
      autoTable(doc, {
        ...estiloTabla,
        startY: titulo(`Por recibir de ${debe.length} ${debe.length === 1 ? "persona" : "personas"}`),
        head: [["Nombre", "Modalidad", "Importe"]],
        body: debe.map((p) => [p.nombre, p.comida ? "Comida + regalo" : "Solo regalo", eur(p.debe)]),
        foot: [["", "Total por recibir", eur(r.pendiente)]],
        showFoot: "lastPage",
        footStyles: { fillColor: [254, 242, 242], textColor: [185, 28, 28], fontStyle: "bold" },
        columnStyles: { 2: num },
        didParseCell: (h) => {
          if (h.section === "foot" && h.column.index > 0) h.cell.styles.halign = "right";
        },
      });
    }
  }

  // Desglose de la comida
  if (r.con_comida > 0) {
    autoTable(doc, {
      ...estiloTabla,
      startY: titulo("Comida"),
      head: [["Concepto", "Importe"]],
      body: [
        ["Cobrado para la comida", eur(r.cobrado_comida)],
        ["+ Falta por cobrar", eur(r.pendiente_comida)],
        ...(r.homenajeados > 0
          ? [[`+ Comida de homenajeados (${r.homenajeados})`, eur(r.comida_homenajeados)]]
          : []),
        ...(r.homenajeados > 0 && r.comida_cubierta > 0
          ? [["   cubierta con dinero extra de la comida", eur(r.comida_cubierta)]]
          : []),
        ...(r.homenajeados > 0 && r.comida_homenajeados - r.comida_cubierta > 0
          ? [["   cubierta con el fondo del regalo", eur(r.comida_homenajeados - r.comida_cubierta)]]
          : []),
        ...(r.sobrante_comida > 0 ? [["Sobrante del dinero extra de la comida", eur(r.sobrante_comida)]] : []),
      ],
      foot: [[`Coste total de la comida (${r.con_comida} comensales)`, eur(r.total_comida + r.comida_homenajeados)]],
      showFoot: "lastPage",
      footStyles: { fillColor: [239, 244, 255], textColor: [30, 41, 59], fontStyle: "bold" },
      columnStyles: { 1: num },
      tableWidth: 120,
      didParseCell: (h) => {
        if (h.section === "foot" && h.column.index === 1) h.cell.styles.halign = "right";
      },
    });
  }

  // Quién va a la comida y quién solo aporta al regalo
  {
    const con = d.participantes.filter((p) => p.comida);
    const solo = d.participantes.filter((p) => !p.comida);
    const suma = (v: typeof con) => v.reduce((t, p) => t + p.debe, 0);
    autoTable(doc, {
      ...estiloTabla,
      startY: titulo("Asistentes y aportaciones"),
      head: [["Modalidad", "Personas", "Total"]],
      body: [
        ["Van a la comida (comida + regalo)", String(con.length), eur(suma(con))],
        ["Solo aportan al regalo", String(solo.length), eur(suma(solo))],
      ],
      foot: [["Total", String(d.participantes.length), eur(suma(d.participantes))]],
      showFoot: "lastPage",
      footStyles: { fillColor: [239, 244, 255], textColor: [30, 41, 59], fontStyle: "bold" },
      columnStyles: { 1: num, 2: num },
      tableWidth: 120,
    });
    if (con.length > 0) {
      autoTable(doc, {
        ...estiloTabla,
        startY: titulo(`Quién va a la comida (${con.length})`),
        head: [["Nombre", "Menú"]],
        body: con.map((p) => [p.nombre, p.menu ?? ""]),
        tableWidth: 120,
      });
    }
  }

  // Menús
  if (d.menus.length > 0) {
    const sin = d.participantes.filter((p) => p.comida && !p.menu_id).length;
    const filas = d.menus.map((k) => [k.nombre, String(k.personas)]);
    if (sin > 0) filas.push(["(sin elegir)", String(sin)]);
    filas.push(["Solo regalo (sin comida)", String(r.solo_regalo)]);
    autoTable(doc, {
      ...estiloTabla,
      startY: titulo("Menús"),
      head: [["Menú", "Personas"]],
      body: filas,
      columnStyles: { 1: num },
      tableWidth: 90,
    });
  }

  // Caja por cobrador
  if (d.cobradores.length > 0) {
    autoTable(doc, {
      ...estiloTabla,
      startY: titulo("¿Dónde está el dinero?"),
      head: [["Cobrador", "Cobros", "Cobrado", "Efectivo", "Bizum", "Gastado", "Recibido", "Entregado", "Tiene ahora"]],
      body: d.cobradores.map((k) => [
        k.nombre, String(k.cobros), eur(k.total), eur(k.efectivo), eur(k.bizum),
        eur(k.gastado), eur(k.recibido), eur(k.entregado), eur(k.saldo),
      ]),
      styles: { ...estiloTabla.styles, fontSize: 8 },
      columnStyles: { 1: num, 2: num, 3: num, 4: num, 5: num, 6: num, 7: num, 8: { ...num, fontStyle: "bold" } },
    });
  }

  // Participantes
  autoTable(doc, {
    ...estiloTabla,
    startY: titulo(`Participantes (${r.pagados} de ${r.total_personas} han pagado)`),
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
    styles: { ...estiloTabla.styles, fontSize: 8 },
    columnStyles: { 2: num, 3: num },
    didParseCell: (h) => {
      if (h.section === "body" && h.row.raw && (h.row.raw as string[])[4] === "Pendiente") {
        h.cell.styles.textColor = [185, 28, 28];
      }
    },
  });

  if (d.gastos.length > 0) {
    autoTable(doc, {
      ...estiloTabla,
      startY: titulo("Gastos del regalo"),
      head: [["Fecha", "Concepto", "Pagado por", "Importe"]],
      body: d.gastos.map((g) => [fmtFecha(g.fecha), g.concepto, g.cobrador ?? "", eur(g.importe)]),
      foot: [["", "", "Total gastado", eur(r.gastado)]],
      showFoot: "lastPage",
      footStyles: { fillColor: [239, 244, 255], textColor: [30, 41, 59], fontStyle: "bold" },
      columnStyles: { 3: num },
      didParseCell: (h) => {
        if (h.section === "foot" && (h.column.index === 2 || h.column.index === 3)) h.cell.styles.halign = "right";
      },
    });
  }

  // Gastos más caros
  if (d.gastos.length >= 2) {
    const top = [...d.gastos].sort((x, y) => y.importe - x.importe).slice(0, 5);
    autoTable(doc, {
      ...estiloTabla,
      startY: titulo("Gastos más caros"),
      head: [["#", "Concepto", "Importe", "% del gasto"]],
      body: top.map((g, i) => [
        String(i + 1),
        g.concepto,
        eur(g.importe),
        r.gastado > 0 ? `${Math.round((g.importe / r.gastado) * 100)} %` : "-",
      ]),
      columnStyles: { 0: { cellWidth: 10 }, 2: num, 3: num },
      didParseCell: (h) => {
        if (h.column.index >= 2) h.cell.styles.halign = "right";
      },
    });
  }

  // Resumen del regalo (aparte de la lista de gastos)
  autoTable(doc, {
    ...estiloTabla,
    startY: titulo("Resumen del regalo"),
    head: [["Concepto", "Importe"]],
    body: [
      ["Total recaudado", eur(r.cobrado_regalo)],
      ...(r.aportes_regalo > 0 ? [["+ Dinero extra añadido (sobrante)", eur(r.aportes_regalo)]] : []),
      ["- Total gastado", eur(r.gastado)],
      ...(r.homenajeados > 0
        ? [[`- Comida de homenajeados (${r.homenajeados})${r.comida_cubierta > 0 ? ", tras dinero extra de la comida" : ""}`, eur(r.comida_homenajeados - r.comida_cubierta)]]
        : []),
    ],
    foot: [
      [r.disponible_regalo < 0 ? "= Gastado de más" : "= Disponible para el regalo", eur(Math.abs(r.disponible_regalo))],
      ...(r.pendiente_regalo > 0
        ? [[`Previsto si pagan todos (faltan ${eur(r.pendiente_regalo)} por cobrar)`, eur(r.disponible_regalo + r.pendiente_regalo)]]
        : []),
    ],
    showFoot: "lastPage",
    footStyles: { fillColor: [239, 244, 255], textColor: r.disponible_regalo < 0 ? [185, 28, 28] : [21, 128, 61], fontStyle: "bold" },
    columnStyles: { 1: num },
    tableWidth: 120,
    didParseCell: (h) => {
      if (h.section === "foot" && h.column.index === 1) h.cell.styles.halign = "right";
      if (h.section === "foot" && h.row.index === 1) {
        h.cell.styles.fontStyle = "normal";
        h.cell.styles.textColor = [71, 85, 105];
      }
    },
  });

  if (d.traspasos.length > 0) {
    autoTable(doc, {
      ...estiloTabla,
      startY: titulo("Traspasos entre cobradores"),
      head: [["Fecha", "Entrega", "Recibe", "Importe", "Nota"]],
      body: d.traspasos.map((t) => [fmtFecha(t.fecha), t.de ?? "", t.a ?? "", eur(t.importe), t.nota]),
      columnStyles: { 3: num },
    });
  }

  // Pie con número de página
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRIS);
    doc.text(c.evento || "Comida de celebración", m, 290);
    doc.text(`Página ${i} de ${n}`, ancho - m, 290, { align: "right" });
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
