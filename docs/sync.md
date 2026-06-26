# `FSOffline.Sync`

Reenvía la **cola de escrituras offline** (`__queue__`) cuando vuelve la conexión y
deja que el plugin **reconcilie** con el servidor, que es la fuente de verdad. No es
un `fetch` congelado: guarda una *foto serializable* de cada petición y la **vuelve
a lanzar** en orden al reconectar.

← Volver al [README](../README.md) · relacionado: [http.md](http.md), [connection.md](connection.md).

```javascript
// Una vez (al arrancar la app):
await FSOffline.connect();   // publica y configura Sync

// El plugin registra su base para sincronizar:
FSOffline.Sync.register('PortalAgente', {
    // Reconciliar: releer el estado autoritativo y PARCHEAR la vista en sitio
    // (nunca recargar la página: el usuario no debe perder dónde estaba).
    onComplete: async (summary) => { await PortalAgente.reloadOrder(); },
    // Avisar de una escritura que el servidor rechazó (queda en el buzón de fallidas).
    onFailed: (entry, result) => PortalAgente.setMessage('Un cambio no se pudo guardar', true)
});
```

## Qué guarda y qué reenvía

La cola la llena [`FSOffline.Http`](http.md) cuando una escritura ocurre offline con
`offline.queue: true`. Cada entrada es una foto serializable (IndexedDB no puede
guardar funciones ni `FormData`):

```javascript
{ id, url, method, body, ts }
```

Al reconectar, Sync recorre la cola **en orden FIFO** (por `ts`), reconstruye cada
petición (rearma el `FormData` desde `body`) y la reenvía por `Http`. Una entrada
**solo sale de la cola cuando el servidor confirma** que la guardó.

## API

| Método | Descripción |
| --- | --- |
| `register(db, hooks)` | Da de alta una base para sincronizar (ver hooks abajo). |
| `unregister(db)` | Deja de sincronizar (no toca la cola ni el buzón). |
| `sync(db)` | Fuerza un reenvío ya (p. ej. un botón "reintentar"). `Promise<summary>`. |
| `pending(db)` | Nº de escrituras aún en cola (exacto). `Promise<number>`. |
| `hasPending()` | ¿Hay pendientes en cualquier base? **Síncrono** (para el `beforeunload`). |
| `failed(db)` | Escrituras del buzón de fallidas (servidor las rechazó). `Promise<Array>`. |
| `dismissFailed(db, id)` | Descarta una entrada fallida tras revisarla. |

`summary` = `{ db, removed, failed, kept }`.

## Hooks de `register(db, hooks)`

Todos opcionales. FSOffline pone el **mecanismo**; estos hooks ponen la **semántica**.

| Hook | Para qué | Por defecto |
| --- | --- | --- |
| `resend(entry)` | Cómo reenviar una escritura. Devuelve un Result tipo Http. | Rearma `FormData` desde `entry.body` y hace `POST` por `Http`. |
| `resolve(entry, result)` | Qué significa la respuesta: `'remove' \| 'keep' \| 'fail' \| 'drop'`. | Política por defecto (abajo). |
| `onComplete(summary)` | Reconciliar tras tocar el servidor (≥1 `removed`/`failed`). | — |
| `onFailed(entry, result)` | Avisar de una escritura aparcada en el buzón de fallidas. | — |
| `auto` | Reenviar solo al reconectar. | `true` |

### Política por defecto (por entrada reenviada)

- **`ok` (2xx)** → `remove`: el servidor la aceptó, ya está a salvo.
- **`networkError` / `offline`** → `keep` y **parar**: fallo transitorio; se reintenta
  en la próxima reconexión, preservando el orden FIFO.
- **cualquier otra (4xx/5xx…)** → `fail`: el servidor la rechazó. La entrada se mueve
  al **buzón de fallidas** y se avisa (`onFailed`), **no se descarta en silencio**.

> El callback de éxito del `fetch` original (el que actualizaba la pantalla) **no se
> reejecuta**: ya actualizaste la vista de forma optimista cuando el usuario hizo la
> acción offline. Al reenviar solo importa una **reconciliación** holística
> (`onComplete`), que parchea la vista contra la verdad del servidor sin recargar.

## Reenvío "al menos una vez": haz las acciones idempotentes

Una entrada se borra **después** de confirmarse. Si el servidor la procesó pero la
respuesta se perdió (o se recargó la página justo antes de borrarla), se reintentará
→ podría aplicarse **dos veces**. Diseña las acciones del servidor de forma
idempotente (p. ej. *"fijar cantidad a 5"* en vez de *"sumar 1"*), o deja que la
reconciliación corrija el duplicado.

## Durabilidad

Los datos pendientes son **datos de negocio**: dentro del mismo navegador/dispositivo
no se pierden por nada que dependa de FSOffline.

- **Borrado solo tras confirmación.** Una entrada sale de `__queue__` cuando el
  servidor la acepta (`removed`) o se aparta para revisión (`failed`). La cola nunca
  se vacía a ciegas.
- **Almacenamiento persistente.** Al configurarse, Sync pide
  `navigator.storage.persist()` para que el navegador **no desaloje** IndexedDB bajo
  presión de espacio (el mayor riesgo, sobre todo en iOS/Safari). Es *best effort*:
  el navegador puede declinar.
- **Aviso al salir.** Un guard de `beforeunload` avisa si se intenta salir con
  escrituras sin enviar (`hasPending()`). Los navegadores muestran su mensaje
  genérico. Desactivable con `configure({ guardUnload: false })`.
- **Indicador de pendientes.** Sync emite `fsoffline:queue-changed`
  (`{ db, pending }`) al encolar y al reenviar, para que el plugin pinte un indicador
  "N sin enviar" donde quiera.

Queda **fuera** del control de FSOffline (responsabilidad del usuario): modo
incógnito, cambiar de dispositivo/navegador y borrar los datos del sitio a mano.

## Eventos

| Evento (en `window`) | Lo emite | Detalle |
| --- | --- | --- |
| `fsoffline:enqueued` | `Http` al encolar una escritura. | `{ db }` |
| `fsoffline:queue-changed` | `Sync` al cambiar el tamaño de una cola. | `{ db, pending }` |

## Recarga estando offline: rehidratar

La cola y el estado local sobreviven a recargas (IndexedDB es persistente). Si el
usuario recarga **sin conexión**, la pantalla arranca vacía pero el dato sigue en
local: el plugin debe **rehidratar** la vista desde su almacén antes de que el usuario
crea que perdió su trabajo. Al volver la conexión, `register()` dispara un reenvío
inicial que vacía los restos de la sesión anterior.
