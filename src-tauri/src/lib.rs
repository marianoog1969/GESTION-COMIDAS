use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

type Res<T> = Result<T, String>;

/// Traduce los errores de SQLite más habituales en red a mensajes comprensibles.
fn e<E: std::fmt::Display>(x: E) -> String {
    let m = x.to_string();
    let l = m.to_lowercase();
    if l.contains("database is locked") || l.contains("database table is locked") || l.contains("busy") {
        "Otro equipo está guardando en este momento. Vuelve a intentarlo en unos segundos.".into()
    } else if l.contains("disk i/o") || l.contains("unable to open database") || l.contains("cannot open") {
        "No hay acceso a la base de datos. Comprueba la conexión de red o la carpeta compartida.".into()
    } else if l.contains("readonly database") || l.contains("read-only") {
        "No tienes permiso de escritura en la carpeta de la base de datos.".into()
    } else if l.contains("malformed") || l.contains("not a database") {
        "El archivo no es una base de datos válida o está dañado.".into()
    } else {
        m
    }
}

/// Cada cuánto se anuncia este equipo como conectado, y cuándo se da por desconectado otro.
const LATIDO: Duration = Duration::from_secs(30);
const CADUCIDAD_PRESENCIA: i64 = 95;

struct AppState {
    /// None = sin conexión (p. ej. la carpeta compartida no está disponible)
    db: Mutex<Option<Connection>>,
    /// Base de datos compartida: junto al .exe o la indicada en celebracion.ini
    ruta: PathBuf,
    /// "exe" o "ini": de dónde sale la ruta
    origen: &'static str,
    /// Base local de versiones anteriores (una por equipo), para ofrecer importarla
    ruta_antigua: PathBuf,
    /// Base de datos «principal» (la de siempre: junto al .exe o la de celebracion.ini)
    principal: PathBuf,
    /// Carpeta donde viven los demás eventos (una subcarpeta «Eventos» junto a la principal)
    dir_eventos: PathBuf,
    /// Datos locales de este equipo (último evento abierto)
    local_dir: PathBuf,
    admin: Mutex<bool>,
    ultimo_latido: Mutex<Option<Instant>>,
    error_conexion: Mutex<Option<String>>,
    /// Verdadero mientras se mueve la base principal: no se debe reconectar ni crear otra
    moviendo: std::sync::atomic::AtomicBool,
    /// No hay base abierta: hay eventos en «Eventos» y el usuario debe elegir uno
    sin_evento: bool,
    /// Primer arranque sin nada: se creó el primer evento en «Eventos»
    primer_inicio: bool,
}

fn con<'a>(g: &'a MutexGuard<Option<Connection>>) -> Res<&'a Connection> {
    g.as_ref().ok_or_else(|| {
        "Sin conexión con la base de datos. Comprueba la red o elige otra ubicación.".to_string()
    })
}

/// Transacción que reserva la escritura desde el principio: evita que dos equipos
/// lean el mismo estado y escriban a la vez.
fn tx_escritura(c: &Connection) -> Res<Transaction<'_>> {
    Transaction::new_unchecked(c, TransactionBehavior::Immediate).map_err(e)
}

fn segundos() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn identidad() -> (String, String) {
    let equipo = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "equipo".into());
    let usuario = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    (equipo, usuario)
}

// ───────────────────────── Modelos (importes en céntimos) ─────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct Config {
    evento: String,
    fecha: String,
    regalo_desc: String,
    precio_comida: i64,
    precio_regalo: i64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Participante {
    id: Option<i64>,
    nombre: String,
    comida: bool,
    #[serde(default)]
    pagado: bool,
    #[serde(default)]
    fecha_pago: Option<String>,
    #[serde(default)]
    notas: String,
    /// En desuso: el regalo es un importe fijo igual para todos (se conserva por compatibilidad)
    #[serde(default)]
    importe_regalo: Option<i64>,
    /// Calculado: lo que debe pagar esta persona
    #[serde(default)]
    debe: i64,
    /// Quién ha cobrado el dinero (solo si ha pagado)
    #[serde(default)]
    cobrador_id: Option<i64>,
    #[serde(default)]
    cobrador: Option<String>,
    /// "efectivo" o "bizum" (solo si ha pagado)
    #[serde(default)]
    metodo: Option<String>,
    /// Tipo de menú elegido (solo si tiene comida)
    #[serde(default)]
    menu_id: Option<i64>,
    #[serde(default)]
    menu: Option<String>,
    /// Homenajeado/a: va a la comida pero no paga (su comida sale del fondo del regalo)
    #[serde(default)]
    homenajeado: bool,
}

/// Tipo de menú configurable (solo nombre, sin precio).
#[derive(Serialize, Clone)]
struct Menu {
    id: i64,
    nombre: String,
    /// Personas que lo han elegido
    personas: i64,
}

/// Gasto del regalo pagado por un cobrador con el dinero recogido.
#[derive(Serialize, Deserialize, Clone)]
struct Gasto {
    id: Option<i64>,
    concepto: String,
    /// Céntimos
    importe: i64,
    /// AAAA-MM-DD
    fecha: String,
    cobrador_id: Option<i64>,
    #[serde(default)]
    cobrador: Option<String>,
}

/// Dinero que un cobrador entrega a otro. No cambia el total, solo quién lo tiene.
#[derive(Serialize, Deserialize, Clone)]
struct Traspaso {
    id: Option<i64>,
    /// AAAA-MM-DD
    fecha: String,
    de_id: i64,
    #[serde(default)]
    de: Option<String>,
    a_id: i64,
    #[serde(default)]
    a: Option<String>,
    /// Céntimos
    importe: i64,
    #[serde(default)]
    nota: String,
}

#[derive(Serialize)]
struct CobradorResumen {
    /// 0 = movimientos sin cobrador asignado
    id: i64,
    nombre: String,
    cobros: i64,
    total: i64,
    efectivo: i64,
    bizum: i64,
    /// Gastos del regalo pagados por este cobrador
    gastos: i64,
    gastado: i64,
    /// Traspasos en los que participa
    traspasos: i64,
    recibido: i64,
    entregado: i64,
    /// Lo que debería tener ahora: cobrado − gastado + recibido − entregado
    saldo: i64,
}

#[derive(Serialize, Default)]
struct Resumen {
    total_personas: i64,
    con_comida: i64,
    solo_regalo: i64,
    pagados: i64,
    pendientes: i64,
    total_comida: i64,
    total_regalo: i64,
    total_esperado: i64,
    cobrado: i64,
    cobrado_comida: i64,
    cobrado_regalo: i64,
    pendiente: i64,
    pendiente_comida: i64,
    pendiente_regalo: i64,
    cobrado_efectivo: i64,
    cobrado_bizum: i64,
    /// Homenajeados (no pagan) y lo que cuesta su comida, que sale del fondo del regalo
    homenajeados: i64,
    comida_homenajeados: i64,
    /// Dinero extra (p. ej. sobrante de otros años) añadido al regalo o a la comida
    aportes_regalo: i64,
    aportes_comida: i64,
    /// Parte de la comida de los homenajeados cubierta con ese dinero de la comida
    comida_cubierta: i64,
    /// Dinero de la comida que sobra tras cubrir a los homenajeados
    sobrante_comida: i64,
    /// Gastos del regalo
    gastos: i64,
    gastado: i64,
    /// cobrado_regalo + aportes_regalo − gastado − comida de los homenajeados
    disponible_regalo: i64,
    /// Traspasos entre cobradores (no cambian el total)
    traspasos: i64,
    traspasado: i64,
}

#[derive(Serialize)]
struct Datos {
    config: Config,
    participantes: Vec<Participante>,
    resumen: Resumen,
    cobradores: Vec<CobradorResumen>,
    gastos: Vec<Gasto>,
    traspasos: Vec<Traspaso>,
    menus: Vec<Menu>,
    aportes: Vec<Aporte>,
}

#[derive(Serialize)]
struct Estado {
    tiene_password: bool,
    desbloqueado: bool,
}

// ───────────────────────── Base de datos ─────────────────────────

fn init_db(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS participantes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            comida INTEGER NOT NULL DEFAULT 0,
            pagado INTEGER NOT NULL DEFAULT 0,
            fecha_pago TEXT,
            notas TEXT NOT NULL DEFAULT '',
            importe_regalo INTEGER
         );
         CREATE TABLE IF NOT EXISTS cobradores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS menus (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS gastos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            concepto TEXT NOT NULL,
            importe INTEGER NOT NULL,
            fecha TEXT NOT NULL,
            cobrador_id INTEGER,
            metodo TEXT
         );
         CREATE TABLE IF NOT EXISTS aportes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            concepto TEXT NOT NULL,
            importe INTEGER NOT NULL,
            fecha TEXT NOT NULL,
            destino TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS traspasos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TEXT NOT NULL,
            de_id INTEGER NOT NULL,
            a_id INTEGER NOT NULL,
            importe INTEGER NOT NULL,
            nota TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE IF NOT EXISTS presencia (
            clave TEXT PRIMARY KEY,
            equipo TEXT NOT NULL,
            usuario TEXT NOT NULL,
            visto INTEGER NOT NULL
         );",
    )?;
    // Migración: columnas nuevas en bases de datos anteriores
    let mut columnas: Vec<String> = Vec::new();
    {
        let mut st = c.prepare("PRAGMA table_info(participantes)")?;
        let nombres = st.query_map([], |r| r.get::<_, String>(1))?;
        for n in nombres {
            columnas.push(n?);
        }
    }
    for (col, tipo) in [("cobrador_id", "INTEGER"), ("metodo_pago", "TEXT"), ("menu_id", "INTEGER"), ("homenajeado", "INTEGER NOT NULL DEFAULT 0")] {
        if !columnas.iter().any(|x| x == col) {
            c.execute(
                &format!("ALTER TABLE participantes ADD COLUMN {} {}", col, tipo),
                [],
            )?;
        }
    }
    Ok(())
}

/// Abre (o crea, si `crear`) la base de datos con ajustes seguros para carpetas de red:
/// diario clásico (WAL no funciona en red), espera si otro equipo está escribiendo
/// y escritura síncrona completa.
fn abrir_db(ruta: &Path, crear: bool) -> Res<Connection> {
    if !crear && !ruta.is_file() {
        return Err(format!("No se encuentra el archivo {}", ruta.display()));
    }
    let c = Connection::open(ruta).map_err(e)?;
    c.busy_timeout(Duration::from_secs(8)).map_err(e)?;
    // Comprobar que es una base de datos de esta aplicación (o una vacía)
    let tablas: Vec<String> = {
        let mut st = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .map_err(e)?;
        let filas = st.query_map([], |r| r.get::<_, String>(0)).map_err(e)?;
        filas.collect::<Result<_, _>>().map_err(e)?
    };
    let propias = ["config", "participantes", "cobradores", "gastos", "traspasos", "menus", "aportes", "presencia", "sqlite_sequence"];
    if !tablas.is_empty() && !tablas.iter().any(|t| t == "participantes") {
        return Err("Ese archivo no es una base de datos de Celebración".into());
    }
    if tablas.iter().any(|t| !propias.contains(&t.as_str())) {
        return Err("Ese archivo contiene tablas desconocidas: no parece de Celebración".into());
    }
    let _modo: String = c
        .query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))
        .map_err(e)?;
    c.execute_batch("PRAGMA synchronous=FULL;").map_err(e)?;
    {
        let tx = tx_escritura(&c)?;
        init_db(&tx).map_err(e)?;
        tx.commit().map_err(e)?;
    }
    Ok(c)
}

