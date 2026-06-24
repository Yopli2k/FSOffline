# FSOffline

Conjunto de utilidades **reutilizables** para dar soporte *offline* a plugins de
FacturaScripts. Empezó como una capa sobre IndexedDB y hoy reúne cinco piezas que
el plugin consumidor usa desde un único asset (`FSOffline.js`):

| Pieza | Para qué sirve |
| --- | --- |
| `FSOffline.use` / `store` | Almacén key/value sobre IndexedDB (oculta `open`/`transaction`/`objectStore`). |
| `FSOffline.Connection` | Estado online/offline fiable (ping al servidor, histéresis y recuperación). |
| `FSOffline.Http` | Único gateway de red: envuelve `fetch`, alimenta a `Connection` y nunca lanza. |
| `FSOffline.Cache` | Cache de respuestas key/value con TTL (lecturas de respaldo + escrituras locales). |
| `FSOffline.Media` | Cache de imágenes/medios para online y offline mediante un *Service Worker*. |

Todo arranca con `await FSOffline.connect()` una vez al cargar la app (publica
`Connection`, `Http`, `Cache` y `Media`); el almacén key/value (`use`/`store`)
funciona por sí solo sin `connect()`. Salvo `Media` (que exige *Service Worker* y
contexto seguro), el resto funciona también en HTTP plano.

El almacén key/value sigue un modelo simple:

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
└── FSOffline/                    # Implementación interna de la capa offline
    ├── IndexedDBDriver.js        # Envoltura de bajo nivel sobre IndexedDB
    ├── OfflineStore.js           # Store lógico (claves compuestas)
    ├── OfflineDatabase.js        # Una base = un object store físico
    ├── Connection.js             # Estado online/offline (módulo ES)
    ├── Http.js                   # Gateway de red + cache de lectura (módulo ES)
    ├── Cache.js                  # Cache key/value con TTL (módulo ES)
    ├── Media.js                  # Gestor de la cache de medios (módulo ES)
    └── media-worker.js           # Service worker de la cache de medios (NO es módulo ES)
