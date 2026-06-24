# `FSOffline.Cache`

Cache de respuestas key/value sobre el almacén de FSOffline, con **TTL** y pruning.
Es la pieza de bajo nivel que usan el spec `cache` y el hook `offline` de
[`Http`](http.md); también puedes usarla directamente.

← Volver al [README](../README.md) · relacionado: [http.md](http.md), [storage.md](storage.md).

## API

| Método | Descripción |
| --- | --- |
| `Cache.scope(db, store)` | Handle de cache (con TTL) para ese `db`/`store`. |
| `scope.set(key, value, {ttl})` | Guarda con TTL opcional. |
| `scope.get(key, {allowStale})` | Valor, o `null` si falta/caducó (salvo `allowStale`). |
| `scope.delete(key)` / `scope.clear()` | Elimina una clave / todo el store. |
| `scope.prune()` | Elimina las entradas caducadas. Devuelve el nº borradas. |
| `Cache.rawStore(db, store)` | Store key/value **plano** (sin TTL), p.ej. el pedido. |

## Funcionamiento

Cada entrada se guarda envuelta con metadatos para poder aplicar TTL y pruning:

```
{ k: <clave lógica>, v: <valor>, t: <guardado en ms>, ttl: <ms|null> }
```

Apunta a `db`/`store` **sin cambiar la base activa**, así varios plugins cachean en
paralelo sin colisionar. `rawStore()` devuelve el store sin el envoltorio de TTL,
para estado de dominio (p. ej. el pedido) que no debe caducar.

`get()` devuelve `null` si la entrada falta o caducó; con `{ allowStale: true }`
devuelve la caducada (la ruta de respaldo offline). `Cache` no expone IndexedDB:
resuelve el store a través del resolutor inyectado por la fachada en `connect()`.