fn get_key(c: &Connection, k: &str) -> Option<String> {
    c.query_row("SELECT value FROM config WHERE key=?1", params![k], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
}

fn set_key(c: &Connection, k: &str, v: &str) -> Res<()> {
    c.execute(
        "INSERT INTO config(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![k, v],
    )
    .map_err(e)?;
    Ok(())
}

fn leer_config(c: &Connection) -> Config {
    Config {
        evento: get_key(c, "evento").unwrap_or_else(|| "Comida de celebración".into()),
        fecha: get_key(c, "fecha").unwrap_or_default(),
        regalo_desc: get_key(c, "regalo_desc").unwrap_or_default(),
        precio_comida: get_key(c, "precio_comida")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        precio_regalo: get_key(c, "precio_regalo")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
    }
}

/// Regalo de esta persona: el suyo propio si se ha fijado, o el precio general.
fn regalo_de(p: &Participante, cfg: &Config) -> i64 {
    p.importe_regalo.unwrap_or(cfg.precio_regalo)
}

fn debe_de(p: &Participante, cfg: &Config) -> i64 {
    if p.homenajeado {
        return 0;
    }
    let regalo = regalo_de(p, cfg);
    regalo + if p.comida { cfg.precio_comida } else { 0 }
}

fn leer_participantes(c: &Connection, cfg: &Config) -> Res<Vec<Participante>> {
    let mut st = c
        .prepare(
            "SELECT p.id,p.nombre,p.comida,p.pagado,p.fecha_pago,p.notas,p.importe_regalo,
                    p.cobrador_id,c.nombre,p.metodo_pago,p.menu_id,m.nombre,p.homenajeado
             FROM participantes p LEFT JOIN cobradores c ON c.id=p.cobrador_id
                                  LEFT JOIN menus m ON m.id=p.menu_id
             ORDER BY p.nombre COLLATE NOCASE",
        )
        .map_err(e)?;
    let rows = st
        .query_map([], |r| {
            Ok(Participante {
                id: Some(r.get(0)?),
                nombre: r.get(1)?,
                comida: r.get::<_, i64>(2)? != 0,
                pagado: r.get::<_, i64>(3)? != 0,
                fecha_pago: r.get(4)?,
                notas: r.get(5)?,
                importe_regalo: r.get(6)?,
                debe: 0,
                cobrador_id: r.get(7)?,
                cobrador: r.get(8)?,
                metodo: r.get(9)?,
                menu_id: r.get(10)?,
                menu: r.get(11)?,
                homenajeado: r.get::<_, i64>(12)? != 0,
            })
        })
        .map_err(e)?;
    let mut v = rows.collect::<Result<Vec<_>, _>>().map_err(e)?;
    for p in v.iter_mut() {
        p.debe = debe_de(p, cfg);
    }
    Ok(v)
}

fn calcular_resumen(ps: &[Participante], cfg: &Config) -> Resumen {
    let mut r = Resumen::default();
    for p in ps {
        if p.homenajeado {
            // Va a la comida pero no paga: ni cobrado ni pendiente
            r.total_personas += 1;
            r.con_comida += 1;
            r.homenajeados += 1;
            r.comida_homenajeados += cfg.precio_comida;
            continue;
        }
        let regalo = regalo_de(p, cfg);
        let comida = if p.comida { cfg.precio_comida } else { 0 };
        r.total_personas += 1;
        if p.comida {
            r.con_comida += 1;
        } else {
            r.solo_regalo += 1;
        }
        r.total_regalo += regalo;
        r.total_comida += comida;
        if p.pagado {
            r.pagados += 1;
            r.cobrado_regalo += regalo;
            r.cobrado_comida += comida;
            match p.metodo.as_deref() {
                Some("efectivo") => r.cobrado_efectivo += regalo + comida,
                Some("bizum") => r.cobrado_bizum += regalo + comida,
                _ => {}
            }
        } else {
            r.pendientes += 1;
            r.pendiente_regalo += regalo;
            r.pendiente_comida += comida;
        }
    }
    r.total_esperado = r.total_comida + r.total_regalo;
    r.cobrado = r.cobrado_comida + r.cobrado_regalo;
    r.pendiente = r.pendiente_comida + r.pendiente_regalo;
    r
}

#[derive(Serialize, Deserialize, Clone)]
struct Aporte {
    id: Option<i64>,
    concepto: String,
    importe: i64,
    fecha: String,
    /// "regalo" o "comida"
    destino: String,
}

fn leer_aportes(c: &Connection) -> Res<Vec<Aporte>> {
    let mut st = c
        .prepare("SELECT id,concepto,importe,fecha,destino FROM aportes ORDER BY fecha DESC, id DESC")
        .map_err(e)?;
    let filas = st
        .query_map([], |r| {
            Ok(Aporte {
                id: Some(r.get(0)?),
                concepto: r.get(1)?,
                importe: r.get(2)?,
                fecha: r.get(3)?,
                destino: r.get(4)?,
            })
        })
        .map_err(e)?;
    filas.collect::<Result<_, _>>().map_err(e)
}

fn aplicar_aportes(r: &mut Resumen, ap: &[Aporte]) {
    r.aportes_regalo = ap.iter().filter(|a| a.destino == "regalo").map(|a| a.importe).sum();
    r.aportes_comida = ap.iter().filter(|a| a.destino == "comida").map(|a| a.importe).sum();
    r.comida_cubierta = r.aportes_comida.min(r.comida_homenajeados);
    r.sobrante_comida = r.aportes_comida - r.comida_cubierta;
    r.disponible_regalo += r.aportes_regalo + r.comida_cubierta;
}

#[tauri::command(async)]
fn guardar_aporte(s: State<AppState>, aporte: Aporte) -> Res<()> {
    let concepto = aporte.concepto.trim().to_string();
    if concepto.is_empty() {
        return Err("Indica de dónde viene el dinero (concepto)".into());
    }
    if aporte.importe <= 0 {
        return Err("El importe debe ser mayor que 0".into());
    }
    if aporte.destino != "regalo" && aporte.destino != "comida" {
        return Err("El destino debe ser regalo o comida".into());
    }
    let g = s.db.lock().map_err(e)?;
    con(&g)?
        .execute(
            "INSERT INTO aportes(concepto,importe,fecha,destino) VALUES(?1,?2,?3,?4)",
            params![concepto, aporte.importe, aporte.fecha, aporte.destino],
        )
        .map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn eliminar_aporte(s: State<AppState>, id: i64) -> Res<()> {
    let g = s.db.lock().map_err(e)?;
    con(&g)?.execute("DELETE FROM aportes WHERE id=?1", params![id]).map_err(e)?;
    Ok(())
}

fn leer_gastos(c: &Connection) -> Res<Vec<Gasto>> {
    let mut st = c
        .prepare(
            "SELECT g.id, g.concepto, g.importe, g.fecha, g.cobrador_id, c.nombre
             FROM gastos g LEFT JOIN cobradores c ON c.id = g.cobrador_id
             ORDER BY g.fecha DESC, g.id DESC",
        )
        .map_err(e)?;
    let filas = st
        .query_map([], |r| {
            Ok(Gasto {
                id: r.get(0)?,
                concepto: r.get(1)?,
                importe: r.get(2)?,
                fecha: r.get(3)?,
                cobrador_id: r.get(4)?,
                cobrador: r.get(5)?,
            })
        })
        .map_err(e)?;
    filas.collect::<Result<_, _>>().map_err(e)
}

fn leer_traspasos(c: &Connection) -> Res<Vec<Traspaso>> {
    let mut st = c
        .prepare(
            "SELECT t.id, t.fecha, t.de_id, d.nombre, t.a_id, a.nombre, t.importe, t.nota
             FROM traspasos t
             LEFT JOIN cobradores d ON d.id = t.de_id
             LEFT JOIN cobradores a ON a.id = t.a_id
             ORDER BY t.fecha DESC, t.id DESC",
        )
        .map_err(e)?;
    let filas = st
        .query_map([], |r| {
            Ok(Traspaso {
                id: r.get(0)?,
                fecha: r.get(1)?,
                de_id: r.get(2)?,
                de: r.get(3)?,
                a_id: r.get(4)?,
                a: r.get(5)?,
                importe: r.get(6)?,
                nota: r.get(7)?,
            })
        })
        .map_err(e)?;
    filas.collect::<Result<_, _>>().map_err(e)
}

fn aplicar_movimientos(r: &mut Resumen, gs: &[Gasto], ts: &[Traspaso]) {
    r.gastos = gs.len() as i64;
    r.gastado = gs.iter().map(|g| g.importe).sum();
    r.disponible_regalo = r.cobrado_regalo - r.gastado - r.comida_homenajeados;
    r.traspasos = ts.len() as i64;
    r.traspasado = ts.iter().map(|t| t.importe).sum();
}

fn calcular_cobradores(
    c: &Connection,
    ps: &[Participante],
    gs: &[Gasto],
    ts: &[Traspaso],
) -> Res<Vec<CobradorResumen>> {
    let mut st = c
        .prepare("SELECT id,nombre FROM cobradores ORDER BY nombre COLLATE NOCASE")
        .map_err(e)?;
    let filas = st
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(e)?;
    let mut v: Vec<CobradorResumen> = Vec::new();
    for f in filas {
        let (id, nombre) = f.map_err(e)?;
        v.push(resumen_de(id, nombre, ps, gs, ts, Some(id)));
    }
    // Movimientos sin cobrador (p. ej. marcados antes de definir cobradores)
    if !v.is_empty() {
        let r = resumen_de(0, "Sin asignar".into(), ps, gs, ts, None);
        if r.cobros > 0 || r.gastos > 0 {
            v.push(r);
        }
    }
    Ok(v)
}

fn resumen_de(
    id: i64,
    nombre: String,
    ps: &[Participante],
    gs: &[Gasto],
    ts: &[Traspaso],
    quien: Option<i64>,
) -> CobradorResumen {
    let mut r = CobradorResumen {
        id,
        nombre,
        cobros: 0,
        total: 0,
        efectivo: 0,
        bizum: 0,
        gastos: 0,
        gastado: 0,
        traspasos: 0,
        recibido: 0,
        entregado: 0,
        saldo: 0,
    };
    for g in gs.iter().filter(|g| g.cobrador_id == quien) {
        r.gastos += 1;
        r.gastado += g.importe;
    }
    if let Some(yo) = quien {
        for t in ts {
            if t.de_id == yo {
                r.traspasos += 1;
                r.entregado += t.importe;
            }
            if t.a_id == yo {
                r.traspasos += 1;
                r.recibido += t.importe;
            }
        }
    }
    let filtro = |p: &Participante| p.cobrador_id == quien;
    for p in ps.iter().filter(|p| p.pagado && filtro(p)) {
        r.cobros += 1;
        r.total += p.debe;
        match p.metodo.as_deref() {
            Some("efectivo") => r.efectivo += p.debe,
            Some("bizum") => r.bizum += p.debe,
            _ => {}
        }
    }
    r.saldo = r.total - r.gastado + r.recibido - r.entregado;
    r
}

// ───────────────────────── Contraseña ─────────────────────────

fn nueva_sal() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", n, std::process::id())
}

fn hash_pw(sal: &str, pw: &str) -> String {
    let mut h = Sha256::new();
    h.update(sal.as_bytes());
    h.update(pw.as_bytes());
    format!("{:x}", h.finalize())
}

fn guardar_pw(c: &Connection, pw: &str) -> Res<()> {
    let sal = nueva_sal();
    let h = hash_pw(&sal, pw);
    set_key(c, "password", &format!("{}${}", sal, h))
}

fn verificar_pw(c: &Connection, pw: &str) -> bool {
    match get_key(c, "password") {
        Some(s) => match s.split_once('$') {
            Some((sal, h)) => hash_pw(sal, pw) == h,
            None => false,
        },
        None => false,
    }
}

fn exigir_admin(s: &State<AppState>) -> Res<()> {
    if *s.admin.lock().map_err(e)? {
        Ok(())
    } else {
        Err("Se requiere la contraseña de administrador".into())
    }
}

// ───────────────────────── Comandos ─────────────────────────

#[tauri::command(async)]
fn estado(s: State<AppState>) -> Res<Estado> {
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    let admin = *s.admin.lock().map_err(e)?;
    Ok(Estado {
        tiene_password: get_key(db, "password").is_some(),
        desbloqueado: admin,
    })
}

#[tauri::command(async)]
fn crear_password(s: State<AppState>, password: String) -> Res<()> {
    if password.chars().count() < 4 {
        return Err("La contraseña debe tener al menos 4 caracteres".into());
    }
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    let tx = tx_escritura(db)?;
    if get_key(&tx, "password").is_some() {
        return Err("Ya existe una contraseña (quizá la ha creado otro equipo)".into());
    }
    guardar_pw(&tx, &password)?;
    tx.commit().map_err(e)?;
    *s.admin.lock().map_err(e)? = true;
    Ok(())
}

#[tauri::command(async)]
fn desbloquear(s: State<AppState>, password: String) -> Res<bool> {
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    let ok = verificar_pw(db, &password);
    *s.admin.lock().map_err(e)? = ok;
    Ok(ok)
}

#[tauri::command(async)]
fn bloquear(s: State<AppState>) -> Res<()> {
    *s.admin.lock().map_err(e)? = false;
    Ok(())
}

#[tauri::command(async)]
fn cambiar_password(s: State<AppState>, actual: String, nueva: String) -> Res<()> {
    exigir_admin(&s)?;
    if nueva.chars().count() < 4 {
        return Err("La contraseña debe tener al menos 4 caracteres".into());
    }
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    if !verificar_pw(db, &actual) {
        return Err("La contraseña actual no es correcta".into());
    }
    guardar_pw(db, &nueva)
}

#[tauri::command(async)]
fn cargar(s: State<AppState>) -> Res<Datos> {
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    // Una sola transacción de lectura: todo sale del mismo instante aunque otro equipo esté escribiendo
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Deferred).map_err(e)?;
    let config = leer_config(&tx);
    let participantes = leer_participantes(&tx, &config)?;
    let gastos = leer_gastos(&tx)?;
    let traspasos = leer_traspasos(&tx)?;
    let menus = leer_menus(&tx)?;
    let mut resumen = calcular_resumen(&participantes, &config);
    aplicar_movimientos(&mut resumen, &gastos, &traspasos);
    let aportes = leer_aportes(&tx)?;
    aplicar_aportes(&mut resumen, &aportes);
    let cobradores = calcular_cobradores(&tx, &participantes, &gastos, &traspasos)?;
    tx.commit().map_err(e)?;
    Ok(Datos {
        config,
        participantes,
        resumen,
        cobradores,
        gastos,
        traspasos,
        menus,
        aportes,
    })
}

