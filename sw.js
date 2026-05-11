diff --git a/C:\Users\tinam\Documents\New project\sw.js b/C:\Users\tinam\Documents\New project\sw.js
new file mode 100644
--- /dev/null
+++ b/C:\Users\tinam\Documents\New project\sw.js
@@ -0,0 +1,62 @@
+const CACHE_NAME = 'shotx-cache-v2';
+const CORE_ASSETS = [
+  './',
+  './index.html',
+  './app.js',
+  './manifest.json',
+  './logo/shotx.png'
+];
+const OPTIONAL_ASSETS = [
+  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
+];
+
+self.addEventListener('install', (event) => {
+  event.waitUntil(
+    caches.open(CACHE_NAME)
+      .then(async (cache) => {
+        await cache.addAll(CORE_ASSETS);
+        await Promise.allSettled(OPTIONAL_ASSETS.map((asset) => cache.add(asset)));
+      })
+      .then(() => self.skipWaiting())
+  );
+});
+
+self.addEventListener('activate', (event) => {
+  event.waitUntil(
+    caches.keys()
+      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
+      .then(() => self.clients.claim())
+  );
+});
+
+self.addEventListener('fetch', (event) => {
+  const req = event.request;
+  if (req.method !== 'GET') return;
+
+  if (req.mode === 'navigate') {
+    event.respondWith(
+      fetch(req)
+        .then((res) => {
+          const copy = res.clone();
+          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
+          return res;
+        })
+        .catch(() => caches.match('./index.html'))
+    );
+    return;
+  }
+
+  event.respondWith(
+    caches.match(req).then((cached) => {
+      const network = fetch(req)
+        .then((res) => {
+          if (res && res.status === 200 && (req.url.startsWith(self.location.origin) || req.url.includes('cdnjs.cloudflare.com'))) {
+            caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
+          }
+          return res;
+        })
+        .catch(() => cached);
+      return cached || network;
+    })
+  );
+});
