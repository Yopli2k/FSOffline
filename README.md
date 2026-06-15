# FSOffline

Capa de abstracción sencilla, reutilizable y extensible sobre **IndexedDB** para plugins de FacturaScripts.

Oculta por completo los detalles de IndexedDB (`open`, `transaction`,
`objectStore`, ...) tras un modelo simple:

```
Database
 └─ Store (lógico)
     └─ Key => Value
```

## Cargar la librería

El consumidor solo necesita añadir **un único asset**, `FSOffline.js`.
FacturaScripts fusiona la carpeta `Assets/` en `Dinamic/Assets/` (incluidas las
subcarpetas), por lo que cualquier otro plugin puede cargarlo desde su
controlador:

```php
use FacturaScripts\Dinamic\Lib\AssetManager;
use FacturaScripts\Core\Tools;

AssetManager::add('js', Tools::config('route') . '/Dinamic/Assets/JS/FSOffline.js');
```

`FSOffline.js` carga **bajo demanda** sus clases internas mediante `import()`
dinámico, así que no hace falta añadir ningún otro `<script>` ni preocuparse del
orden de carga.

Para que esté disponible, el plugin que lo use debe declarar la dependencia en su
`facturascripts.ini`:

```ini
required = 'FSOffline'
```

## Estructura de archivos

```
Assets/JS/
├── FSOffline.js                  # Entry/fachada pública (único asset a cargar)
└── FSOffline/                    # Módulos ES privados, cargados por import()
    ├── IndexedDBDriver.js        # Envoltura de bajo nivel sobre IndexedDB
    ├── OfflineStore.js           # Store lógico (claves compuestas)
    └── OfflineDatabase.js        # Una base = un object store físico
```

Solo `FSOffline.js` es un script clásico. Los archivos de `FSOffline/` son
módulos ES (`export`) y **solo** se cargan vía `import()` dinámico desde la
fachada, lo que mantiene las clases internas fuera del objeto global.

## Uso

```javascript
// 1. Seleccionar (y crear si no existe) la base de datos activa.
await FSOffline.use('MyDatabase');

// 2. Trabajar con stores lógicos.
await FSOffline.store('products').set('REF001', product);

const product  = await FSOffline.store('products').get('REF001');
const products = await FSOffline.store('products').all();

await FSOffline.store('products').delete('REF001');
await FSOffline.store('products').clear();

// 3. Reutilizar una referencia al store.
const products = FSOffline.store('products');
await products.set('REF001', product);
await products.set('REF002', product2);

const item = await products.get('REF001');
const all  = await products.all();
```

## API pública

| Método | Descripción |
| --- | --- |
| `FSOffline.use(databaseName)` | Selecciona/crea la base de datos activa. `Promise`. |
| `FSOffline.store(storeName)` | Devuelve un store lógico de la base de datos activa. |
| `FSOffline.database()` | Nombre de la base de datos activa (o `null`). |
| `store.get(key)` | Valor de la clave, o `null` si no existe. `Promise`. |
| `store.set(key, value)` | Guarda el valor y lo devuelve. `Promise`. |
| `store.delete(key)` | Elimina una clave. `Promise`. |
| `store.all()` | Array con todos los valores del store. `Promise`. |
| `store.clear()` | Elimina solo los valores de ese store lógico. `Promise`. |

Todos los métodos son asíncronos y devuelven `Promise`.

## Capa de conexión (Connection + Http)

Además del almacén key/value, FSOffline ofrece una capa para centralizar las
peticiones de red y conocer en todo momento si hay conexión con el servidor.

```javascript
// 1. Arrancar una vez al cargar la app.
await FSOffline.connect();              // o connect({ pingTimeout: 4000, ... })

// 2. Estado de conexión (síncrono).
if (FSOffline.Connection.isOnline()) { /* ... */ }

// 3. Reaccionar a los cambios.
FSOffline.Connection.onChange(({ online }) => mostrarBanner(!online));
window.addEventListener('fsoffline:connection', e => console.log(e.detail.online));

// 4. Hacer peticiones por el gateway (nunca lanza; devuelve un Result).
const res = await FSOffline.Http.post(window.location.href, formData);
if (res.offline) { /* sin conexión: servir de cache */ }
else if (res.ok) { /* res.data */ }
```

