# Comida de celebración

App de escritorio (Tauri 2 + Rust + React/TypeScript + SQLite) para gestionar una comida de celebración y el regalo:
parámetros protegidos con contraseña, participantes, control de pagos y totales.

## Compilar

```
npm install
npm run tauri build -- --no-bundle
```

El ejecutable queda en `src-tauri/target/release/celebracion.exe`.

Desarrollo: `npm run tauri dev` (la base de datos se crea junto al ejecutable de desarrollo, en `src-tauri/target/debug/`).

## Uso

1. **Primeros pasos**: mientras falten precios o participantes, un panel guía los pasos (contraseña → precios → cobradores → participantes).
2. **🔒 Administrador**: la primera vez pide crear la contraseña y abre directamente los parámetros; después sirve para desbloquear. Desbloqueado aparecen **⚙ Parámetros**, **🔑** (cambiar contraseña) y **🔓 Bloquear**.
3. **⚙ Parámetros**: nombre del evento, fecha/lugar, regalo, precio de la comida e importe general del regalo por persona (con vista previa de lo que paga cada uno), los **tipos de menú** y la lista de **cobradores** (menús y cobradores se guardan al momento).
4. **Participantes, en la propia tabla**: la fila superior añade personas (<kbd>Ctrl</kbd>+<kbd>N</kbd>; avisa si el nombre ya existe). Nombre, modalidad (solo regalo o el menú elegido), regalo y notas se editan en la celda (Enter guarda, Esc cancela).
5. **Cobrar**: en la barra **Al cobrar** se elige quién recoge el dinero y el método (efectivo / Bizum); se recuerda entre sesiones. El botón **Cobrar** de cada fila registra el pago con esa elección. En filas pagadas, cobrador y método se cambian en la columna *Cobro*; la **fecha de cobro** también se puede corregir; pulsando **✓ Pagado** se anula.
   Se cobra todo o nada: no hay cobros parciales.
6. **Deshacer**: cobrar, anular y eliminar muestran un aviso con **Deshacer**.
7. **Filtrar y ordenar**: buscador por nombre o notas (<kbd>Ctrl</kbd>+<kbd>F</kbd>, sin distinguir tildes), pestañas con contadores, **resumen por menú** bajo las tarjetas (cada botón filtra por ese menú; «Sin elegir» avisa de quien aún no tiene menú y se marca en ámbar en la tabla), tarjetas *Cobrado* / *Falta por cobrar* clicables y columnas ordenables.
8. **¿Dónde está el dinero?**: total en efectivo y Bizum y lo que tiene cada cobrador.
9. **🖨 Imprimir**: listado limpio con estado de cada persona y resumen al pie.

## Menús y regalo por persona

- **Tipos de menú** (⚙ Parámetros): solo nombre, sin precio (p. ej. *Carne*, *Pescado*). En la columna *Modalidad* se elige el menú de cada persona o *Solo regalo*. No se puede eliminar un menú que alguien tenga elegido. El informe CSV incluye cuántas personas hay por menú.
- **Regalo propio**: la columna *Regalo* muestra lo que aporta cada persona. Por defecto es el importe general; si alguien da más (o menos), se escribe su importe en la celda y se resalta en negrita. Si se vuelve a escribir el importe general, recupera el valor por defecto. Los totales, el *Importe* y el dinero de cada cobrador usan el regalo propio.

## Sacar los datos fuera

- **📋 Copiar lista** (aparece al filtrar por «Pendientes»): copia al portapapeles quién falta por pagar y cuánto, con el total, listo para pegar en WhatsApp o en un correo.
- **⬇ Exportar**: guarda un informe completo en **CSV** (resumen, participantes, gastos, traspasos y caja por cobrador). Se escribe con BOM UTF-8, separador `;` y decimales con coma, para que Excel en español lo abra bien con doble clic.
- **📄 Resumen PDF**: genera un PDF completo (A4) con totales, menús, dinero de cada cobrador, participantes con su estado de pago, gastos y traspasos. Pide dónde guardarlo.
- **🖨 Imprimir**: listado limpio de la pestaña abierta, con resumen al pie.

## Atajos de teclado

| Atajo | Qué hace |
|---|---|
| Cualquier letra | Salta al buscador y empieza a escribir |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Buscar |
| <kbd>Enter</kbd> en el buscador | Si solo queda una persona y está pendiente, le cobra |
| <kbd>Esc</kbd> en el buscador | Borra la búsqueda |
| <kbd>Ctrl</kbd>+<kbd>N</kbd> | Añadir (persona, gasto o traspaso, según la pestaña) |
| <kbd>Ctrl</kbd>+<kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> | Participantes / Gastos / Traspasos |
| <kbd>Enter</kbd> / <kbd>Esc</kbd> en una celda | Guardar / cancelar |

## Gastos del regalo y traspasos

