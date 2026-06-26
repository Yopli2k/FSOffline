# Arquitectura

Cómo está organizado FSOffline por dentro: estructura de archivos, qué es un
módulo y qué no, dónde guarda cada cosa y las decisiones de diseño.

← Volver al [README](../README.md).

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
    ├── media-worker.js           # Service worker de la cache de medios (NO es módulo ES)
    └── Sync.js                   # Reenvío de la cola de escrituras offline (módulo ES)
Controller/
├── AppPing.php                   # Endpoint /AppPing (ping de Connection)
└── MediaCache.php                # Sirve el service worker de Media (ruta /MediaCache)
```

`FSOffline.js` es el único script clásico (`<script>`). La carpeta `FSOffline/`
reúne dos tipos de archivo distintos según **quién los carga**, no según dónde
estén:

- **Módulos ES privados** (`IndexedDBDriver`, `OfflineStore`, `OfflineDatabase`,
  `Connection`, `Http`, `Cache`, `Media`, `Sync`): la fachada los carga
  **nombrándolos uno a uno** con `import()` dinámico. No hay autodescubrimiento de la
  carpeta; un archivo que nadie nombra en un `import()` nunca se carga como módulo.
  Así las clases internas viven en scope de módulo y no en el objeto global.
- **El service worker** (`media-worker.js`): **no** es un módulo ES y **no** se
  carga con `import()`. Lo ejecuta el runtime de Service Worker del navegador,
  servido por el controlador `/MediaCache`. Vive aquí solo por cohesión con
  `Media.js`; su presencia en la carpeta no provoca que nada lo cargue.

## Arranque (`connect()`)

`await FSOffline.connect()` se llama una vez al cargar la app. Hace un único
`import()` de `Http.js` (que reexporta `Connection` y `Cache` con instancia
compartida), publica `FSOffline.Http` / `FSOffline.Connection` / `FSOffline.Cache`,
configura `Cache` con el resolutor de stores e inicializa `Connection`. Después
importa `Media.js` y publica `FSOffline.Media`, y luego importa `Sync.js`, publica
`FSOffline.Sync` y lo configura (inyectándole los singletons `Http` / `Connection` y
el resolutor de stores). Tras `connect()`, todo está disponible de forma síncrona.

El almacén key/value (`use`/`store`) funciona **sin** `connect()`: es la base sobre
la que se apoyan las demás piezas.

## La base IndexedDB reservada `FSOffline`

El plugin reserva para sí una base IndexedDB con su propio nombre, **`FSOffline`**,
para su **contabilidad interna**. De momento solo guarda la config de medios (store
lógico `media-config`, ver [media.md](media.md)).

Es **independiente** de las bases de los plugins consumidores —las que creas con
`FSOffline.use('PortalAgente')`, etc.—, que guardan ahí sus datos de negocio. Si
inspeccionas IndexedDB en el navegador y ves una base `FSOffline`, es esto: el
registro interno, no datos de ningún plugin. No uses esta base para tu plugin: crea
la tuya con `FSOffline.use('TuPlugin')`.

## Decisiones de diseño

- Cada nombre de base de datos se corresponde con una base de datos IndexedDB
  independiente, así varios plugins pueden coexistir
  (`PortalAgente`, `ComprasRemotas`, `GestionVeterinaria`, ...).
- Internamente, cada base de datos usa **un único object store físico**
  (`keyValueStore`). Los stores lógicos se emulan mediante **claves compuestas**
  (`store:key`). Esto evita la creación dinámica de object stores y los problemas de
  versionado y migraciones de IndexedDB.
- La API pública nunca expone IndexedDB ni las clases internas
  (`IndexedDBDriver`, `OfflineDatabase`, `OfflineStore`). Al ser módulos ES
  cargados por `import()`, viven en scope de módulo y no en el objeto global.
- El plugin se **reserva** la base `FSOffline` para su contabilidad interna (ver
  arriba).
- Los **datos** y los **medios** usan mecanismos distintos a propósito: los datos
  van a IndexedDB (`use`/`store`/`Cache`) y las imágenes a la **Cache API** del
  Service Worker (`Media`). Son dos almacenes separados porque resuelven problemas
  distintos (estructura key/value vs. respuestas HTTP para `<img>`).
- Cada responsabilidad vive en su propio archivo, así el proyecto escala sin que
  los archivos crezcan.

## Futuras mejoras

La arquitectura está preparada para añadir nuevas responsabilidades como módulos
ES dentro de `Assets/JS/FSOffline/`, cargados con `import()` desde la fachada
(igual que hace `loadCore()`), sin romper la API pública. Cada extensión debe
apoyarse únicamente en la API pública (`FSOffline.use` / `FSOffline.store` /
`FSOffline.Connection` / `FSOffline.Http` / `FSOffline.Cache` / `FSOffline.Media` /
`FSOffline.Sync`), manteniendo las clases internas privadas.
