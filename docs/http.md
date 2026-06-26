# `FSOffline.Http`

Único portal de salida a la red. Envuelve `fetch` con timeout, alimenta a
[`Connection`](connection.md) y normaliza el resultado (**nunca lanza**). Sobre él
se declaran, **por petición**, dos políticas: cache de lectura y escrituras offline.

← Volver al [README](../README.md) · relacionado: [connection.md](connection.md), [cache.md](cache.md).

```javascript
// Nunca lanza; devuelve un Result.
const res = await FSOffline.Http.post(window.location.href, formData);
if (res.offline) { /* sin conexión: servir de cache */ }
else if (res.ok) { /* res.data */ }
```

## API

| Método | Descripción |
| --- | --- |
| `request(url, options)` | `options`: `method, body, headers, timeout, signal, force` (+ `cache` / `offline`, abajo). |
| `get(url, options)` | Atajo GET. |
| `post(url, body, options)` | `body` `FormData` se envía tal cual; objeto plano → JSON. |

Result: `{ ok, status, data, networkError, offline, fromCache, applied, aborted, cancelled }`.

Si `Connection` está OFFLINE, `request()` **cortocircuita** y devuelve
`{ offline: true }` al instante (sin gastar el timeout), salvo que se pase
`force: true`.

## Lectura: `cache` spec (network-first)

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

El almacenamiento real lo hace [`FSOffline.Cache`](cache.md).

## Escritura: `offline` hook

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
        queue: true   // registra la escritura para que FSOffline.Sync la reenvíe
    }
});
```

Cuando no se alcanza el servidor (offline o fallo de red) y hay `offline.apply`,
FSOffline llama a tu callback para que mutes el estado local, y devuelve
`{ ok: true, data: <lo que devuelva apply>, fromCache: true, offline, applied: true }`.
Tu `onSuccess` distingue por `res.offline` / `res.applied` para repintar solo lo
que cambió. Online, no se llama a `apply`: la escritura va al servidor como siempre.

## Cola de escrituras (`__queue__`)

`queue: true` graba la escritura en el store `__queue__` de la base del plugin con
formato `{ id, url, method, body, ts }`, y emite el evento `fsoffline:enqueued`
(`{ db }`). Quien la **reenvía al servidor** al reconectar (en orden y con
reconciliación) es [`FSOffline.Sync`](sync.md).
