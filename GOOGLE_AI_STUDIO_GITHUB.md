# Panduan GitHub → Google AI Studio

## A. Buat repository GitHub

1. Buat repository baru di GitHub, misalnya `smartpos-guest-ai-studio`.
2. Pilih visibility Private bila source code tidak ingin dipublikasikan.
3. Upload seluruh isi folder proyek ini ke root repository (jangan upload folder pembungkus ZIP).
4. Pastikan branch utama bernama `main`.

Jika memakai Git dari komputer:

```bash
git init
git add .
git commit -m "Initial SmartPOS Guest project"
git branch -M main
git remote add origin https://github.com/USERNAME/smartpos-guest-ai-studio.git
git push -u origin main
```

Ganti `USERNAME` sesuai username GitHub.

## B. Import repository ke AI Studio

1. Buka https://aistudio.google.com/ dan pilih Build.
2. Pada area prompt, klik Add files (+) → Import from GitHub.
3. Authorize aplikasi Google AI Studio untuk mengakses repository yang dipilih.
4. Pilih repository `smartpos-guest-ai-studio` dan branch `main`.
5. Tunggu sampai source code selesai di-import.

## C. Setelah import

- Periksa apakah AI Studio berhasil menjalankan frontend dan backend.
- Atur environment variables/secrets untuk Firebase dan layanan ongkir yang digunakan.
- Jangan menaruh isi `.env`, private key, atau service-account JSON di GitHub.
- Uji login/akses Firestore, checkout, status pesanan, dan kalkulasi ongkir sebelum deploy.

Catatan: import repository tidak otomatis membuat seluruh layanan eksternal (Firebase, KiriminAja, RajaOngkir) atau mengisi secrets. Konfigurasi layanan tersebut tetap perlu disiapkan di lingkungan target.