fn leer_menus(c: &Connection) -> Res<Vec<Menu>> {
    let mut st = c
        .prepare(
            "SELECT m.id,m.nombre,
                    (SELECT COUNT(*) FROM participantes p WHERE p.menu_id=m.id AND p.comida=1)
             FROM menus m ORDER BY m.nombre COLLATE NOCASE",
        )
        .map_err(e)?;
    let v = st
        .query_map([], |r| {
            Ok(Menu {
                id: r.get(0)?,
                nombre: r.get(1)?,
                personas: r.get(2)?,
            })
        })
        .map_err(e)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e)?;
    Ok(v)
}

#[tauri::command(async)]
fn guardar_menu(s: State<AppState>, nombre: String) -> Res<()> {
    exigir_admin(&s)?;
    let nombre = nombre.trim().to_string();
    if nombre.is_empty() {
        return Err("El nombre del menú es obligatorio".into());
    }
    let g = s.db.lock().map_err(e)?;
    let db = tx_escritura(con(&g)?)?;
    let existe: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM menus WHERE nombre=?1 COLLATE NOCASE",
            params![nombre],
            |r| r.get(0),
        )
        .map_err(e)?;
    if existe > 0 {
        return Err("Ya existe un menú con ese nombre".into());
    }
    db.execute("INSERT INTO menus(nombre) VALUES(?1)", params![nombre])
        .map_err(e)?;
    db.commit().map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn eliminar_menu(s: State<AppState>, id: i64) -> Res<()> {
    exigir_admin(&s)?;
    let g = s.db.lock().map_err(e)?;
    let db = tx_escritura(con(&g)?)?;
    let n: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM participantes WHERE menu_id=?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(e)?;
    if n > 0 {
        return Err(format!(
            "No se puede eliminar: {} persona(s) tienen este menú. Cámbiales el menú primero.",
            n
        ));
    }
    db.execute("DELETE FROM menus WHERE id=?1", params![id])
        .map_err(e)?;
    db.commit().map_err(e)?;
    Ok(())
}

/// Comprueba que el menú existe (otro equipo pudo eliminarlo). None = sin menú.
fn menu_valido(c: &Connection, menu_id: Option<i64>) -> Res<Option<i64>> {
    match menu_id {
        Some(m) => {
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM menus WHERE id=?1", params![m], |r| r.get(0))
                .map_err(e)?;
            if n == 0 {
                Err("Ese menú ya no existe (lo ha eliminado otro equipo)".into())
            } else {
                Ok(Some(m))
            }
        }
        None => Ok(None),
    }
}

