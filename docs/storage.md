# Almacén key/value (`use` / `store`)

La base de FSOffline: un almacén key/value sobre IndexedDB que oculta por completo
sus detalles (`open`, `transaction`, `objectStore`, ...) tras un modelo simple.
Funciona **sin** `FSOffline.connect()`.

← Volver al [README](../README.md) · ver [arquitectura](architecture.md).

```
Database
 └─ Store (lógico)
     └─ Key => Value
```

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

## Modelo físico

Cada nombre de base de datos es una base IndexedDB independiente. Dentro, hay **un
único object store físico** (`keyValueStore`) y los stores lógicos se emulan con
**claves compuestas** (`store:key`). Esto evita crear object stores dinámicamente y
los problemas de versionado/migración de IndexedDB. Detalles en
[architecture.md](architecture.md).

> No uses la base reservada `FSOffline` para tus datos: crea la tuya con
> `FSOffline.use('TuPlugin')`. Ver [architecture.md](architecture.md#la-base-indexeddb-reservada-fsoffline).
