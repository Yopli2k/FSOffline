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

Este plugin solo aporta el archivo `Assets/JS/FSOffline.js`. FacturaScripts lo
fusiona automáticamente en `Dinamic/Assets/JS/FSOffline.js`, por lo que cualquier
otro plugin puede cargarlo desde su controlador:

```php
use FacturaScripts\Dinamic\Lib\AssetManager;
use FacturaScripts\Core\Tools;

AssetManager::add('js', Tools::config('route') . '/Dinamic/Assets/JS/FSOffline.js');
```

Para que esté disponible, el plugin que lo use debe declarar la dependencia en su
`facturascripts.ini`:

```ini
required = 'FSOffline'
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

## Decisiones de diseño

- Cada nombre de base de datos se corresponde con una base de datos IndexedDB
  independiente, así varios plugins pueden coexistir
  (`PortalAgente`, `ComprasRemotas`, `GestionVeterinaria`, ...).
- Internamente, cada base de datos usa **un único object store físico**.
  Los stores lógicos se emulan mediante **claves compuestas** (`store:key`). Esto
  evita la creación dinámica de object stores y los problemas de versionado y migraciones de IndexedDB.
- La API pública nunca expone IndexedDB ni las clases internas
  (`IndexedDBDriver`, `OfflineDatabase`, `OfflineStore`).

## Futuras ampliaciones

La arquitectura está preparada para añadir, en archivos separados y sin romper la
API pública, extensiones como:

```javascript
FSOffline.Cache
FSOffline.Queue
FSOffline.Sync
FSOffline.Connection
```
