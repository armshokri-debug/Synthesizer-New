/* SY-1 service worker: precaches the whole app at install so it runs offline.
   The build (vite.config.ts) replaces the two placeholders below with the real
   version and file list. In dev the list is empty and everything is network-first. */
const VERSION = "tehran-performance-v7";
const FILES = ["./","assets/aistudio/Gemini_Generated_Image_8sjh2g8sjh2g8sjh_c840e6f2.jpeg","assets/aistudio/IMG_4943_4522bed8.PNG","assets/aistudio/IMG_4945_12fedd6c.JPG","assets/aistudio/IMG_4949_c476b5ab.JPG","assets/aistudio/IMG_4952_8a2205ab.JPG","assets/aistudio/IMG_4955_2fb97862.JPG","assets/aistudio/IMG_4957_5d39307e.JPG","assets/aistudio/IMG_4959_f8e59a33.JPG","assets/aistudio/IMG_4961_3564609d.JPG","assets/aistudio/IMG_4963_42e487eb.JPG","assets/aistudio/IMG_4965_87a41b6b.JPG","assets/aistudio/IMG_4968_ecf74c13.JPG","assets/aistudio/IMG_4970_53afaf6c.JPG","assets/analog-processor-DbeC9J50.js","assets/bushehr-bell-DThxaA-8.png","assets/bushehr-ch-OT95_iE8.png","assets/bushehr-clap-D0fs1mgh.png","assets/bushehr-kick-CtWTyy8v.png","assets/bushehr-oh-BjwE_AgW.png","assets/bushehr-original-CLSrHWQO.png","assets/bushehr-rim-BWWg3484.png","assets/bushehr-snare-Bl5QB0I_.png","assets/bushehr-tom-BjcPxTFF.png","assets/fm-processor-PgiwPRq7.js","assets/index-tehran-performance-v3.css","assets/index-tehran-performance-v7.js","assets/strings-processor-bEBiGPV-.js","assets/sy1-processor-C-O7VLhR.js","assets/tehran-sunset-CBaztis-.svg","assets/tehran-night-df2559b93c.webp","assets/tehran-night-full-239a6dc1.webp","assets/vector-processor-DXL9c434.js","assets/yazd-windcatchers-DQjbfjqw.svg","assets/yazd-night-0c746f7daf.webp","assets/bam-day-94e1245c81.webp","assets/tabriz-twilight-345def3c87.webp","favicon.svg","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","icons/icon.svg","index.html","manifest.webmanifest"];
const CACHE = "sy1-" + VERSION;
const scope = self.registration.scope;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new URL(f, scope).href)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sy1-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !req.url.startsWith(scope)) return;

  // Page loads: try the network first (so updates arrive), fall back to the cached app shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(new URL("index.html", scope).href, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(new URL("index.html", scope).href).then((r) => r || caches.match(scope)))
    );
    return;
  }

  // Everything else (hashed assets, worklets, icons): cache first, network fallback.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
