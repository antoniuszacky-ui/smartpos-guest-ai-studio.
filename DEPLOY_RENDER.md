# Panduan Deploy SmartPOS Guest ke Render Free (Tanpa Google Cloud Billing)

Dokumen ini menjelaskan langkah-langkah publikasi **SmartPOS Guest** ke **Render Free Web Service** agar memiliki URL publik HTTPS yang terhubung ke database **SmartPOS Owner** melalui backend **Express + Firebase Admin SDK**, tanpa mengaktifkan billing Google Cloud dan tanpa mengubah project SmartPOS Owner, Firestore Rules, ataupun IAM Owner.

---

## Ringkasan Arsitektur Produksi

- **Frontend (React + TypeScript + Vite + Tailwind CSS)**: Di-build ke folder `dist/` dan dilayani langsung oleh Express (`server.js`).
- **Backend API (Express Node.js)**: Berjalan di `server.js` (hasil kompilasi `server.ts`), melayani endpoint:
  - `GET /api/health` — Cek kesiapan layanan & konfigurasi non-sensitif (health check Render).
  - `GET /api/catalog` — Membaca produk aktif dari `stores/{STORE_ID}/products` (field `cost` tidak pernah dikirim ke browser).
  - `POST /api/guest-orders` — Validasi harga/stok di backend, idempotency key, `stockDeducted: false`, status awal `PENDING` ke `stores/{STORE_ID}/guest_orders/{orderId}`.
  - `GET /api/guest-orders/:orderNumber?phoneLast4=XXXX` — Pencarian status pesanan dengan verifikasi 4 digit terakhir WhatsApp dan rate limiting.
- **Database Owner (Firestore Named Database — Eksplisit & Fail-Closed)**:
  - `OWNER_FIREBASE_PROJECT_ID`: *(wajib disetel eksplisit per environment, tanpa fallback otomatis)*
  - `OWNER_FIRESTORE_DATABASE_ID`: *(wajib disetel eksplisit ke named database target per environment; nilai kosong atau `(default)` ditolak secara fail-closed)*
  - `STORE_ID`: *(wajib disetel eksplisit sesuai UID pemilik toko pada environment terkait)*
- **Keamanan Kredensial & Isolasi Environment**:
  - Frontend **tidak** pernah memegang private key maupun `STORE_ID` admin, serta tidak menulis langsung ke Firestore.
  - Kredensial Firebase Admin SDK (`FIREBASE_SERVICE_ACCOUNT_JSON` atau `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`) hanya disimpan sebagai Environment Variable rahasia di dashboard environment terkait.
  - Dokumen ini hanya referensi opsional hosting Render (bukan penetapan bahwa Render sudah menjadi environment staging aktif).
  - **Staging dan production wajib menggunakan konfigurasi, project/database, `STORE_ID`, dan kredensial yang sepenuhnya terpisah.** Jangan pernah menyalin konfigurasi atau kredensial production ke staging, dan jangan melakukan deploy sebelum isolasi environment terverifikasi serta otorisasi deploy diberikan.

---

## Langkah 1: Buat Service Account Key di Firebase Console (Gratis, Tanpa Billing GCP)