```

`FSOffline.js` es el único script clásico (`<script>`). La carpeta `FSOffline/`
reúne dos tipos de archivo distintos según **quién los carga**, no según dónde
estén:

- **Módulos ES privados** (`IndexedDBDriver`, `OfflineStore`, `OfflineDatabase`,
  `Connection`, `Http`, `Cache`, `Media`): la fachada los carga **nombrándolos
  uno a uno** con `import()` dinámico. No hay autodescubrimiento de la carpeta; un
  archivo que nadie nombra en un `import()` nunca se carga como módulo. Así las
  clases internas viven en scope de módulo y no en el objeto global.
- **El service worker** (`media-worker.js`): **no** es un módulo ES y **no** se
  carga con `import()`. Lo ejecuta el runtime de Service Worker del navegador,
  servido por el controlador `/MediaCache`. Vive aquí solo por cohesión con
  `Media.js`; su presencia en la carpeta no provoca que nada lo cargue.

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
| `request(url, options)` | `options`: `method, body, headers, timeout, signal, force` (+ `cache` / `offline`, ver «Cache de lectura y escrituras offline»). |
| `get(url, options)` | Atajo GET. |
| `post(url, body, options)` | `body` `FormData` se envía tal cual; objeto plano → JSON. |

Result: `{ ok, status, data, networkError, offline, fromCache, applied, aborted, cancelled }`.
Si `Connection` está OFFLINE, `request()` **cortocircuita** y devuelve
`{ offline: true }` al instante (sin gastar el timeout), salvo que se pase
`force: true`.

### Endpoint de ping (servidor)

El controlador `AppPing` (`/AppPing`) responde un `204` sin cuerpo, sin auth, sin
plantillas y sin escribir nada (BD/log). Es el endpoint de comprobación que usa
`Connection` para confirmar que el servidor está vivo. La protección anti-DoS
corresponde a la infraestructura (rate limiting del proxy), no al controlador.

## Cache de lectura y escrituras offline

Sobre `Http` se montan dos políticas, declaradas **por petición**: la lectura se
cachea sola y la escritura se aplica en local cuando no hay servidor.

### Lectura: `cache` spec (network-first)

```javascript
const res = await FSOffline.Http.post(url, formData, {
    cache: { db: 'PortalAgente', store: 'catalog', key: 'section:5', ttl: 3600000 }
    //   key: string | (url, options) => string ; ttl opcional ; transform opcional
});
// res.fromCache === true cuando viene de la cache (offline o fallo de red)
```

- **Online**: se pide al servidor y, si responde OK, se guarda en cache.
- **Offline / fallo de red**: se sirve de cache (aunque esté caducada).
- Solo es cache de respaldo: online siempre va a la red (network-first).

### Escritura: `offline` hook

```javascript
await FSOffline.Http.post(url, formData, {
    offline: {
        db: 'PortalAgente', store: 'order',
        apply: async (ctx) => {
            // ctx.body  = campos de la petición ya parseados a objeto
            // ctx.store = store key/value plano (sin TTL) para el estado de dominio
            const order = await ctx.store.get(ctx.body.idorder) || { idorder: ctx.body.idorder, lines: [] };
            // ... mutar order con ctx.body ...
            await ctx.store.set(order.idorder, order);
            return { error: false, order };   // respuesta sintética para tu onSuccess
        },
        queue: true   // registra la escritura para el futuro FSOffline.Sync
    }
});
```

Cuando no se alcanza el servidor (offline o fallo de red) y hay `offline.apply`,
FSOffline llama a tu callback para que mutes el estado local, y devuelve
`{ ok: true, data: <lo que devuelva apply>, fromCache: true, offline, applied: true }`.
Tu `onSuccess` distingue por `res.offline` / `res.applied` para repintar solo lo
que cambió. Online, no se llama a `apply`: la escritura va al servidor como siempre.

### FSOffline.Cache (bajo nivel)

| Método | Descripción |
| --- | --- |
| `Cache.scope(db, store)` | Handle de cache (con TTL) para ese `db`/`store`. |
| `scope.set(key, value, {ttl})` | Guarda con TTL opcional. |
| `scope.get(key, {allowStale})` | Valor, o `null` si falta/caducó (salvo `allowStale`). |
| `scope.delete(key)` / `scope.clear()` | Elimina una clave / todo el store. |
| `scope.prune()` | Elimina las entradas caducadas. Devuelve el nº borradas. |
| `Cache.rawStore(db, store)` | Store key/value **plano** (sin TTL), p.ej. el pedido. |

Cada entrada se guarda como `{ k, v, t, ttl }`. Apunta a `db`/`store` sin cambiar
la base activa, así varios plugins cachean en paralelo sin colisionar.

### Cola de escrituras (`__queue__`)

`queue: true` graba la escritura en el store `__queue__` de la base del plugin con
formato `{ id, url, method, body, ts }`. **Nadie la drena todavía**: el reenvío al
servidor y la reconciliación al reconectar son `FSOffline.Sync`, una fase posterior.

## Cache de medios (imágenes): `FSOffline.Media`

Cachea recursos estáticos pesados (imágenes de catálogo, etc.) para servirlos
online y offline **sin tocar las plantillas**: al usar un *Service Worker*, los
`<img src="...">` se resuelven solos. Es un mecanismo aparte del almacén
key/value: los datos siguen en IndexedDB y los medios van a la **Cache API** del
Service Worker. Dos cachés, dos problemas distintos.

FSOffline aporta el motor (este módulo + `media-worker.js` + el controlador
`/MediaCache` que lo sirve). Cada plugin aporta **su** configuración al registrar,
así el mismo motor vale para PortalAgente, ComprasRemotas, etc. sin rutas
hardcodeadas:

```javascript
// En el JS del plugin consumidor (PortalAgente, ...), tras FSOffline.connect().
await FSOffline.Media.register({
    cacheName: 'catalog-images-v1',
    patterns: ['/MyFiles/CatalogoWebp/', '/MyFiles/Catalogo/'], // prefijos a cachear
    ttl: 24 * 60 * 60 * 1000,                                   // frescura (cache-first)
    fallback: '/Dinamic/Assets/Images/no-image.webp',          // imagen de respaldo
    maxEntries: 5000                                            // tope de imágenes (eviction)
});

// Kill-switch: quita la config de este plugin y, si no queda ninguna, desregistra el worker.
await FSOffline.Media.unregister({ cacheName: 'catalog-images-v1' });
```

| Método | Descripción |
| --- | --- |
| `Media.register(options)` | Registra el worker y persiste la config. Idempotente. Devuelve `null` (no-op) si el contexto no es seguro. |
| `Media.unregister(options)` | Quita la config del plugin; desregistra el worker si no queda ninguna config. |
| `Media.supported()` | `true` si hay Service Worker **y** contexto seguro. |

### Requisito: contexto seguro

Un Service Worker solo se activa en **HTTPS** o en `http://localhost` /
`127.0.0.1`. Un dominio propio por HTTP plano (p. ej. `http://local.fs2025`) **no**
es contexto seguro, así que ahí `register()` no hace nada (degradación silenciosa,
sin romper la página). En producción HTTPS funciona con normalidad.

### El controlador `/MediaCache`

Un Service Worker solo controla las páginas dentro de su *scope*, y el scope por
defecto es la carpeta desde la que se sirve el archivo. Por eso el worker no se
sirve como asset estático sino a través del controlador `MediaCache`, que añade la
cabecera `Service-Worker-Allowed` para poder registrarlo en el scope de la raíz de
la instalación. Es un **controlador** corriente (no un Worker del Core: no tiene
relación con `Core/Worker/` ni la cola de eventos).