#[tauri::command(async)]
fn guardar_cobrador(s: State<AppState>, nombre: String) -> Res<()> {
    exigir_admin(&s)?;
    let nombre = nombre.trim().to_string();
    if nombre.is_empty() {
        return Err("El nombre del cobrador es obligatorio".into());
    }
    let g = s.db.lock().map_err(e)?;
    let db = tx_escritura(con(&g)?)?;
    let existe: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM cobradores WHERE nombre=?1 COLLATE NOCASE",
            params![nombre],
            |r| r.get(0),
        )
        .map_err(e)?;
    if existe > 0 {
        return Err("Ya existe un cobrador con ese nombre".into());
    }
    db.execute("INSERT INTO cobradores(nombre) VALUES(?1)", params![nombre])
        .map_err(e)?;
    db.commit().map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn eliminar_cobrador(s: State<AppState>, id: i64) -> Res<()> {
    exigir_admin(&s)?;
    let g = s.db.lock().map_err(e)?;
    let db = tx_escritura(con(&g)?)?;
    let (n, ng, nt): (i64, i64, i64) = db
        .query_row(
            "SELECT (SELECT COUNT(*) FROM participantes WHERE cobrador_id=?1),
                    (SELECT COUNT(*) FROM gastos WHERE cobrador_id=?1),
                    (SELECT COUNT(*) FROM traspasos WHERE de_id=?1 OR a_id=?1)",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(e)?;
    if n > 0 || ng > 0 || nt > 0 {
        return Err(format!(
            "No se puede eliminar: tiene {} cobro(s), {} gasto(s) y {} traspaso(s) asignados. Reasígnalos primero.",
            n, ng, nt
        ));
    }
    db.execute("DELETE FROM cobradores WHERE id=?1", params![id])
        .map_err(e)?;
    db.commit().map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn guardar_config(s: State<AppState>, config: Config) -> Res<()> {
    exigir_admin(&s)?;
    if config.precio_comida < 0 || config.precio_regalo < 0 {
        return Err("Los precios no pueden ser negativos".into());
    }
    let g = s.db.lock().map_err(e)?;
    let tx = tx_escritura(con(&g)?)?;
    set_key(&tx, "evento", config.evento.trim())?;
    set_key(&tx, "fecha", config.fecha.trim())?;
    set_key(&tx, "regalo_desc", config.regalo_desc.trim())?;
    set_key(&tx, "precio_comida", &config.precio_comida.to_string())?;
    set_key(&tx, "precio_regalo", &config.precio_regalo.to_string())?;
    tx.commit().map_err(e)?;
    Ok(())
}

/// Alta de participante (con id = None). Por compatibilidad también actualiza la fila completa.
#[tauri::command(async)]
fn guardar_participante(s: State<AppState>, participante: Participante) -> Res<i64> {
    let nombre = participante.nombre.trim().to_string();
    if nombre.is_empty() {
        return Err("El nombre es obligatorio".into());
    }
    if let Some(i) = participante.importe_regalo {
        if i < 0 {
            return Err("El importe no puede ser negativo".into());
        }
    }
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    let comida = participante.comida || participante.homenajeado;
    let menu = if comida {
        menu_valido(db, participante.menu_id)?
    } else {
        None
    };
    match participante.id {
        Some(id) => {
            let n = db
                .execute(
                    "UPDATE participantes SET nombre=?1, comida=?2, notas=?3, importe_regalo=?4, menu_id=?6, homenajeado=?7 WHERE id=?5",
                    params![
                        nombre,
                        comida as i64,
                        participante.notas.trim(),
                        participante.importe_regalo,
                        id,
                        menu,
                        participante.homenajeado as i64
                    ],
                )
                .map_err(e)?;
            if n == 0 {
                return Err(NO_EXISTE.into());
            }
            Ok(id)
        }
        None => {
            db.execute(
                "INSERT INTO participantes(nombre,comida,notas,importe_regalo,menu_id,homenajeado) VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    nombre,
                    comida as i64,
                    participante.notas.trim(),
                    participante.importe_regalo,
                    menu,
                    participante.homenajeado as i64
                ],
            )
            .map_err(e)?;
            Ok(db.last_insert_rowid())
        }
    }
}

const NO_EXISTE: &str = "Esa persona ya no está en la lista (la ha eliminado otro equipo)";

/// Cambia solo los campos indicados, para no pisar lo que otro equipo
/// haya modificado a la vez en otros campos de la misma persona.
#[tauri::command(async)]
fn actualizar_participante(
    s: State<AppState>,
    id: i64,
    nombre: Option<String>,
    comida: Option<bool>,
    notas: Option<String>,
    // 0 = quitar el menú
    menu_id: Option<i64>,
    // Céntimos; -1 = volver al regalo general
    importe_regalo: Option<i64>,
    // Homenajeado/a: no paga; se quita cualquier cobro
    homenajeado: Option<bool>,
) -> Res<()> {
    let nombre = nombre.map(|n| n.trim().to_string());
    if nombre.as_deref() == Some("") {
        return Err("El nombre es obligatorio".into());
    }
    if matches!(importe_regalo, Some(i) if i < -1) {
        return Err("El importe no puede ser negativo".into());
    }
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    menu_valido(db, menu_id.filter(|m| *m > 0))?;
    let n = db
        .execute(
            "UPDATE participantes
             SET nombre=COALESCE(?2, nombre),
                 comida=CASE WHEN ?7=1 THEN 1 ELSE COALESCE(?3, comida) END,
                 homenajeado=COALESCE(?7, homenajeado),
                 pagado=CASE WHEN ?7=1 THEN 0 ELSE pagado END,
                 fecha_pago=CASE WHEN ?7=1 THEN NULL ELSE fecha_pago END,
                 cobrador_id=CASE WHEN ?7=1 THEN NULL ELSE cobrador_id END,
                 metodo_pago=CASE WHEN ?7=1 THEN NULL ELSE metodo_pago END,
                 notas=COALESCE(?4, notas),
                 menu_id=CASE WHEN ?3=0 THEN NULL
                              WHEN ?5 IS NULL THEN menu_id
                              WHEN ?5=0 THEN NULL
                              ELSE ?5 END,
                 importe_regalo=CASE WHEN ?6 IS NULL THEN importe_regalo
                                     WHEN ?6<0 THEN NULL
                                     ELSE ?6 END
             WHERE id=?1",
            params![
                id,
                nombre,
                comida.map(|c| c as i64),
                notas.map(|n| n.trim().to_string()),
                menu_id,
                importe_regalo,
                homenajeado.map(|h| h as i64)
            ],
        )
        .map_err(e)?;
    if n == 0 {
        return Err(NO_EXISTE.into());
    }
    Ok(())
}

/// `desde`: estado de pago que el usuario estaba viendo. Si otro equipo lo ha cambiado
/// mientras tanto, se rechaza para evitar cobrar dos veces a la misma persona.
#[tauri::command(async)]
fn marcar_pagado(
    s: State<AppState>,
    id: i64,
    pagado: bool,
    cobrador_id: Option<i64>,
    metodo: Option<String>,
    fecha: Option<String>,
    desde: Option<bool>,
) -> Res<()> {
    // Fecha explícita (al deshacer un cambio). Formato AAAA-MM-DD.
    let fecha = fecha.filter(|f| f.len() == 10 && f.as_bytes()[4] == b'-' && f.as_bytes()[7] == b'-');
    let metodo = if pagado {
        match metodo.as_deref() {
            Some("efectivo") | Some("bizum") => metodo,
            _ => return Err("Indica si se ha cobrado en efectivo o por Bizum".into()),
        }
    } else {
        None
    };
    let g = s.db.lock().map_err(e)?;
    let db = tx_escritura(con(&g)?)?;

    let actual: Option<(String, bool, Option<String>, Option<String>)> = db
        .query_row(
            "SELECT p.nombre, p.pagado, c.nombre, p.metodo_pago
             FROM participantes p LEFT JOIN cobradores c ON c.id=p.cobrador_id
             WHERE p.id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(e)?;
    let (nombre, ya_pagado, quien, como) = actual.ok_or_else(|| NO_EXISTE.to_string())?;
    let hom: i64 = db
        .query_row("SELECT homenajeado FROM participantes WHERE id=?1", params![id], |r| r.get(0))
        .map_err(e)?;
    if hom != 0 && pagado {
        return Err(format!("{} es homenajeado/a: no paga", nombre));
    }
    if let Some(d) = desde {
        if d != ya_pagado {
            return Err(if ya_pagado {
                let detalle = match (quien, como) {
                    (Some(q), Some(m)) => format!(" por {} ({})", q, m),
                    (Some(q), None) => format!(" por {}", q),
                    (None, Some(m)) => format!(" ({})", m),
                    _ => String::new(),
                };
                format!("{} ya estaba cobrado/a{} desde otro equipo. No se ha vuelto a cobrar.", nombre, detalle)
            } else {
                format!("{} ya estaba pendiente: otro equipo había anulado el cobro.", nombre)
            });
        }
    }

    if pagado {
        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM cobradores", [], |r| r.get(0))
            .map_err(e)?;
        match cobrador_id {
            Some(cid) => {
                let ok: i64 = db
                    .query_row(
                        "SELECT COUNT(*) FROM cobradores WHERE id=?1",
                        params![cid],
                        |r| r.get(0),
                    )
                    .map_err(e)?;
                if ok == 0 {
                    return Err("El cobrador elegido no existe (quizá lo ha eliminado otro equipo)".into());
                }
            }
            None => {
                if n > 0 {
                    return Err("Elige quién ha cobrado el dinero".into());
                }
            }
        }
    }
    db.execute(
        "UPDATE participantes
         SET pagado=?1,
             fecha_pago=CASE WHEN ?1=1 THEN COALESCE(?5, fecha_pago, date('now','localtime')) ELSE NULL END,
             cobrador_id=CASE WHEN ?1=1 THEN ?3 ELSE NULL END,
             metodo_pago=CASE WHEN ?1=1 THEN ?4 ELSE NULL END
         WHERE id=?2",
        params![pagado as i64, id, cobrador_id, metodo, fecha],
    )
    .map_err(e)?;
    db.commit().map_err(e)?;
    Ok(())
}

/// Vuelve a insertar un participante eliminado (botón «Deshacer»), con su estado de pago.
#[tauri::command(async)]
fn restaurar_participante(s: State<AppState>, participante: Participante) -> Res<()> {
    let nombre = participante.nombre.trim().to_string();
    if nombre.is_empty() {
        return Err("El nombre es obligatorio".into());
    }
    let g = s.db.lock().map_err(e)?;
    let db = tx_escritura(con(&g)?)?;
    let cobrador_id = match participante.cobrador_id {
        Some(cid) => {
            let n: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM cobradores WHERE id=?1",
                    params![cid],
                    |r| r.get(0),
                )
                .map_err(e)?;
            if n > 0 {
                Some(cid)
            } else {
                None
            }
        }
        None => None,
    };
    let pagado = participante.pagado && !participante.homenajeado;
    let menu_id = if participante.comida || participante.homenajeado {
        menu_valido(&db, participante.menu_id).unwrap_or(None)
    } else {
        None
    };
    let ocupado: i64 = match participante.id {
        Some(id) => db
            .query_row(
                "SELECT COUNT(*) FROM participantes WHERE id=?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(e)?,
        None => 1,
    };
    let id = if ocupado == 0 { participante.id } else { None };
    db.execute(
        "INSERT INTO participantes(id,nombre,comida,pagado,fecha_pago,notas,importe_regalo,cobrador_id,metodo_pago,menu_id,homenajeado)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            id,
            nombre,
            participante.comida as i64,
            pagado as i64,
            if pagado { participante.fecha_pago.clone() } else { None },
            participante.notas.trim(),
            participante.importe_regalo,
            if pagado { cobrador_id } else { None },
            if pagado { participante.metodo.clone() } else { None },
            menu_id,
            participante.homenajeado as i64
        ],
    )
    .map_err(e)?;
    db.commit().map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn eliminar_participante(s: State<AppState>, id: i64) -> Res<()> {
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    db.execute("DELETE FROM participantes WHERE id=?1", params![id])
        .map_err(e)?;
    Ok(())
}

// ───────────────────────── Gastos del regalo ─────────────────────────

const GASTO_NO_EXISTE: &str = "Ese gasto ya no existe (lo ha eliminado otro equipo)";

fn fecha_valida(f: &str) -> bool {
    let b = f.as_bytes();
    f.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && f.chars().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Normaliza y comprueba un gasto antes de guardarlo.
fn validar_gasto(c: &Connection, g: &mut Gasto) -> Res<()> {
    g.concepto = g.concepto.trim().to_string();
    if g.concepto.is_empty() {
        return Err("Indica en qué se ha gastado (concepto)".into());
    }
    if g.importe <= 0 {
        return Err("El importe del gasto debe ser mayor que cero".into());
    }
    if g.importe > 100_000_000 {
        return Err("Importe demasiado alto".into());
    }
    if !fecha_valida(&g.fecha) {
        return Err("Fecha no válida".into());
    }
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM cobradores", [], |r| r.get(0))
        .map_err(e)?;
    match g.cobrador_id {
        Some(cid) => {
            let ok: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM cobradores WHERE id=?1",
                    params![cid],
                    |r| r.get(0),
                )
                .map_err(e)?;
            if ok == 0 {
                return Err("El cobrador elegido no existe (quizá lo ha eliminado otro equipo)".into());
            }
        }
        None if n > 0 => return Err("Indica qué cobrador ha pagado el gasto".into()),
        None => {}
    }
    Ok(())
}

fn insertar_gasto(c: &Connection, g: &Gasto, con_id: bool) -> Res<()> {
    c.execute(
        "INSERT INTO gastos(id,concepto,importe,fecha,cobrador_id) VALUES(?1,?2,?3,?4,?5)",
        params![
            if con_id { g.id } else { None },
            g.concepto,
            g.importe,
            g.fecha,
            g.cobrador_id
        ],
    )
    .map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn guardar_gasto(s: State<AppState>, gasto: Gasto) -> Res<()> {
    let mut g = gasto;
    let guard = s.db.lock().map_err(e)?;
    let tx = tx_escritura(con(&guard)?)?;
    validar_gasto(&tx, &mut g)?;
    insertar_gasto(&tx, &g, false)?;
    tx.commit().map_err(e)?;
    Ok(())
}

/// Cambia solo los campos indicados de un gasto.
#[tauri::command(async)]
fn actualizar_gasto(
    s: State<AppState>,
    id: i64,
    concepto: Option<String>,
    importe: Option<i64>,
    fecha: Option<String>,
    cobrador_id: Option<i64>,
) -> Res<()> {
    let guard = s.db.lock().map_err(e)?;
    let tx = tx_escritura(con(&guard)?)?;
    let mut g = leer_gastos(&tx)?
        .into_iter()
        .find(|g| g.id == Some(id))
        .ok_or_else(|| GASTO_NO_EXISTE.to_string())?;
    if let Some(v) = concepto {
        g.concepto = v;
    }
    if let Some(v) = importe {
        g.importe = v;
    }
    if let Some(v) = fecha {
        g.fecha = v;
    }
    if cobrador_id.is_some() {
        g.cobrador_id = cobrador_id;
    }
    validar_gasto(&tx, &mut g)?;
    tx.execute(
        "UPDATE gastos SET concepto=?2, importe=?3, fecha=?4, cobrador_id=?5 WHERE id=?1",
        params![id, g.concepto, g.importe, g.fecha, g.cobrador_id],
    )
    .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn eliminar_gasto(s: State<AppState>, id: i64) -> Res<()> {
    let guard = s.db.lock().map_err(e)?;
    con(&guard)?
        .execute("DELETE FROM gastos WHERE id=?1", params![id])
        .map_err(e)?;
    Ok(())
}

/// Vuelve a insertar un gasto eliminado (botón «Deshacer»).
#[tauri::command(async)]
fn restaurar_gasto(s: State<AppState>, gasto: Gasto) -> Res<()> {
    let mut g = gasto;
    let guard = s.db.lock().map_err(e)?;
    let tx = tx_escritura(con(&guard)?)?;
    // Si su cobrador ya no existe, se recupera sin cobrador
    if let Some(cid) = g.cobrador_id {
        let ok: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM cobradores WHERE id=?1",
                params![cid],
                |r| r.get(0),
            )
            .map_err(e)?;
        if ok == 0 {
            g.cobrador_id = None;
        }
    }
    g.concepto = g.concepto.trim().to_string();
    let libre = match g.id {
        Some(id) => {
            tx.query_row("SELECT COUNT(*) FROM gastos WHERE id=?1", params![id], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(e)?
                == 0
        }
        None => false,
    };
    insertar_gasto(&tx, &g, libre)?;
    tx.commit().map_err(e)?;
    Ok(())
}

// ───────────────────────── Traspasos entre cobradores ─────────────────────────

const TRASPASO_NO_EXISTE: &str = "Ese traspaso ya no existe (lo ha eliminado otro equipo)";

fn existe_cobrador(c: &Connection, id: i64) -> Res<bool> {
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM cobradores WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(e)?;
    Ok(n > 0)
}

fn validar_traspaso(c: &Connection, t: &mut Traspaso) -> Res<()> {
    t.nota = t.nota.trim().to_string();
    if t.de_id == t.a_id {
        return Err("Quien entrega y quien recibe tienen que ser cobradores distintos".into());
    }
    if t.importe <= 0 {
        return Err("El importe del traspaso debe ser mayor que cero".into());
    }
    if t.importe > 100_000_000 {
        return Err("Importe demasiado alto".into());
    }
    if !fecha_valida(&t.fecha) {
        return Err("Fecha no válida".into());
    }
    if !existe_cobrador(c, t.de_id)? || !existe_cobrador(c, t.a_id)? {
        return Err("Uno de los cobradores ya no existe (quizá lo ha eliminado otro equipo)".into());
    }
    Ok(())
}

fn insertar_traspaso(c: &Connection, t: &Traspaso, con_id: bool) -> Res<()> {
    c.execute(
        "INSERT INTO traspasos(id,fecha,de_id,a_id,importe,nota) VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            if con_id { t.id } else { None },
            t.fecha,
            t.de_id,
            t.a_id,
            t.importe,
            t.nota
        ],
    )
    .map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn guardar_traspaso(s: State<AppState>, traspaso: Traspaso) -> Res<()> {
    let mut t = traspaso;
    let guard = s.db.lock().map_err(e)?;
    let tx = tx_escritura(con(&guard)?)?;
    validar_traspaso(&tx, &mut t)?;
    insertar_traspaso(&tx, &t, false)?;
    tx.commit().map_err(e)?;
    Ok(())
}

/// Cambia solo los campos indicados de un traspaso.
#[tauri::command(async)]
fn actualizar_traspaso(
    s: State<AppState>,
    id: i64,
    fecha: Option<String>,
    de_id: Option<i64>,
    a_id: Option<i64>,
    importe: Option<i64>,
    nota: Option<String>,
) -> Res<()> {
    let guard = s.db.lock().map_err(e)?;
    let tx = tx_escritura(con(&guard)?)?;
    let mut t = leer_traspasos(&tx)?
        .into_iter()
        .find(|t| t.id == Some(id))
        .ok_or_else(|| TRASPASO_NO_EXISTE.to_string())?;
    if let Some(v) = fecha {
        t.fecha = v;
    }
    if let Some(v) = de_id {
        t.de_id = v;
    }
    if let Some(v) = a_id {
        t.a_id = v;
    }
    if let Some(v) = importe {
        t.importe = v;
    }
    if let Some(v) = nota {
        t.nota = v;
    }
    validar_traspaso(&tx, &mut t)?;
    tx.execute(
        "UPDATE traspasos SET fecha=?2, de_id=?3, a_id=?4, importe=?5, nota=?6 WHERE id=?1",
        params![id, t.fecha, t.de_id, t.a_id, t.importe, t.nota],
    )
    .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(())
}

#[tauri::command(async)]
fn eliminar_traspaso(s: State<AppState>, id: i64) -> Res<()> {
    let guard = s.db.lock().map_err(e)?;
    con(&guard)?
        .execute("DELETE FROM traspasos WHERE id=?1", params![id])
        .map_err(e)?;
    Ok(())
}

/// Vuelve a insertar un traspaso eliminado (botón «Deshacer»).
#[tauri::command(async)]
fn restaurar_traspaso(s: State<AppState>, traspaso: Traspaso) -> Res<()> {
    let mut t = traspaso;
    let guard = s.db.lock().map_err(e)?;
    let tx = tx_escritura(con(&guard)?)?;
    validar_traspaso(&tx, &mut t)?;
    let libre = match t.id {
        Some(id) => {
            tx.query_row("SELECT COUNT(*) FROM traspasos WHERE id=?1", params![id], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(e)?
                == 0
        }
        None => false,
    };
    insertar_traspaso(&tx, &t, libre)?;
    tx.commit().map_err(e)?;
    Ok(())
}

/// Guarda un informe en CSV. La interfaz compone el texto y aquí solo se escribe,
/// con BOM para que Excel en español reconozca las tildes al abrirlo con doble clic.
#[tauri::command(async)]
fn exportar_csv(ruta: String, contenido: String) -> Res<String> {
    let ruta = PathBuf::from(ruta.trim());
    if ruta.as_os_str().is_empty() {
        return Err("Indica dónde guardar el archivo".into());
    }
    match ruta.extension().and_then(|x| x.to_str()) {
        Some(x) if x.eq_ignore_ascii_case("csv") => {}
        _ => return Err("El archivo debe terminar en .csv".into()),
    }
    match ruta.parent() {
        Some(d) if d.as_os_str().is_empty() || d.is_dir() => {}
        _ => return Err("La carpeta de destino no existe o no es accesible".into()),
    }
    let mut bytes = Vec::with_capacity(contenido.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(contenido.as_bytes());
    std::fs::write(&ruta, bytes).map_err(|err| {
        format!("No se ha podido guardar el archivo: {}", err)
    })?;
    Ok(ruta.display().to_string())
}

/// Abre un archivo con el programa predeterminado del sistema (visor de PDF).
fn abrir_archivo(ruta: &Path) -> Res<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(ruta)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(e)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(ruta).spawn().map_err(e)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(ruta).spawn().map_err(e)?;
    }
    Ok(())
}

/// Guarda el resumen en PDF (generado por la interfaz) directamente en la carpeta
/// Descargas, sin preguntar, y lo abre. Si el nombre ya existe añade « (1)», « (2)»…
#[tauri::command(async)]
fn descargar_pdf(app: tauri::AppHandle, nombre: String, contenido: Vec<u8>) -> Res<String> {
    if !contenido.starts_with(b"%PDF") {
        return Err("El contenido generado no es un PDF válido".into());
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "No se ha encontrado la carpeta Descargas".to_string())?;
    if !dir.is_dir() {
        return Err("La carpeta Descargas no existe o no es accesible".into());
    }
    let limpio: String = nombre
        .chars()
        .filter(|c| !c.is_control() && !"\\/:*?\"<>|".contains(*c))
        .collect();
    let base = limpio.trim().trim_end_matches(".pdf").trim().to_string();
    let base = if base.is_empty() { "resumen".to_string() } else { base };
    let mut ruta = dir.join(format!("{}.pdf", base));
    let mut n = 1;
    while ruta.exists() {
        ruta = dir.join(format!("{} ({}).pdf", base, n));
        n += 1;
    }
    std::fs::write(&ruta, contenido)
        .map_err(|err| format!("No se ha podido guardar el archivo: {}", err))?;
    // Si no se puede abrir, el archivo ya está guardado: se avisa sin fallar
    let abierto = abrir_archivo(&ruta).is_ok();
    Ok(format!(
        "{}{}",
        ruta.display(),
        if abierto { "" } else { "\n(No se pudo abrir automáticamente)" }
    ))
}

// ───────────────────────── Uso en varios equipos ─────────────────────────
//
// Todos ejecutan el mismo .exe desde una carpeta de red y comparten la base de datos
// que hay junto a él (o la indicada en `celebracion.ini`, línea `datos=...`).

const NOMBRE_DB: &str = "celebracion.db";
const NOMBRE_INI: &str = "celebracion.ini";

/// Decide qué base de datos usar a partir de la carpeta del ejecutable.
fn ruta_compartida(dir_exe: &Path) -> (PathBuf, &'static str) {
    if let Ok(txt) = std::fs::read_to_string(dir_exe.join(NOMBRE_INI)) {
        if let Some(v) = leer_ini(&txt, "datos") {
            let mut r = PathBuf::from(&v);
            if r.is_relative() {
                r = dir_exe.join(r);
            }
            if r.is_dir() || v.ends_with('\\') || v.ends_with('/') {
                r = r.join(NOMBRE_DB);
            }
            return (r, "ini");
        }
    }
    (dir_exe.join(NOMBRE_DB), "exe")
}

/// Lee `clave=valor` de un .ini sencillo (ignora secciones y comentarios).
fn leer_ini(txt: &str, clave: &str) -> Option<String> {
    txt.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with(';') && !l.starts_with('['))
        .filter_map(|l| l.split_once('='))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(clave))
        .map(|(_, v)| v.trim().trim_matches('"').trim().to_string())
        .filter(|v| !v.is_empty())
}

fn abrir_compartida(ruta: &Path, origen: &str) -> Res<Connection> {
    abrir_db(ruta, true).map_err(|err| {
        if origen == "evento" {
            return format!("{} (evento: {})", err, ruta.display());
        }
        let carpeta = ruta
            .parent()
            .map(|d| d.display().to_string())
            .unwrap_or_default();
        if origen == "ini" {
            format!("{} (carpeta indicada en {}: {})", err, NOMBRE_INI, carpeta)
        } else {
            format!(
                "{} (carpeta: {}). Los usuarios necesitan permiso de escritura en la carpeta del programa; si no es posible, indica otra en {} con la línea datos=\\\\servidor\\carpeta",
                err, carpeta, NOMBRE_INI
            )
        }
    })
}

fn bd_vacia(c: &Connection) -> Res<bool> {
    let n: i64 = c
        .query_row(
            "SELECT (SELECT COUNT(*) FROM participantes)
                  + (SELECT COUNT(*) FROM cobradores)
                  + (SELECT COUNT(*) FROM gastos)
                  + (SELECT COUNT(*) FROM traspasos)
                  + (SELECT COUNT(*) FROM menus)
                  + (SELECT COUNT(*) FROM aportes)
                  + (SELECT COUNT(*) FROM config)",
            [],
            |r| r.get(0),
        )
        .map_err(e)?;
    Ok(n == 0)
}

#[derive(Serialize)]
struct InfoDb {
    ruta: String,
    origen: String,
    conectado: bool,
    error: Option<String>,
    sin_evento: bool,
}

#[derive(Serialize)]
struct Conectado {
    equipo: String,
    usuario: String,
    yo: bool,
}

#[derive(Serialize)]
struct Sondeo {
    /// Cambia cuando OTRO equipo guarda algo en la base de datos
    version: i64,
    conectados: Vec<Conectado>,
}

#[derive(Serialize)]
struct Migracion {
    ruta: String,
    personas: i64,
    pagados: i64,
}

fn info(s: &State<AppState>) -> Res<InfoDb> {
    let conectado = s.db.lock().map_err(e)?.is_some();
    Ok(InfoDb {
        ruta: s.ruta.display().to_string(),
        origen: s.origen.to_string(),
        conectado,
        error: s.error_conexion.lock().map_err(e)?.clone(),
        sin_evento: s.sin_evento,
    })
}

// ───────────────────────── Varios eventos ─────────────────────────
//
// Cada evento es un archivo .db independiente. El «principal» es el de siempre; los demás
// están en la subcarpeta «Eventos» junto a él. Cada evento se abre en su propia ventana
// (otro proceso del mismo programa con `--db ruta`), así pueden verse varios a la vez.

const NOMBRE_ULTIMO: &str = "evento_actual.txt";
const NOMBRE_EVENTOS: &str = "Eventos";
const NOMBRE_PRIMER_EVENTO: &str = "Comida de celebración";

fn mismo_archivo(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Valor de `--db <ruta>` en la línea de comandos.
fn argumento_db() -> Option<PathBuf> {
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        if a == "--db" {
            return it.next().map(PathBuf::from);
        }
    }
    None
}

/// Qué base abrir al arrancar: la indicada con `--db`, el último evento elegido en este
/// equipo, o la principal.
fn ruta_de_inicio(
    principal: &Path,
    origen_principal: &'static str,
    local_dir: &Path,
) -> (PathBuf, &'static str) {
    if let Some(r) = argumento_db() {
        if r.is_file() {
            return (r, "evento");
        }
    }
    if let Ok(t) = std::fs::read_to_string(local_dir.join(NOMBRE_ULTIMO)) {
        let r = PathBuf::from(t.trim());
        if !t.trim().is_empty() && r.is_file() && !mismo_archivo(&r, principal) {
            return (r, "evento");
        }
    }
    (principal.to_path_buf(), origen_principal)
}

/// Qué hacer al arrancar si la base elegida es la principal y todavía no existe.
#[derive(Debug, PartialEq)]
enum SinBase {
    /// Existe: abrir normalmente
    Normal,
    /// Hay eventos en «Eventos»: no crear nada, que el usuario elija
    Elegir,
    /// No hay nada en ningún sitio: crear el primer evento en «Eventos»
    PrimerEvento,
}

fn hay_eventos(dir: &Path) -> bool {
    std::fs::read_dir(dir).map_or(false, |rd| {
        rd.flatten().any(|e| {
            let p = e.path();
            p.is_file()
                && p.extension()
                    .and_then(|x| x.to_str())
                    .map_or(false, |x| x.eq_ignore_ascii_case("db"))
        })
    })
}

fn sin_base(ruta: &Path, origen: &str, dir_eventos: &Path) -> SinBase {
    if origen == "evento" || ruta.is_file() {
        SinBase::Normal
    } else if hay_eventos(dir_eventos) {
        SinBase::Elegir
    } else {
        SinBase::PrimerEvento
    }
}

#[derive(Serialize)]
struct EventoInfo {
    nombre: String,
    archivo: String,
    ruta: String,
    actual: bool,
    principal: bool,
    personas: i64,
    pagados: i64,
    error: Option<String>,
}

fn resumen_evento(ruta: &Path) -> Res<(String, i64, i64)> {
    let c = abrir_db(ruta, false)?;
    let nombre = leer_config(&c).evento;
    let (p, pg) = c
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(pagado),0) FROM participantes",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(e)?;
    Ok((nombre, p, pg))
}

#[tauri::command(async)]
fn listar_eventos(s: State<AppState>) -> Res<Vec<EventoInfo>> {
    let mut rutas: Vec<PathBuf> = Vec::new();
    if s.principal.is_file() {
        rutas.push(s.principal.clone());
    }
    if let Ok(rd) = std::fs::read_dir(&s.dir_eventos) {
        for ent in rd.flatten() {
            let p = ent.path();
            let es_db = p
                .extension()
                .and_then(|x| x.to_str())
                .map_or(false, |x| x.eq_ignore_ascii_case("db"));
            if p.is_file() && es_db {
                rutas.push(p);
            }
        }
    }
    if s.ruta.is_file() && !rutas.iter().any(|r| mismo_archivo(r, &s.ruta)) {
        rutas.push(s.ruta.clone());
    }
    let mut v: Vec<EventoInfo> = rutas
        .into_iter()
        .map(|ruta| {
            let archivo = ruta
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let principal = mismo_archivo(&ruta, &s.principal);
            let actual = mismo_archivo(&ruta, &s.ruta);
            match resumen_evento(&ruta) {
                Ok((nombre, personas, pagados)) => EventoInfo {
                    nombre,
                    archivo,
                    ruta: ruta.display().to_string(),
                    actual,
                    principal,
                    personas,
                    pagados,
                    error: None,
                },
                Err(err) => EventoInfo {
                    nombre: archivo.clone(),
                    archivo,
                    ruta: ruta.display().to_string(),
                    actual,
                    principal,
                    personas: 0,
                    pagados: 0,
                    error: Some(err),
                },
            }
        })
        .collect();
    v.sort_by(|a, b| {
        b.actual
            .cmp(&a.actual)
            .then_with(|| a.nombre.to_lowercase().cmp(&b.nombre.to_lowercase()))
    });
    Ok(v)
}

/// Ruta de un archivo de evento nuevo: nombre sin caracteres no permitidos en Windows y,
/// si ya existe, con " (1)", " (2)"...
fn ruta_libre_evento(dir: &Path, nombre: &str) -> PathBuf {
    let limpio: String = nombre
        .chars()
        .filter(|c| !c.is_control() && !"\\/:*?\"<>|".contains(*c))
        .collect();
    let limpio = limpio.trim().trim_matches('.').trim().to_string();
    let limpio = if limpio.is_empty() { "evento".to_string() } else { limpio };
    let mut ruta = dir.join(format!("{}.db", limpio));
    let mut n = 1;
    while ruta.exists() {
        ruta = dir.join(format!("{} ({}).db", limpio, n));
        n += 1;
    }
    ruta
}

/// Crea un evento nuevo (archivo .db vacío en la carpeta «Eventos») y devuelve su ruta.
#[tauri::command(async)]
fn crear_evento(s: State<AppState>, nombre: String) -> Res<String> {
    let nombre = nombre.trim().to_string();
    if nombre.is_empty() {
        return Err("El nombre del evento es obligatorio".into());
    }
    std::fs::create_dir_all(&s.dir_eventos).map_err(|err| {
        format!(
            "No se puede crear la carpeta de eventos ({}): {}",
            s.dir_eventos.display(),
            err
        )
    })?;
    let ruta = ruta_libre_evento(&s.dir_eventos, &nombre);
    let c = abrir_db(&ruta, true)?;
    set_key(&c, "evento", &nombre)?;
    drop(c);
    Ok(ruta.display().to_string())
}

/// Abre un evento en una ventana nueva; con `cambiar`, cierra además esta ventana.
#[tauri::command(async)]
fn abrir_evento(
    app: tauri::AppHandle,
    s: State<AppState>,
    ruta: String,
    cambiar: bool,
) -> Res<()> {
    let ruta = PathBuf::from(ruta);
    if !ruta.is_file() {
        return Err(format!("No se encuentra el archivo {}", ruta.display()));
    }
    // Solo la base principal, las de la carpeta de eventos o la actual
    let permitido = mismo_archivo(&ruta, &s.principal)
        || mismo_archivo(&ruta, &s.ruta)
        || ruta
            .parent()
            .map_or(false, |d| mismo_archivo(d, &s.dir_eventos));
    if !permitido {
        return Err("Ese archivo no es un evento de esta carpeta".into());
    }
    let exe = std::env::current_exe().map_err(e)?;
    std::process::Command::new(exe)
        .arg("--db")
        .arg(&ruta)
        .spawn()
        .map_err(|err| format!("No se ha podido abrir el evento: {}", err))?;
    // Recordar el último evento elegido en este equipo (para el próximo arranque)
    let _ = std::fs::create_dir_all(&s.local_dir);
    let _ = std::fs::write(s.local_dir.join(NOMBRE_ULTIMO), ruta.display().to_string());
    if cambiar {
        app.exit(0);
    }
    Ok(())
}

/// Título de la ventana: «Evento — Comida de celebración».
#[tauri::command(async)]
fn titulo_ventana(app: tauri::AppHandle, titulo: String) -> Res<()> {
    if let Some(w) = app.get_webview_window("main") {
        w.set_title(&titulo).map_err(e)?;
    }
    Ok(())
}

/// Pasa la base principal a la carpeta de eventos con el nombre indicado y la abre allí.
/// Falla (sin cambiar nada) si otro equipo la tiene abierta.
#[tauri::command(async)]
fn mover_a_eventos(app: tauri::AppHandle, s: State<AppState>, nombre: String) -> Res<String> {
    use std::sync::atomic::Ordering;
    exigir_admin(&s)?;
    if !mismo_archivo(&s.ruta, &s.principal) {
        return Err("Solo se puede mover la base principal; esta ventana tiene abierto otro evento".into());
    }
    let nombre = nombre.trim().to_string();
    if nombre.is_empty() {
        return Err("El nombre es obligatorio".into());
    }
    std::fs::create_dir_all(&s.dir_eventos).map_err(|err| {
        format!(
            "No se puede crear la carpeta de eventos ({}): {}",
            s.dir_eventos.display(),
            err
        )
    })?;
    let destino = ruta_libre_evento(&s.dir_eventos, &nombre);
    s.moviendo.store(true, Ordering::SeqCst);
    // Poner el nombre, dejar de figurar como conectado y cerrar la conexión propia
    {
        let mut g = s.db.lock().map_err(e)?;
        if let Some(c) = g.as_ref() {
            let _ = set_key(c, "evento", &nombre);
            let (eq, us) = identidad();
            let _ = c.execute(
                "DELETE FROM presencia WHERE clave=?1",
                params![format!("{}|{}", eq, us)],
            );
            let _ = c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
        *g = None;
    }
    if let Err(err) = std::fs::rename(&s.ruta, &destino) {
        // No se ha movido nada: se vuelve a abrir la base donde estaba
        if let Ok(c) = abrir_compartida(&s.ruta, s.origen) {
            *s.db.lock().map_err(e)? = Some(c);
        }
        s.moviendo.store(false, Ordering::SeqCst);
        return Err(format!(
            "No se ha podido mover la base de datos: {}. Cierra el programa en los demás equipos y vuelve a intentarlo.",
            err
        ));
    }
    // Abrirla ya desde su nueva ubicación y cerrar esta ventana
    let _ = std::fs::create_dir_all(&s.local_dir);
    let _ = std::fs::write(s.local_dir.join(NOMBRE_ULTIMO), destino.display().to_string());
    let exe = std::env::current_exe().map_err(e)?;
    std::process::Command::new(exe)
        .arg("--db")
        .arg(&destino)
        .spawn()
        .map_err(|err| {
            format!(
                "La base se ha movido a {} pero no se ha podido reabrir: {}",
                destino.display(),
                err
            )
        })?;
    app.exit(0);
    Ok(destino.display().to_string())
}

#[tauri::command(async)]
fn info_db(s: State<AppState>) -> Res<InfoDb> {
    info(&s)
}

/// Vuelve a abrir la base de datos compartida (tras un corte de red).
#[tauri::command(async)]
fn reconectar(s: State<AppState>) -> Res<InfoDb> {
    if s.sin_evento || s.moviendo.load(std::sync::atomic::Ordering::SeqCst) {
        return info(&s);
    }
    match abrir_compartida(&s.ruta, s.origen) {
        Ok(c) => {
            *s.db.lock().map_err(e)? = Some(c);
            *s.error_conexion.lock().map_err(e)? = None;
            *s.ultimo_latido.lock().map_err(e)? = None;
        }
        Err(err) => {
            *s.error_conexion.lock().map_err(e)? = Some(err);
        }
    }
    info(&s)
}

/// Datos locales de una versión anterior que se pueden importar
/// (solo si la base compartida está todavía vacía).
#[tauri::command(async)]
fn migracion_pendiente(s: State<AppState>) -> Res<Option<Migracion>> {
    // Solo se ofrece importar en la base principal, nunca en un evento nuevo
    if !(s.primer_inicio || mismo_archivo(&s.ruta, &s.principal)) || s.ruta_antigua == s.ruta || !s.ruta_antigua.is_file() {
        return Ok(None);
    }
    {
        let g = s.db.lock().map_err(e)?;
        if !bd_vacia(con(&g)?)? {
            return Ok(None);
        }
    }
    let antigua = match Connection::open_with_flags(
        &s.ruta_antigua,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let r = antigua.query_row(
        "SELECT COUNT(*), COALESCE(SUM(pagado),0) FROM participantes",
        [],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    );
    match r {
        Ok((personas, pagados)) if personas > 0 => Ok(Some(Migracion {
            ruta: s.ruta_antigua.display().to_string(),
            personas,
            pagados,
        })),
        _ => Ok(None),
    }
}

/// Aparta la base local antigua para no volver a ofrecerla (no se borra nada).
fn apartar_antigua(s: &State<AppState>, sufijo: &str) {
    let destino = s
        .ruta_antigua
        .with_file_name(format!("celebracion-antigua-{}.db", sufijo));
    let _ = std::fs::rename(&s.ruta_antigua, destino);
}

const SQL_IMPORTAR: &str =
    "INSERT INTO main.config(key,value) SELECT key,value FROM antigua.config;
     INSERT INTO main.cobradores(id,nombre) SELECT id,nombre FROM antigua.cobradores;
     INSERT INTO main.participantes(id,nombre,comida,pagado,fecha_pago,notas,importe_regalo,cobrador_id,metodo_pago)
       SELECT id,nombre,comida,pagado,fecha_pago,notas,importe_regalo,cobrador_id,metodo_pago
       FROM antigua.participantes;
     INSERT INTO main.gastos(id,concepto,importe,fecha,cobrador_id,metodo)
       SELECT id,concepto,importe,fecha,cobrador_id,metodo FROM antigua.gastos;
     INSERT INTO main.traspasos(id,fecha,de_id,a_id,importe,nota)
       SELECT id,fecha,de_id,a_id,importe,nota FROM antigua.traspasos;";

/// Copia a la base compartida (vacía) todo lo de la base local antigua:
/// configuración, contraseña, cobradores y participantes con su estado de pago.
#[tauri::command(async)]
fn importar_local(s: State<AppState>) -> Res<i64> {
    if !s.ruta_antigua.is_file() {
        return Err("No hay datos antiguos en este equipo".into());
    }
    // Ponerla al día (columnas nuevas) antes de copiar
    drop(abrir_db(&s.ruta_antigua, false)?);
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    db.execute(
        "ATTACH DATABASE ?1 AS antigua",
        params![s.ruta_antigua.display().to_string()],
    )
    .map_err(e)?;
    let resultado = (|| -> Res<i64> {
        let tx = tx_escritura(db)?;
        if !bd_vacia(&tx)? {
            return Err(
                "La base compartida ya tiene datos (quizá otro equipo ha empezado a usarla). No se ha importado nada.".into(),
            );
        }
        tx.execute_batch(SQL_IMPORTAR)
        .map_err(e)?;
        let n: i64 = tx
            .query_row("SELECT COUNT(*) FROM main.participantes", [], |r| r.get(0))
            .map_err(e)?;
        tx.commit().map_err(e)?;
        Ok(n)
    })();
    let _ = db.execute("DETACH DATABASE antigua", []);
    drop(g);
    let n = resultado?;
    apartar_antigua(&s, "importada");
    *s.admin.lock().map_err(e)? = false;
    Ok(n)
}

#[tauri::command(async)]
fn descartar_local(s: State<AppState>) -> Res<()> {
    apartar_antigua(&s, "sin-importar");
    Ok(())
}

/// Consulta ligera que la interfaz hace cada pocos segundos: ¿ha cambiado algo
/// desde otro equipo? ¿quién está conectado? De paso anuncia a este equipo.
#[tauri::command(async)]
fn sondeo(s: State<AppState>) -> Res<Sondeo> {
    let g = s.db.lock().map_err(e)?;
    let db = con(&g)?;
    let (equipo, usuario) = identidad();
    let clave = format!("{}|{}", equipo, usuario);
    let ahora = segundos();

    let toca_latido = {
        let ul = s.ultimo_latido.lock().map_err(e)?;
        ul.map(|t| t.elapsed() >= LATIDO).unwrap_or(true)
    };
    let resultado = (|| -> rusqlite::Result<Sondeo> {
        if toca_latido {
            db.execute(
                "INSERT INTO presencia(clave,equipo,usuario,visto) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(clave) DO UPDATE SET visto=excluded.visto",
                params![clave, equipo, usuario, ahora],
            )?;
            db.execute(
                "DELETE FROM presencia WHERE visto < ?1",
                params![ahora - 24 * 3600],
            )?;
        }
        let version: i64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        let mut st = db.prepare(
            "SELECT clave,equipo,usuario FROM presencia WHERE visto >= ?1 ORDER BY equipo",
        )?;
        let conectados = st
            .query_map(params![ahora - CADUCIDAD_PRESENCIA], |r| {
                Ok(Conectado {
                    yo: r.get::<_, String>(0)? == clave,
                    equipo: r.get(1)?,
                    usuario: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Sondeo { version, conectados })
    })();

    match resultado {
        Ok(r) => {
            if toca_latido {
                *s.ultimo_latido.lock().map_err(e)? = Some(Instant::now());
            }
            Ok(r)
        }
        Err(err) => {
            let msg = e(err);
            // Un bloqueo momentáneo no es una desconexión
            if !msg.starts_with("Otro equipo") {
                drop(g);
                *s.db.lock().map_err(e)? = None;
                *s.error_conexion.lock().map_err(e)? = Some(msg.clone());
            }
            Err(msg)
        }
    }
}

/// Al cerrar la aplicación, deja de figurar como conectado.
fn salir(s: &AppState) {
    if let Ok(g) = s.db.lock() {
        if let Some(c) = g.as_ref() {
            let (eq, us) = identidad();
            let _ = c.execute(
                "DELETE FROM presencia WHERE clave=?1",
                params![format!("{}|{}", eq, us)],
            );
        }
    }
}

const URLS_PERMITIDAS: &[&str] = &["https://www.paypal.me/marianoog"];

#[tauri::command]
fn open_url(url: String) -> Res<()> {
    if !URLS_PERMITIDAS.contains(&url.as_str()) {
        return Err("Enlace no permitido".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(e)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map_err(e)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(e)?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Base de datos compartida: junto al ejecutable (o la de celebracion.ini)
            let exe = std::env::current_exe()?;
            let dir_exe = exe
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
            let (principal, origen_principal) = ruta_compartida(&dir_exe);
            let local_dir = app.path().app_local_data_dir()?;
            let (mut ruta, mut origen) = ruta_de_inicio(&principal, origen_principal, &local_dir);
            let dir_eventos = principal
                .parent()
                .map(|d| d.join(NOMBRE_EVENTOS))
                .unwrap_or_else(|| PathBuf::from(NOMBRE_EVENTOS));
            let mut sin_evento = false;
            let mut primer_inicio = false;
            match sin_base(&ruta, origen, &dir_eventos) {
                SinBase::Normal => {}
                SinBase::Elegir => sin_evento = true,
                SinBase::PrimerEvento => {
                    if std::fs::create_dir_all(&dir_eventos).is_ok() {
                        ruta = ruta_libre_evento(&dir_eventos, NOMBRE_PRIMER_EVENTO);
                        origen = "evento";
                        primer_inicio = true;
                    }
                }
            }
            // Si no se puede abrir NO se usa una base local (se partirían los datos):
            // se arranca sin conexión y se avisa.
            let (conn, error) = if sin_evento {
                (None, None)
            } else {
                match abrir_compartida(&ruta, origen) {
                    Ok(c) => {
                        if primer_inicio {
                            let _ = set_key(&c, "evento", NOMBRE_PRIMER_EVENTO);
                        }
                        (Some(c), None)
                    }
                    Err(err) => (None, Some(err)),
                }
            };
            let ruta_antigua = app.path().app_data_dir()?.join(NOMBRE_DB);
            app.manage(AppState {
                db: Mutex::new(conn),
                ruta,
                origen,
                ruta_antigua,
                principal,
                dir_eventos,
                local_dir,
                admin: Mutex::new(false),
                ultimo_latido: Mutex::new(None),
                error_conexion: Mutex::new(error),
                moviendo: std::sync::atomic::AtomicBool::new(false),
                sin_evento,
                primer_inicio,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            estado,
            crear_password,
            desbloquear,
            bloquear,
            cambiar_password,
            cargar,
            guardar_config,
            guardar_cobrador,
            eliminar_cobrador,
            guardar_menu,
            eliminar_menu,
            guardar_participante,
            actualizar_participante,
            marcar_pagado,
            eliminar_participante,
            restaurar_participante,
            guardar_gasto,
            actualizar_gasto,
            eliminar_gasto,
            guardar_aporte,
            eliminar_aporte,
            restaurar_gasto,
            guardar_traspaso,
            actualizar_traspaso,
            eliminar_traspaso,
            restaurar_traspaso,
            exportar_csv,
            descargar_pdf,
            listar_eventos,
            crear_evento,
            abrir_evento,
            mover_a_eventos,
            titulo_ventana,
            info_db,
            reconectar,
            sondeo,
            migracion_pendiente,
            importar_local,
            descartar_local,
            open_url
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar la aplicación")
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                salir(&app.state::<AppState>());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("celebracion-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(nombre);
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn dos_equipos_escriben_a_la_vez_sin_perder_datos() {
        let ruta = tmp("concurrencia.db");
        abrir_db(&ruta, true).unwrap();
        let hilos: Vec<_> = (0..2)
            .map(|n| {
                let ruta = ruta.clone();
                std::thread::spawn(move || {
                    let c = abrir_db(&ruta, false).unwrap();
                    for i in 0..150 {
                        let tx = tx_escritura(&c).unwrap();
                        tx.execute(
                            "INSERT INTO participantes(nombre,comida) VALUES(?1,1)",
                            params![format!("equipo{}-{}", n, i)],
                        )
                        .unwrap();
                        tx.commit().unwrap();
                    }
                })
            })
            .collect();
        for h in hilos {
            h.join().unwrap();
        }
        let c = abrir_db(&ruta, false).unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM participantes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 300);
        let modo: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(modo, "delete");
    }

    #[test]
    fn data_version_detecta_cambios_de_otro_equipo() {
        let ruta = tmp("version.db");
        let a = abrir_db(&ruta, true).unwrap();
        let b = abrir_db(&ruta, false).unwrap();
        let v = |c: &Connection| -> i64 { c.query_row("PRAGMA data_version", [], |r| r.get(0)).unwrap() };
        let v1 = v(&a);
        a.execute("INSERT INTO participantes(nombre) VALUES('propio')", []).unwrap();
        assert_eq!(v(&a), v1, "los cambios propios no cuentan");
        b.execute("INSERT INTO participantes(nombre) VALUES('ajeno')", []).unwrap();
        assert_ne!(v(&a), v1, "los cambios de otro equipo sí");
    }

    #[test]
    fn rechaza_archivos_que_no_son_de_la_aplicacion() {
        let ruta = tmp("ajena.db");
        let c = Connection::open(&ruta).unwrap();
        c.execute_batch("CREATE TABLE clientes(id INTEGER);").unwrap();
        drop(c);
        assert!(abrir_db(&ruta, false).is_err());
        assert!(abrir_db(&tmp("no-existe.db"), false).is_err());
    }

    #[test]
    fn copia_con_vacuum_into() {
        let origen = tmp("origen.db");
        let destino = tmp("destino.db");
        let c = abrir_db(&origen, true).unwrap();
        c.execute("INSERT INTO participantes(nombre) VALUES('Ana')", []).unwrap();
        c.execute("VACUUM INTO ?1", params![destino.display().to_string()]).unwrap();
        let d = abrir_db(&destino, false).unwrap();
        let n: String = d.query_row("SELECT nombre FROM participantes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, "Ana");
    }

    #[test]
    fn lee_la_ruta_del_ini() {
        let ini = "; comentario\n[general]\n  DATOS = \"\\\\srv\\comun\\cele.db\"  \n";
        assert_eq!(leer_ini(ini, "datos").as_deref(), Some("\\\\srv\\comun\\cele.db"));
        assert_eq!(leer_ini("\u{feff}datos=x.db", "datos").as_deref(), Some("x.db"));
        assert_eq!(leer_ini("# datos=x.db\notra=1", "datos"), None);
        assert_eq!(leer_ini("datos=", "datos"), None);
    }

    #[test]
    fn ruta_junto_al_exe_o_desde_ini() {
        let dir = tmp("x").parent().unwrap().join("exe-dir");
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join(NOMBRE_INI));
        assert_eq!(ruta_compartida(&dir), (dir.join(NOMBRE_DB), "exe"));
        std::fs::write(dir.join(NOMBRE_INI), "datos=datos/\n").unwrap();
        assert_eq!(ruta_compartida(&dir), (dir.join("datos").join(NOMBRE_DB), "ini"));
        std::fs::write(dir.join(NOMBRE_INI), "datos=otra.db\n").unwrap();
        assert_eq!(ruta_compartida(&dir), (dir.join("otra.db"), "ini"));
        std::fs::remove_file(dir.join(NOMBRE_INI)).unwrap();
    }

    #[test]
    fn importa_la_base_antigua_en_una_compartida_vacia() {
        let antigua = tmp("antigua.db");
        let compartida = tmp("compartida.db");
        {
            let c = abrir_db(&antigua, true).unwrap();
            c.execute("INSERT INTO cobradores(id,nombre) VALUES(7,'Carmen')", []).unwrap();
            c.execute(
                "INSERT INTO participantes(nombre,comida,pagado,cobrador_id,metodo_pago) VALUES('Ana',1,1,7,'bizum')",
                [],
            )
            .unwrap();
            set_key(&c, "precio_comida", "3500").unwrap();
        }
        let db = abrir_db(&compartida, true).unwrap();
        assert!(bd_vacia(&db).unwrap());
        db.execute("ATTACH DATABASE ?1 AS antigua", params![antigua.display().to_string()]).unwrap();
        db.execute_batch(SQL_IMPORTAR)
        .unwrap();
        db.execute("DETACH DATABASE antigua", []).unwrap();
        let (n, cob): (String, String) = db
            .query_row(
                "SELECT p.nombre, c.nombre FROM participantes p JOIN cobradores c ON c.id=p.cobrador_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((n.as_str(), cob.as_str()), ("Ana", "Carmen"));
        assert_eq!(leer_config(&db).precio_comida, 3500);
        assert!(!bd_vacia(&db).unwrap());
    }

    #[test]
    fn nombres_de_archivo_de_evento() {
        let d = tmp("dir-eventos");
        std::fs::create_dir_all(&d).unwrap();
        let r1 = ruta_libre_evento(&d, "Comida: Navidad?");
        assert_eq!(r1.file_name().unwrap().to_string_lossy(), "Comida Navidad.db");
        std::fs::write(&r1, b"x").unwrap();
        let r2 = ruta_libre_evento(&d, "Comida: Navidad?");
        assert_eq!(r2.file_name().unwrap().to_string_lossy(), "Comida Navidad (1).db");
        let r3 = ruta_libre_evento(&d, "///");
        assert_eq!(r3.file_name().unwrap().to_string_lossy(), "evento.db");
    }

    #[test]
    fn arranque_sin_base() {
        let dir = tmp("arranque-sin-base");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let principal = dir.join("celebracion.db");
        let ev = dir.join("Eventos");
        // Nada en ningún sitio: primer evento en Eventos
        assert_eq!(sin_base(&principal, "exe", &ev), SinBase::PrimerEvento);
        // Hay eventos: no se crea nada, se elige
        std::fs::create_dir_all(&ev).unwrap();
        std::fs::write(ev.join("a.db"), b"x").unwrap();
        assert_eq!(sin_base(&principal, "exe", &ev), SinBase::Elegir);
        // Un evento ya elegido, o la principal existente, se abren sin más
        assert_eq!(sin_base(&ev.join("a.db"), "evento", &ev), SinBase::Normal);
        std::fs::write(&principal, b"x").unwrap();
        assert_eq!(sin_base(&principal, "exe", &ev), SinBase::Normal);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn homenajeados_no_pagan_y_su_comida_sale_del_regalo() {
        let cfg = Config {
            evento: String::new(),
            fecha: String::new(),
            regalo_desc: String::new(),
            precio_comida: 2000,
            precio_regalo: 1000,
        };
        let mk = |n: &str, pagado: bool, hom: bool| Participante {
            id: None,
            nombre: n.into(),
            comida: true,
            pagado,
            fecha_pago: None,
            notas: String::new(),
            importe_regalo: None,
            debe: 0,
            cobrador_id: None,
            cobrador: None,
            metodo: Some("efectivo".into()),
            menu_id: None,
            menu: None,
            homenajeado: hom,
        };
        let ps = vec![mk("A", true, false), mk("B", false, false), mk("H1", false, true), mk("H2", false, true)];
        assert_eq!(debe_de(&ps[2], &cfg), 0);
        let mut r = calcular_resumen(&ps, &cfg);
        aplicar_movimientos(&mut r, &[], &[]);
        assert_eq!((r.total_personas, r.con_comida, r.homenajeados), (4, 4, 2));
        assert_eq!((r.pagados, r.pendientes), (1, 1));
        assert_eq!(r.total_esperado, 6000);
        assert_eq!(r.comida_homenajeados, 4000);
        assert_eq!(r.cobrado_regalo, 1000);
        assert_eq!(r.disponible_regalo, 1000 - 4000);
        let ap = vec![
            Aporte { id: None, concepto: "Sobrante 2025".into(), importe: 5000, fecha: "2026-01-01".into(), destino: "regalo".into() },
            Aporte { id: None, concepto: "Sobrante 2025".into(), importe: 700, fecha: "2026-01-01".into(), destino: "comida".into() },
        ];
        aplicar_aportes(&mut r, &ap);
        assert_eq!((r.aportes_regalo, r.aportes_comida, r.disponible_regalo), (5000, 700, 2700));
        assert_eq!((r.comida_cubierta, r.sobrante_comida), (700, 0));
    }

    #[test]
    fn eventos_independientes() {
        let a = tmp("evento-a.db");
        let b = tmp("evento-b.db");
        let ca = abrir_db(&a, true).unwrap();
        let cb = abrir_db(&b, true).unwrap();
        set_key(&ca, "evento", "Jubilación").unwrap();
        set_key(&cb, "evento", "Navidad").unwrap();
        ca.execute("INSERT INTO participantes(nombre,comida,pagado) VALUES('Ana',1,1)", [])
            .unwrap();
        drop((ca, cb));
        let (n, p, pg) = resumen_evento(&a).unwrap();
        assert_eq!((n.as_str(), p, pg), ("Jubilación", 1, 1));
        let (n, p, pg) = resumen_evento(&b).unwrap();
        assert_eq!((n.as_str(), p, pg), ("Navidad", 0, 0));
        assert!(mismo_archivo(&a, &a));
        assert!(!mismo_archivo(&a, &b));
    }

    #[test]
    fn regalo_propio_y_menus() {
        let ruta = tmp("menus.db");
        let c = abrir_db(&ruta, true).unwrap();
        set_key(&c, "precio_comida", "3000").unwrap();
        set_key(&c, "precio_regalo", "1000").unwrap();
        c.execute_batch(
            "INSERT INTO menus(id,nombre) VALUES(1,'Carne'),(2,'Pescado');
             INSERT INTO participantes(nombre,comida,pagado,menu_id,importe_regalo) VALUES
               ('Ana',1,1,1,NULL),
               ('Luis',1,0,2,2500),
               ('Eva',0,0,NULL,500);",
        )
        .unwrap();
        let cfg = leer_config(&c);
        let ps = leer_participantes(&c, &cfg).unwrap();
        let por = |n: &str| ps.iter().find(|p| p.nombre == n).unwrap();
        assert_eq!(por("Ana").debe, 4000);
        assert_eq!(por("Luis").debe, 5500); // 30 + regalo propio de 25
        assert_eq!(por("Eva").debe, 500); // solo regalo, 5 €
        assert_eq!(por("Luis").menu.as_deref(), Some("Pescado"));
        let r = calcular_resumen(&ps, &cfg);
        assert_eq!(r.total_regalo, 1000 + 2500 + 500);
        assert_eq!(r.total_esperado, 4000 + 5500 + 500);
        assert_eq!(r.cobrado, 4000);
        assert_eq!(r.pendiente, 6000);
        let menus = leer_menus(&c).unwrap();
        assert_eq!(menus.iter().find(|m| m.id == 2).unwrap().personas, 1);
    }

    #[test]
    fn saldo_cobrado_menos_gastado_mas_recibido_menos_entregado() {
        let ruta = tmp("saldos.db");
        let c = abrir_db(&ruta, true).unwrap();
        c.execute_batch(
            "INSERT INTO cobradores(id,nombre) VALUES(1,'Carmen'),(2,'Álvaro');",
        )
        .unwrap();
        set_key(&c, "precio_comida", "3000").unwrap();
        set_key(&c, "precio_regalo", "1000").unwrap();
        for (n, comida, cob) in [("Ana", 1, 1), ("Luis", 0, 1), ("Eva", 1, 2)] {
            c.execute(
                "INSERT INTO participantes(nombre,comida,pagado,cobrador_id,metodo_pago) VALUES(?1,?2,1,?3,'efectivo')",
                params![n, comida, cob],
            )
            .unwrap();
        }
        // Carmen cobra 40+10 = 50 €; Álvaro 40 €
        let mut g = Gasto {
            id: None,
            concepto: "  Reloj ".into(),
            importe: 2500,
            fecha: "2026-11-08".into(),
            cobrador_id: Some(2),
            cobrador: None,
        };
        validar_gasto(&c, &mut g).unwrap();
        assert_eq!(g.concepto, "Reloj");
        insertar_gasto(&c, &g, false).unwrap();
        let mut t = Traspaso {
            id: None,
            fecha: "2026-11-08".into(),
            de_id: 1,
            de: None,
            a_id: 2,
            a: None,
            importe: 2000,
            nota: " para el reloj ".into(),
        };
        validar_traspaso(&c, &mut t).unwrap();
        assert_eq!(t.nota, "para el reloj");
        insertar_traspaso(&c, &t, false).unwrap();

        let cfg = leer_config(&c);
        let ps = leer_participantes(&c, &cfg).unwrap();
        let gs = leer_gastos(&c).unwrap();
        let ts = leer_traspasos(&c).unwrap();
        let mut r = calcular_resumen(&ps, &cfg);
        aplicar_movimientos(&mut r, &gs, &ts);
        assert_eq!(r.cobrado_regalo, 3000);
        assert_eq!(r.gastado, 2500);
        assert_eq!(r.disponible_regalo, 500);
        assert_eq!(r.traspasado, 2000);
        let cob = calcular_cobradores(&c, &ps, &gs, &ts).unwrap();
        let carmen = cob.iter().find(|x| x.id == 1).unwrap();
        let alvaro = cob.iter().find(|x| x.id == 2).unwrap();
        assert_eq!((carmen.total, carmen.entregado, carmen.saldo), (5000, 2000, 3000));
        assert_eq!((alvaro.total, alvaro.gastado, alvaro.recibido, alvaro.saldo), (4000, 2500, 2000, 3500));
        // El total en manos de los cobradores = cobrado − gastado (los traspasos no cambian el total)
        assert_eq!(carmen.saldo + alvaro.saldo, r.cobrado - r.gastado);

        // Validaciones
        let mut malo = t.clone();
        malo.a_id = 1;
        assert!(validar_traspaso(&c, &mut malo).is_err(), "no a sí mismo");
        let mut malo = t.clone();
        malo.a_id = 99;
        assert!(validar_traspaso(&c, &mut malo).is_err(), "cobrador inexistente");
        let mut malo = t.clone();
        malo.importe = 0;
        assert!(validar_traspaso(&c, &mut malo).is_err());
        let mut malo = g.clone();
        malo.cobrador_id = None;
        assert!(validar_gasto(&c, &mut malo).is_err(), "con cobradores, hay que indicar quién paga");
        let mut malo = g.clone();
        malo.fecha = "08/11/2026".into();
        assert!(validar_gasto(&c, &mut malo).is_err());
    }
}
