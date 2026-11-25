# SmartPOS Guest

Aplikasi SmartPOS Guest berbasis React + TypeScript + Vite dengan backend Node.js/Express dan integrasi Firebase. Repository ini disiapkan untuk di-import ke **Google AI Studio Build** melalui GitHub.

## Import ke Google AI Studio

1. Upload folder proyek ini ke repository GitHub (branch `main`).
2. Buka [Google AI Studio](https://aistudio.google.com/) lalu masuk ke **Build**.
3. Pilih tombol **Add files (+)** pada area prompt, lalu pilih **Import from GitHub**.
4. Hubungkan akun GitHub jika diminta, pilih repository dan branch `main`.
5. Setelah proyek terbuka, gunakan tab **GitHub** di Settings untuk mengelola sinkronisasi perubahan.

## Menjalankan secara lokal

**Prasyarat:** Node.js 20.18 atau lebih baru dan npm.

```bash
npm install
cp .env.example .env
npm run dev
```

Isi nilai environment yang diperlukan di `.env` sebelum menguji fitur backend/Firebase. Jangan pernah commit `.env` atau kredensial service account ke GitHub.

## Build produksi

```bash
npm run build
npm start
```

Server berjalan pada port `3000` secara default (atau nilai `PORT` dari environment). Build frontend berada di `dist/`, sedangkan bundle backend dibuat sebagai `server.js`.

## Environment variables

Lihat [`.env.example`](./.env.example) untuk daftar konfigurasi. Beberapa fitur memerlukan Firebase Admin, Firebase client, serta kredensial penyedia ongkir (KiriminAja/RajaOngkir). Simpan seluruh secret di environment/secrets manager hosting, bukan di source code.

## Catatan integrasi

- Proyek ini memiliki frontend React dan backend Express dalam satu repository.
- Google AI Studio dapat meng-import repository melalui Build mode. Setelah import, periksa konfigurasi environment dan integrasi eksternal sebelum menjalankan/deploy.
- Firebase rules tersedia di `firestore.rules`; tinjau dan deploy sesuai project Firebase yang digunakan.
- File `firebase-applet-config.json` dan `firebase-blueprint.json` adalah konfigurasi proyek; pastikan nilainya sesuai lingkungan target.

## Struktur utama

- `src/` — aplikasi React, komponen UI, tipe, utilitas, dan integrasi Firebase.
- `server.ts` — API/backend Express.
- `firestore.rules` — aturan keamanan Firestore.
- `.env.example` — template konfigurasi environment tanpa nilai rahasia.