### Estrategia: cache-first + caducidad + fallback

Para cada imagen cuyo path empiece por uno de los `patterns`, el worker:

1. **Acierto fresco en caché** → la sirve sin tocar la red.
2. **Falta o caducada** (según `ttl`) → va a la red **con** el token original, guarda
   la respuesta y la sirve. Si `ttl` es `null`, no caduca por tiempo (cache-first
   hasta que se desaloje).
3. **Sin conexión / error de red** → sirve la copia *stale* si la hay; si no, el
   `fallback`; y como último recurso una respuesta de error (la `<img>` queda rota,
   nunca se lanza excepción).

La **clave de caché ignora el query string** (`stripToken`): la misma imagen se
guarda una sola vez aunque el token `?...` cambie, porque el token solo autoriza la
descarga, no identifica la imagen. La fecha de guardado se sella en una cabecera
`x-cached-at` para poder comprobar la caducidad (la Cache API no guarda fecha útil).

### Por qué la config viaja por IndexedDB

El navegador mata y reinicia el Service Worker constantemente, así que su config no
puede vivir en memoria. `register()` la persiste en IndexedDB (store `media-config`,
una entrada por plugin) y el worker la lee desde ahí (solo lectura: nunca crea la
base). Mantiene un snapshot en memoria con refresco de 30 s, y `register()` además
avisa al worker para que recargue al instante. Si dos plugins registran medios,
**no** hay dos workers: hay uno y las configuraciones se acumulan.

Esa config se guarda en una base IndexedDB llamada **`FSOffline`**, que el propio
plugin **reserva para su contabilidad interna** (de momento, solo `media-config`).
Es independiente de las bases de los plugins consumidores —las que tú creas con
`FSOffline.use('PortalAgente')`, etc.—, que guardan ahí sus datos de negocio. Si
inspeccionas IndexedDB en el navegador y ves una base `FSOffline`, es esto: el
registro de medios, no datos de ningún plugin.

### Eviction, cuota y limpieza de versiones

La Cache API no tiene LRU ni límite propio, así que el worker lo gestiona:

- **Tope de entradas** (`maxEntries`): tras cada escritura, si la caché supera el
  tope, borra las más antiguas primero (FIFO sobre `keys()`, que es orden de
  escritura ≈ menos recientemente escritas). `null`/`0` lo desactiva.
- **Presión de cuota**: si `navigator.storage.estimate()` indica que el uso del
  origen supera el 90 %, recorta ~10 % de las entradas más antiguas de esa caché.
- **No se purga por caducidad**: una entrada caducada **se conserva** porque sigue
  siendo el respaldo offline de esa imagen; la caducidad solo decide cuándo
  revalidar online, no cuándo borrar.
- **Limpieza de versiones**: cada caché nuestra lleva un centinela interno
  (`/__fsoffline-media-cache__`). Al activarse el worker (o al cambiar la config),
  borra **solo** nuestras cachés cuyo `cacheName` ya no esté en ninguna config
  (p. ej. al pasar de `...-v1` a `...-v2`). Nunca toca cachés de terceros y no borra
  nada si no hay config cargada (evita arrasar por una lectura vacía transitoria).
  La protección excluye de la eviction el centinela y la imagen de `fallback`.

> **Estado**: Fases 1, 2 y 3 implementadas. El subsistema Media está completo:
> registro en contexto seguro, controlador `/MediaCache`, persistencia de config,
> intercepción cache-first + caducidad + fallback (ignorando el token), y eviction
> por capacidad/cuota con limpieza de versiones.

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
- El plugin reserva para sí una base con su propio nombre, **`FSOffline`**, para su
  contabilidad interna (hoy, la config de medios en `media-config`). No la uses para
  datos de tu plugin: crea la tuya con `FSOffline.use('TuPlugin')`.
- Los **datos** y los **medios** usan mecanismos distintos a propósito: los datos
  van a IndexedDB (`use`/`store`/`Cache`) y las imágenes a la **Cache API** del
  Service Worker (`Media`). Son dos almacenes separados porque resuelven problemas
  distintos (estructura key/value vs. respuestas HTTP para `<img>`).
- Cada responsabilidad vive en su propio archivo, así el proyecto escala sin que
  los archivos crezcan.

## Futuras ampliaciones

La arquitectura está preparada para añadir nuevas responsabilidades como módulos
ES dentro de `Assets/JS/FSOffline/`, cargados con `import()` desde la fachada
(igual que hace `loadCore()`), sin romper la API pública:

```javascript
FSOffline.Sync   // reenvío de la cola de escrituras y reconciliación al reconectar
```

Cada extensión debe apoyarse únicamente en la API pública (`FSOffline.use` /
`FSOffline.store` / `FSOffline.Connection` / `FSOffline.Http` / `FSOffline.Cache`),
manteniendo las clases internas privadas.
