export interface Config {
  evento: string;
  fecha: string;
  regalo_desc: string;
  precio_comida: number; // céntimos
  precio_regalo: number; // céntimos
}

export interface Participante {
  id: number | null;
  nombre: string;
  comida: boolean;
  pagado: boolean;
  fecha_pago: string | null;
  notas: string;
  importe_regalo: number | null; // céntimos, null = precio por defecto
  debe: number; // céntimos
  cobrador_id: number | null;
  cobrador: string | null;
  metodo: string | null; // "efectivo" | "bizum"
  menu_id: number | null;
  menu: string | null;
  /** No paga; va a la comida y su comida sale del fondo del regalo */
  homenajeado: boolean;
}

export interface Menu {
  id: number;
  nombre: string;
  personas: number;
}

export interface Cobrador {
  id: number; // 0 = pagos sin cobrador asignado
  nombre: string;
  cobros: number;
  total: number; // céntimos
  efectivo: number;
  bizum: number;
  gastos: number;
  gastado: number;
  traspasos: number;
  recibido: number;
  entregado: number;
  /** Lo que debería tener ahora: cobrado − gastado + recibido − entregado */
  saldo: number;
}

/** Gasto del regalo pagado por un cobrador */
export interface Gasto {
  id: number | null;
  concepto: string;
  importe: number; // céntimos
  fecha: string; // AAAA-MM-DD
  cobrador_id: number | null;
  cobrador: string | null;
}

/** Dinero que un cobrador entrega a otro */
export interface Traspaso {
  id: number | null;
  fecha: string; // AAAA-MM-DD
  de_id: number;
  de: string | null;
  a_id: number;
  a: string | null;
  importe: number; // céntimos
  nota: string;
}

export interface Resumen {
  aportes_regalo: number;
  aportes_comida: number;
  homenajeados: number;
  /** Coste de la comida de los homenajeados (céntimos), a cargo del fondo del regalo */
  comida_homenajeados: number;
  total_personas: number;
  con_comida: number;
  solo_regalo: number;
  pagados: number;
  pendientes: number;
  total_comida: number;
  total_regalo: number;
  total_esperado: number;
  cobrado: number;
  cobrado_comida: number;
  cobrado_regalo: number;
  pendiente: number;
  pendiente_comida: number;
  pendiente_regalo: number;
  cobrado_efectivo: number;
  cobrado_bizum: number;
  gastos: number;
  gastado: number;
  /** cobrado_regalo − gastado */
  disponible_regalo: number;
  traspasos: number;
  traspasado: number;
}

export interface Datos {
  config: Config;
  participantes: Participante[];
  resumen: Resumen;
  cobradores: Cobrador[];
  gastos: Gasto[];
  traspasos: Traspaso[];
  menus: Menu[];
  aportes: Aporte[];
}

export interface Aporte {
  id: number | null;
  concepto: string;
  importe: number; // céntimos
  fecha: string;
  destino: "regalo" | "comida";
}

export interface Estado {
  tiene_password: boolean;
  desbloqueado: boolean;
}

export const eur = (cents: number): string =>
  (cents / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" });

/** Convierte "12,50" o "12.5" a céntimos. Devuelve null si está vacío o es inválido. */
export const aCentimos = (txt: string): number | null => {
  const t = txt.trim().replace(",", ".");
  if (t === "") return null;
  const n = parseFloat(t);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
};

export const deCentimos = (c: number | null): string =>
  c === null ? "" : (c / 100).toFixed(2).replace(".", ",");

/** "2026-11-08" → "08/11/2026" (deja intacto cualquier otro formato). */
export const fmtFecha = (f: string | null): string => {
  if (!f) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : f;
};

/** Fecha de hoy en formato AAAA-MM-DD (hora local). */
export const hoy = (): string => new Date().toLocaleDateString("sv-SE");

/** Minúsculas y sin tildes, para buscar «jose» y encontrar «José». */
export const normalizar = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// ─── Uso en varios equipos ───

export interface InfoDb {
  ruta: string;
  /** "exe": junto al programa · "ini": celebracion.ini · "evento": elegido en Eventos */
  origen: "exe" | "ini" | "evento";
  conectado: boolean;
  error: string | null;
  /** Hay eventos pero ninguno abierto: hay que elegir uno */
  sin_evento: boolean;
}

/** Datos locales de una versión anterior que se pueden importar */
export interface Migracion {
  ruta: string;
  personas: number;
  pagados: number;
}

export interface Conectado {
  equipo: string;
  usuario: string;
  yo: boolean;
}

export interface Sondeo {
  version: number;
  conectados: Conectado[];
}

/** Un evento (archivo de base de datos) de los que se pueden abrir. */
export interface EventoInfo {
  nombre: string;
  archivo: string;
  ruta: string;
  actual: boolean;
  principal: boolean;
  personas: number;
  pagados: number;
  error: string | null;
}
