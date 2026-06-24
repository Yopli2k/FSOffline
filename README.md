# FSOffline

Conjunto de utilidades **reutilizables** para dar soporte *offline* a plugins de
FacturaScripts. Empezó como una capa sobre IndexedDB y hoy reúne cinco piezas que
el plugin consumidor usa desde un único asset (`FSOffline.js`):

| Pieza | Para qué sirve | Doc |
| --- | --- | --- |
| `FSOffline.use` / `store` | Almacén key/value sobre IndexedDB. | [storage.md](docs/storage.md) |
| `FSOffline.Connection` | Estado online/offline fiable (ping, histéresis, recuperación). | [connection.md](docs/connection.md) |
| `FSOffline.Http` | Único gateway de red: envuelve `fetch`, alimenta a `Connection`, nunca lanza. | [http.md](docs/http.md) |
| `FSOffline.Cache` | Cache de respuestas key/value con TTL. | [cache.md](docs/cache.md) |
| `FSOffline.Media` | Cache de imágenes/medios online y offline vía *Service Worker*. | [media.md](docs/media.md) |

Salvo `Media` (que exige *Service Worker* y contexto seguro), todo funciona también
en HTTP plano.

## Cargar la librería

El consumidor solo necesita añadir **un único asset**, `FSOffline.js`.
FacturaScripts fusiona la carpeta `Assets/` en `Dinamic/Assets/` (incluidas las
subcarpetas), por lo que cualquier otro plugin puede cargarlo desde su controlador:

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

## Quickstart

```javascript
// Almacén key/value (no necesita connect()).
await FSOffline.use('MyDatabase');
await FSOffline.store('products').set('REF001', product);
const product = await FSOffline.store('products').get('REF001');

// Capa de red / offline: arrancar una vez al cargar la app.
await FSOffline.connect();   // publica Connection, Http, Cache y Media

if (FSOffline.Connection.isOnline()) { /* ... */ }
FSOffline.Connection.onChange(({ online }) => mostrarBanner(!online));

// Petición por el gateway (nunca lanza; devuelve un Result).
const res = await FSOffline.Http.post(window.location.href, formData);

// Cache de imágenes vía Service Worker (HTTPS / localhost).
await FSOffline.Media.register({
    cacheName: 'catalog-images-v1',
    patterns: ['/MyFiles/CatalogoWebp/', '/MyFiles/Catalogo/'],
    ttl: 24 * 60 * 60 * 1000,
    fallback: '/Dinamic/Assets/Images/no-image.webp',
    maxEntries: 5000
});
```

## Documentación

- [architecture.md](docs/architecture.md) — estructura de archivos, módulo vs. service
  worker, la base reservada `FSOffline`, arranque y decisiones de diseño.
- [storage.md](docs/storage.md) — almacén key/value (`use` / `store`).
- [connection.md](docs/connection.md) — `FSOffline.Connection` + endpoint `/AppPing`.
- [http.md](docs/http.md) — `FSOffline.Http`, specs `cache` / `offline` y cola `__queue__`.
- [cache.md](docs/cache.md) — `FSOffline.Cache` (TTL, `scope`, `rawStore`).
- [media.md](docs/media.md) — `FSOffline.Media` (Service Worker, `/MediaCache`,
  estrategia, eviction, contexto seguro).

## Futuras mejoras

- `FSOffline.Sync` — drenar la cola `__queue__` (reenviar las escrituras al
  reconectar) y reconciliar con el servidor. Ver
  [http.md](docs/http.md#cola-de-escrituras-__queue__).