### FSOffline.Connection

Fuente única del estado online/offline.

| Método | Descripción |
| --- | --- |
| `init(options)` | Configura (lo llama `connect()`). Idempotente. |
| `isOnline()` | `boolean` (síncrono). |
| `state()` | `'online'` \| `'offline'`. |
| `onChange(cb)` | Suscribe a cambios. Devuelve función para desuscribir. |
| `check()` | Fuerza un ping inmediato. `Promise<boolean>`. |

- Solo un **fallo de red real** (excepción de `fetch` o timeout) pasa a OFFLINE;
  una respuesta HTTP de error (4xx/5xx) significa servidor vivo → sigue ONLINE.
- La **recuperación** está desacoplada del negocio: temporizador con backoff
  `[10, 30, 60, 120, 300]s`, más el evento `online` del navegador, más un sondeo
  oportunista en actividad solo si pasó `probeMinGap` (30s) desde el último ping.

Opciones de `connect()` / `init()`: `pingUrl`, `pingTimeout` (4000), `backoff`,
`probeMinGap` (30000), `failureThreshold` (1), `startOnline`.

### FSOffline.Http

Único portal de salida a la red. Envuelve `fetch` con timeout, alimenta a
`Connection` y normaliza el resultado (nunca lanza).

| Método | Descripción |
| --- | --- |
| `request(url, options)` | `options`: `method, body, headers, timeout, signal, force`. |
| `get(url, options)` | Atajo GET. |
| `post(url, body, options)` | `body` `FormData` se envía tal cual; objeto plano → JSON. |

Result: `{ ok, status, data, networkError, offline, aborted, cancelled }`.
Si `Connection` está OFFLINE, `request()` **cortocircuita** y devuelve
`{ offline: true }` al instante (sin gastar el timeout), salvo que se pase
`force: true`.

### Endpoint de ping (servidor)

El controlador `AppPing` (`/AppPing`) responde un `204` sin cuerpo, sin auth, sin
plantillas y sin escribir nada (BD/log). Es el endpoint de comprobación que usa
`Connection` para confirmar que el servidor está vivo. La protección anti-DoS
corresponde a la infraestructura (rate limiting del proxy), no al controlador.

## Decisiones de diseño

- Cada nombre de base de datos se corresponde con una base de datos IndexedDB
  independiente, así varios plugins pueden coexistir
  (`PortalAgente`, `ComprasRemotas`, `GestionVeterinaria`, ...).
- Internamente, cada base de datos usa **un único object store físico**.
  Los stores lógicos se emulan mediante **claves compuestas** (`store:key`). Esto
  evita la creación dinámica de object stores y los problemas de versionado y migraciones de IndexedDB.
- La API pública nunca expone IndexedDB ni las clases internas
  (`IndexedDBDriver`, `OfflineDatabase`, `OfflineStore`). Al ser módulos ES
  cargados por `import()`, viven en scope de módulo y no en el objeto global.
- Cada responsabilidad vive en su propio archivo, así el proyecto escala sin que
  los archivos crezcan.

## Futuras ampliaciones

La arquitectura está preparada para añadir nuevas responsabilidades como módulos
ES dentro de `Assets/JS/FSOffline/`, cargados con `import()` desde la fachada
(igual que hace `loadCore()`), sin romper la API pública:

```javascript
FSOffline.Cache
FSOffline.Queue
FSOffline.Sync
```

Cada extensión debe apoyarse únicamente en la API pública
(`FSOffline.use` / `FSOffline.store` / `FSOffline.Connection` / `FSOffline.Http`),
manteniendo las clases internas privadas.
