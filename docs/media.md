# `FSOffline.Media` — cache de imágenes/medios

Cachea recursos estáticos pesados (imágenes de catálogo, etc.) para servirlos
online y offline **sin tocar las plantillas**: al usar un *Service Worker*, los
`<img src="...">` se resuelven solos. Es un mecanismo aparte del almacén key/value:
los datos siguen en IndexedDB y los medios van a la **Cache API** del Service
Worker. Dos cachés, dos problemas distintos.

← Volver al [README](../README.md) · relacionado: [architecture.md](architecture.md).

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

> En FacturaScripts, construye `patterns` y `fallback` con la función Twig `asset()`
> (`asset('MyFiles/CatalogoWebp/')` → `<route>/MyFiles/CatalogoWebp/`) para que sean
> correctos también en instalaciones en subdirectorio.

## API

| Método | Descripción |
| --- | --- |
| `Media.register(options)` | Registra el worker y persiste la config. Idempotente. Devuelve `null` (no-op) si el contexto no es seguro. |
| `Media.unregister(options)` | Quita la config del plugin; desregistra el worker si no queda ninguna config. |
| `Media.supported()` | `true` si hay Service Worker **y** contexto seguro. |

Opciones de `register()`: `cacheName`, `patterns` (prefijos de path), `ttl` (ms,
`null` = sin caducidad), `fallback` (URL), `maxEntries` (tope, `null`/`0` lo
desactiva), `id` (clave de config; por defecto `cacheName`).

## Requisito: contexto seguro

Un Service Worker solo se activa en **HTTPS** o en `http://localhost` /
`127.0.0.1`. Un dominio propio por HTTP plano (p. ej. `http://local.fs2025`) **no**
es contexto seguro, así que ahí `register()` no hace nada (degradación silenciosa,
sin romper la página). En producción HTTPS funciona con normalidad.

## El controlador `/MediaCache`

Un Service Worker solo controla las páginas dentro de su *scope*, y el scope por
defecto es la carpeta desde la que se sirve el archivo. Por eso el worker no se
sirve como asset estático sino a través del controlador `MediaCache`, que añade la
cabecera `Service-Worker-Allowed` para poder registrarlo en el scope de la raíz de
la instalación. Es un **controlador** corriente (no un Worker del Core: no tiene
relación con `Core/Worker/` ni la cola de eventos).

## Estrategia: cache-first + caducidad + fallback

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

## Por qué la config viaja por IndexedDB

El navegador mata y reinicia el Service Worker constantemente, así que su config no
puede vivir en memoria. `register()` la persiste en IndexedDB (store `media-config`,
una entrada por plugin) y el worker la lee desde ahí (solo lectura: nunca crea la
base). Mantiene un snapshot en memoria con refresco de 30 s, y `register()` además
avisa al worker para que recargue al instante. Si dos plugins registran medios,
**no** hay dos workers: hay uno y las configuraciones se acumulan.

Esa config se guarda en la base IndexedDB reservada **`FSOffline`** (store
`media-config`), independiente de las bases de los plugins consumidores. Ver
[architecture.md](architecture.md#la-base-indexeddb-reservada-fsoffline).

## Eviction, cuota y limpieza de versiones

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

> **Nota de cuota**: el límite real no es `maxEntries` sino la cuota de bytes del
> origen (en escritorio, GB; en iOS/Safari es mucho más estricto y desaloja con
> agresividad). Dimensiona pensando en MB totales (`maxEntries` × tamaño medio).