Dos pestañas, junto a la de participantes, para el dinero una vez recogido:

**🎁 Gastos del regalo** — lo que los cobradores van pagando para el regalo con el dinero recogido.

- Cada gasto tiene **fecha, concepto, importe y quién lo paga** (un cobrador). No se distingue efectivo de Bizum: lo que importa es cuánto ha salido y de quién.
- Resumen: **recaudado para el regalo − gastado = disponible**. Si se gasta de más, se marca en rojo («Gastado de más»); está permitido, porque alguien puede adelantar dinero.

**⇄ Traspasos** — dinero que un cobrador le entrega a otro (por ejemplo, para que compre el regalo).

- Fecha, quién entrega, quién recibe, importe y una nota opcional. No se puede traspasar a uno mismo.
- **No cambian el total recaudado**, solo quién lo tiene.

En ambas: los apunta cualquiera sin contraseña, se editan en la propia celda, al eliminar se puede **Deshacer**, y <kbd>Ctrl</kbd>+<kbd>N</kbd> salta a la fila de alta de la pestaña abierta.

**¿Dónde está el dinero?** muestra, para cada cobrador, lo que debería tener ahora:

```
saldo = cobrado − gastado + traspasado de otros − traspasado a otros
```

La suma de todos los saldos es siempre `cobrado − gastado` (hay una prueba automática que lo comprueba). De lo cobrado se indica además cuánto fue en efectivo y cuánto por Bizum.

No se puede eliminar un cobrador que tenga cobros, gastos o traspasos asignados.

## Varios equipos a la vez

Todos ejecutan **el mismo `celebracion.exe` desde una carpeta de red** y comparten la base de datos **`celebracion.db`, que se crea junto al exe** la primera vez que alguien lo abre. No hay nada que configurar.

```
\\servidor\Comun\Celebraciones\
├── celebracion.exe
├── celebracion.db          ← se crea sola; la comparten todos
└── celebracion.ini         ← opcional
```

Requisitos de la carpeta:

- Todos los usuarios necesitan **permiso de escritura en la carpeta** (no solo en el archivo): SQLite crea ahí un archivo temporal `celebracion.db-journal` en cada guardado.
- Si la carpeta del programa debe ser de solo lectura, crea junto al exe un `celebracion.ini` que apunte a otra carpeta con escritura (ver `celebracion.ini.ejemplo`):

  ```ini
  datos=\\servidor\Comun\Celebraciones\datos\celebracion.db
  ```

  Admite rutas relativas a la carpeta del exe y rutas que terminen en `\` (se usa `celebracion.db` dentro).
- No uses carpetas sincronizadas (OneDrive, Dropbox, Google Drive): tiene que ser una carpeta compartida de red real.

Cómo se evita que los datos se pisen:

- Lectura simultánea sin límite práctico; las escrituras se hacen de una en una y duran milisegundos (espera de hasta 8 s si otro equipo está guardando).
- Cada equipo comprueba cada 2,5 s si otro ha guardado algo (`PRAGMA data_version`) y recarga; las filas cambiadas por otro se iluminan.
- Si dos equipos pulsan **Cobrar** sobre la misma persona, el segundo recibe un aviso y **no se cobra dos veces** (comprobación dentro de una transacción `BEGIN IMMEDIATE`).
- Editar nombre, modalidad o notas guarda solo ese campo.
- SQLite en modo de diario clásico (`journal_mode=DELETE`; el WAL no funciona en red) y escritura síncrona completa.
- Si la carpeta deja de estar accesible, aparece **Sin conexión**, se bloquea la edición y se reconecta solo. Nunca se crea una base local aparte (se partirían los datos).
- El indicador verde de la cabecera muestra cuántos equipos están conectados; al pulsarlo, cuáles.
- La contraseña de administrador está en la base compartida (la misma para todos); el modo administrador es de cada equipo.

Ejecutar desde la red en Windows:

- Si el servidor no está en la zona *Intranet local*, Windows puede mostrar la advertencia de seguridad de archivo de red al abrir el exe. Se evita añadiéndolo a la zona Intranet por GPO.
- Mientras alguien tenga el programa abierto, el exe no se puede sobrescribir: para actualizar, que todos lo cierren (o renombra el antiguo y copia el nuevo).

### Datos de versiones anteriores

Hasta la v0.3 los datos se guardaban en cada equipo (`%APPDATA%\<identificador>\celebracion.db`). Si un equipo tiene esa base con personas y la compartida está vacía, al abrir el programa se ofrece **importarla** una sola vez (precios, contraseña, cobradores y participantes con su estado de pago). El archivo antiguo no se borra: se renombra a `celebracion-antigua-importada.db` o `celebracion-antigua-sin-importar.db`.

## Licencia

© 2026 Mariano Ortuño. Software libre bajo la licencia [GNU GPL v3 o posterior](LICENSE).
