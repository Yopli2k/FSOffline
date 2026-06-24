# `FSOffline.Connection`

Fuente única del estado online/offline. Se inicializa con `FSOffline.connect()` y
sabe en todo momento si hay conexión con el servidor.

← Volver al [README](../README.md) · relacionado: [http.md](http.md).

```javascript
// Estado de conexión (síncrono).
if (FSOffline.Connection.isOnline()) { /* ... */ }

// Reaccionar a los cambios.
FSOffline.Connection.onChange(({ online }) => mostrarBanner(!online));
window.addEventListener('fsoffline:connection', e => console.log(e.detail.online));
```

## API

| Método | Descripción |
| --- | --- |
| `init(options)` | Configura (lo llama `connect()`). Idempotente. |
| `isOnline()` | `boolean` (síncrono). |
| `state()` | `'online'` \| `'offline'`. |
| `onChange(cb)` | Suscribe a cambios. Devuelve función para desuscribir. |
| `check()` | Fuerza un ping inmediato. `Promise<boolean>`. |

## Comportamiento

- Solo un **fallo de red real** (excepción de `fetch` o timeout) pasa a OFFLINE;
  una respuesta HTTP de error (4xx/5xx) significa servidor vivo → sigue ONLINE.
- La **recuperación** está desacoplada del negocio: temporizador con backoff
  `[10, 30, 60, 120, 300]s`, más el evento `online` del navegador, más un sondeo
  oportunista en actividad solo si pasó `probeMinGap` (30s) desde el último ping.

Opciones de `connect()` / `init()`: `pingUrl`, `pingTimeout` (4000), `backoff`,
`probeMinGap` (30000), `failureThreshold` (1), `startOnline`.

## Endpoint de ping (servidor)

El controlador `AppPing` (`/AppPing`) responde un `204` sin cuerpo, sin auth, sin
plantillas y sin escribir nada (BD/log). Es el endpoint de comprobación que usa
`Connection` para confirmar que el servidor está vivo. La protección anti-DoS
corresponde a la infraestructura (rate limiting del proxy), no al controlador.