1. Buka [Firebase Console](https://console.firebase.google.com/) dan pilih project target environment Anda (**`<FIREBASE_PROJECT_ID_ENVIRONMENT_ANDA>`** — pastikan terpisah antara staging dan production).
2. Buka **Project Settings** (ikon gerigi) → tab **Service accounts**.
3. Pastikan SDK yang dipilih adalah **Node.js**, lalu klik **Generate new private key** → **Generate key**.
   - Catatan: Pembuatan Service Account Key di Firebase Console **gratis** dan **tidak memerlukan aktivasi Google Cloud Billing**.
4. Simpan file JSON yang terunduh di komputer lokal Anda dengan aman.
   - **JANGAN PERNAH** meng-upload atau meng-commit file JSON ini ke GitHub. (`.gitignore` sudah memblokir pola `*service-account*.json`, `*firebase-adminsdk*.json`, `.env*`, `*.pem`, dan `*.key`).

---

## Langkah 2: Push Source Code ke GitHub dengan Aman

1. Pastikan tidak ada file sensitif di repository sebelum `git push`:
   - Tidak ada file `.env`, `.env.local`, `*service-account*.json`, atau `*firebase-adminsdk*.json`.
   - Tidak ada file `dist/` atau `server.js` hasil build lokal (keduanya di-ignore dan akan di-build ulang oleh Render).
   - File `firebase-applet-config.json` hanya berisi konfigurasi publik Web SDK (bukan private key) dan diperlukan saat `vite build`.
2. Push project ke repository GitHub Anda (public atau private).

---

## Langkah 3: Deploy ke Render Free Web Service

Anda dapat menggunakan **Render Blueprint** (`render.yaml` sudah tersedia) atau membuat Web Service secara manual:

### Opsi A — Menggunakan `render.yaml` (Direkomendasikan)
1. Login ke [Render Dashboard](https://dashboard.render.com/).
2. Klik **New +** → **Blueprint**.
3. Pilih repository GitHub **SmartPOS Guest**.
4. Render akan otomatis membaca `render.yaml` (`plan: free`, `buildCommand`, `startCommand`, `healthCheckPath: /api/health`).
5. Saat diminta mengisi Environment Variables yang bertanda `sync: false`, masukkan seluruh nilai eksplisit untuk environment tersebut:
   - `OWNER_FIREBASE_PROJECT_ID`: ID project Firebase terisolasi untuk environment target (tanpa fallback).
   - `OWNER_FIRESTORE_DATABASE_ID`: ID named database Firestore Owner untuk environment target (tanpa fallback; `(default)` ditolak backend).
   - `STORE_ID`: UID pemilik SmartPOS Owner untuk environment target (ID dokumen toko di koleksi `stores/{STORE_ID}`).
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: Salin **seluruh isi file JSON** Service Account dari Langkah 1 (1 baris atau multi-baris JSON, atau string Base64 dari file JSON tersebut) milik environment target.

### Opsi B — Setup Manual Web Service di Render
1. Klik **New +** → **Web Service**, pilih repository GitHub Anda.
2. Isi pengaturan berikut:
   - **Runtime**: `Node`
   - **Instance Type**: `Free`
   - **Build Command**: `npm install --include=dev && npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/api/health`
3. Tambahkan **Environment Variables** di tab **Environment** secara eksplisit:
   - `NODE_ENV` = `production`
   - `OWNER_FIREBASE_PROJECT_ID` = *(`<FIREBASE_PROJECT_ID_ENVIRONMENT_ANDA>` — wajib eksplisit)*
   - `OWNER_FIRESTORE_DATABASE_ID` = *(`<OWNER_FIRESTORE_DATABASE_ID_ENVIRONMENT_ANDA>` — wajib eksplisit, bukan `(default)`)*
   - `STORE_ID` = *(isi dengan UID pemilik SmartPOS Owner pada environment target)*
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = *(tempel seluruh isi JSON service account dari Firebase Console untuk environment target)*
     *(Alternatif jika tidak memakai JSON utuh: isi `FIREBASE_CLIENT_EMAIL` dan `FIREBASE_PRIVATE_KEY` secara terpisah.)*
   - Opsional: `APP_URL` = URL publik layanan Anda pada environment tersebut.

> **Catatan tentang `--include=dev` pada Build Command:**
> Tool build (`vite`, `esbuild`, `tailwindcss`, `tsx`) berada pada `devDependencies`. Penambahan `--include=dev` memastikan Render tetap menginstal dependency build meskipun `NODE_ENV=production` aktif selama proses build.

---

## Langkah 4: Verifikasi Setelah Deploy

Setelah status deploy Render berubah menjadi **Live**:

1. Buka `https://<nama-service-anda>.onrender.com/api/health`:
   - Pastikan respons `200 OK` berisi:
     - `"status": "ok"`
     - `"mode": "production"`
     - `"storeConfigured": true`
     - `"explicitCredsConfigured": true`
2. Buka `https://<nama-service-anda>.onrender.com/api/catalog`:
   - Pastikan produk asli Owner tampil dari `"source": "owner_firestore"` dan tidak ada field `cost` di respons JSON.
3. Buka halaman utama `https://<nama-service-anda>.onrender.com/`:
   - Uji tampilan Beranda, Katalog, Pencarian, Filter Kategori, Detail Produk, Keranjang Belanja, serta halaman Cek Status Pesanan (menggunakan Nomor Pesanan + 4 digit akhir WhatsApp).

---

## Catatan Keterbatasan Paket Render Free

- **Cold Start (Sleep setelah Idle)**: Pada paket **Render Free**, Web Service akan tertidur otomatis setelah ~15 menit tidak menerima trafik. Request pertama setelah tidur dapat membutuhkan waktu **30–50 detik** untuk menyala kembali, kemudian berjalan normal.
- **Database Terpisah per Environment**: Pastikan seluruh data staging terisolasi pada project/database staging khusus sebelum testing terhubung ke layanan hidup; jangan menyalin konfigurasi atau kredensial production ke staging.
- **Rate Limiter In-Memory**: Rate limiter pencarian status pesanan (`/api/guest-orders/:orderNumber`) bersifat per-instance in-memory dan akan reset saat container Render restart.
