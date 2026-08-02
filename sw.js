/* Servicio de caché de Servitel.
 *
 * Objetivo: que baste con abrir la página UNA vez en una red que funcione para que
 * siga funcionando después en una red que bloquee dominios externos, o sin conexión.
 *
 * Tres estrategias según el tipo de fichero:
 *   - Programa (index.html, manifest): red primero, caché como respaldo. Así el
 *     comercial recibe las mejoras sin tener que borrar nada.
 *   - Datos del índice (vectores, fichas, info): caché primero. Son 16 MB que solo
 *     cambian cuando se publica un catálogo nuevo.
 *   - Miniaturas y modelo: caché primero, y se van guardando a medida que se usan.
 */

const VERSION = 'servitel-v1';
const PROGRAMA = `${VERSION}-programa`;
const DATOS = `${VERSION}-datos`;
const MEDIOS = `${VERSION}-medios`;

// Lo imprescindible para arrancar. Las miniaturas y el modelo se guardan al usarlos:
// precargarlos aquí serían 190 MB de golpe y una instalación que falla entera si uno falla.
const ESENCIALES = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(PROGRAMA)
      .then((c) => c.addAll(ESENCIALES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // sin conexión en la instalación: no bloquea
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

/** Caché primero: si está guardado se sirve al instante; si no, se descarga y se guarda. */
async function cachePrimero(peticion, almacen) {
  const cache = await caches.open(almacen);
  const guardada = await cache.match(peticion, { ignoreVary: true });
  if (guardada) return guardada;
  const respuesta = await fetch(peticion);
  // Las respuestas opacas (otro dominio, sin CORS) también se guardan: no se puede
  // leer su estado, pero el navegador las reutiliza igual.
  if (respuesta && (respuesta.ok || respuesta.type === 'opaque')) {
    cache.put(peticion, respuesta.clone()).catch(() => {});
  }
  return respuesta;
}

/** Red primero: para el programa, así las mejoras llegan solas. */
async function redPrimero(peticion, almacen) {
  const cache = await caches.open(almacen);
  try {
    const respuesta = await fetch(peticion);
    if (respuesta && respuesta.ok) cache.put(peticion, respuesta.clone()).catch(() => {});
    return respuesta;
  } catch (e) {
    const guardada = await cache.match(peticion, { ignoreVary: true });
    if (guardada) return guardada;
    throw e;
  }
}

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  if (peticion.method !== 'GET') return;

  const url = new URL(peticion.url);
  const propio = url.origin === self.location.origin;
  const ruta = url.pathname;

  // Modelo y librería: vienen de otro dominio y son lo más pesado y lo más probable
  // que una red corporativa bloquee. Guardarlos es justo el objetivo de todo esto.
  if (!propio) {
    if (/huggingface\.co|hf\.co|cdn\.jsdelivr\.net|unpkg\.com/.test(url.hostname)) {
      evento.respondWith(cachePrimero(peticion, MEDIOS));
    }
    return;   // cualquier otro dominio: sin tocar
  }

  if (/\/datos\/(vectores\.f32|fichas\.json|info\.json)$/.test(ruta)) {
    evento.respondWith(cachePrimero(peticion, DATOS));
  } else if (/\/datos\/miniaturas\//.test(ruta)) {
    evento.respondWith(cachePrimero(peticion, MEDIOS));
  } else {
    evento.respondWith(redPrimero(peticion, PROGRAMA));
  }
});

// Permite a la página preguntar cuánto hay guardado, para poder decírselo al comercial
self.addEventListener('message', async (evento) => {
  if (evento.data !== 'estado-cache') return;
  const nombres = await caches.keys();
  let ficheros = 0;
  for (const n of nombres.filter((x) => x.startsWith(VERSION))) {
    ficheros += (await (await caches.open(n)).keys()).length;
  }
  let bytes = 0;
  if (navigator.storage?.estimate) {
    bytes = (await navigator.storage.estimate()).usage || 0;
  }
  evento.source?.postMessage({ tipo: 'estado-cache', ficheros, bytes });
});
