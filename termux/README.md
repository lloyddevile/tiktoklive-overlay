# TikTok Live Overlay – versi Termux (Android)

Pembaca komentar TikTok LIVE + TTS yang jalan di Termux. Tampilan berupa halaman web lokal yang dibuka di browser HP (atau perangkat lain di WiFi yang sama). Dibuat oleh **Lloyd Von Degurechaff**.

> Beda dengan versi Windows: tidak ada overlay di atas game. Suara memakai suara neural Microsoft Edge yang sama, tetapi diputar di browser HP, jadi tidak lagi bergantung pada `termux-tts-speak`.

## Pasang

Pasang **Termux** (F-Droid atau GitHub), lalu di Termux:

```bash
pkg update && pkg upgrade
pkg install nodejs git
git clone https://github.com/lloyddevile/tiktoklive-overlay.git
cd tiktoklive-overlay
npm install
```

Jika sebelumnya sudah pernah `npm install`, jalankan lagi karena ada modul baru (`msedge-tts`, `https-proxy-agent`).

## Jalankan

```bash
npm start
```

Buka `http://localhost:3000` di **browser HP** (Chrome), isi username atau link LIVE, lalu **Hubungkan**. Buka **⚙ Pengaturan & suara**, nyalakan **Bacakan komentar**, dan ketuk layar sekali jika muncul tombol kuning "Ketuk di sini untuk mengaktifkan suara" (browser mewajibkan sentuhan pertama sebelum boleh bersuara).

Biarkan halaman web tetap terbuka. Supaya Termux tidak mati saat layar padam, jalankan `termux-wake-lock`.

## Yang baru

- **v2.4.1**: Tes suara menghentikan suara yang sedang berjalan; hitungan komentar tidak reset saat server sempat putus-sambung; layar HP ditahan menyala (Screen Wake Lock) setelah ketukan pertama
- **v2.4.2**: pesan error Room ID rinci, kolom API key Euler Stream, log `[error]` terbaca
- **v2.4.4–2.4.7**: koneksi dipaksa `https://`, error asli terlihat (retry `got` dimatikan), saran per kode error, dukungan proxy, batas waktu 30 detik (keras 35 detik), diagnosa otomatis, dan DNS alternatif otomatis

## Musik request (`!play`)

| Perintah | Siapa | Fungsi |
|---|---|---|
| `!play judul lagu` | Semua penonton | Cari dan antre lagu (contoh `!play pure`) |
| `!skip` | Host dan moderator | Lewati lagu |
| `!pause` | Host dan moderator | Jeda; ketik lagi untuk lanjut |

Kartu "Now playing" dan antrean tampil di halaman web; lagu diputar di browser HP. Pembatasan: jeda 20 detik per penonton, maksimal 2 lagu per penonton, antrean maksimal 10, durasi maksimal 10 menit.

**Halaman playlist** untuk sumber Browser/Link di OBS atau TikTok LIVE Studio: `http://localhost:3000/playlist` (tampilan saja, tanpa suara, latar transparan). Opsi: `?max=4`, `?idle=0`, `?hint=0`, `?scale=1.2`. Link ini juga tertera di ⚙ Pengaturan. Agar bisa dibuka dari PC, jalankan `HOST=0.0.0.0 npm start` dan pakai alamat IP HP (contoh `http://192.168.1.20:3000/playlist`) di PC yang sama jaringan WiFi-nya; tanpa password, pakai hanya di jaringan tepercaya.

**Lagu penuh** butuh yt-dlp:

```bash
pkg install yt-dlp
```

Tanpa itu, yang diputar hanya pratinjau 30 detik (diberi tanda `PRATINJAU 30 DTK`). Perbarui sesekali dengan `pkg upgrade`. Jalur lain bisa diisi lewat `YTDLP_PATH=/path/ke/yt-dlp npm start`.

> Memutar musik berhak cipta di LIVE bisa membuat TikTok membisukan siaran. Gunakan musik yang boleh Anda putar. Jangan buka halaman web di dua tab sekaligus, karena lagu akan diputar dua kali.

## Mesin suara

Pilih di **⚙ Pengaturan & suara → Mesin suara**:

| Mesin | Cara kerja | Kebutuhan |
|---|---|---|
| **Suara Edge, di browser** (default) | Server membuat MP3 dengan suara Edge (Ardi, Gadis, dll.), halaman web memutarnya | Internet, halaman web terbuka |
| **Suara bawaan perangkat, di browser** | Browser membaca teks dengan mesin TTS Android | Mesin TTS Android punya bahasa Indonesia |
| **Suara Edge, lewat Termux:API** | Server memutar MP3 dengan `termux-media-player` | Internet, `pkg install termux-api`, aplikasi Termux:API; tetap bersuara walau halaman web ditutup |
| **termux-tts-speak (lama)** | Memakai `termux-tts-speak` | `pkg install termux-api`, aplikasi Termux:API, mesin TTS Android |

## Opsi

| Perintah | Fungsi |
|---|---|
| `PORT=3001 npm start` | Ganti port |
| `DEBUG=1 npm start` | Cetak data mentah event like (untuk diagnosa) |
| `HOST=0.0.0.0 npm start` | Bisa dibuka dari perangkat lain di WiFi yang sama (tidak ada password, pakai hanya di jaringan tepercaya) |
| `EULER_API_KEY=xxxx npm start` | API key Euler Stream (jalur cadangan pencarian Room ID); bisa juga diisi di ⚙ Pengaturan dan tersimpan di `settings.json` |
| `TIKTOK_PROXY=http://host:port npm start` | Memakai proxy HTTP (juga membaca `HTTPS_PROXY`/`HTTP_PROXY`) |
| `TIKTOK_CLIENT_TIMEOUT=45000 npm start` | Batas waktu permintaan ke TikTok dalam ms (bawaan 30000) |

Daftar kata terlarang, batas panjang, dan antrean bisa diubah di objek `tts` bagian atas `src/server.js`. Pengaturan suara tersimpan di `settings.json`.

## Pemecahan masalah

**Suara tidak terdengar** (coba berurutan)

1. Pilih **Suara Edge, di browser**, nyalakan **Bacakan komentar**, ketuk tombol kuning jika ada, lalu tekan **Tes suara**. Pesan error (jika ada) tampil di bawah tombol.
2. Naikkan **volume media** HP dan **Volume di halaman**. Suara di browser mengikuti volume media.
3. Pesan *"TTS timeout"*: koneksi internet ke layanan suara bermasalah. Coba mesin **Suara bawaan perangkat**.
4. Pesan *"Browser memblokir suara"*: ketuk layar sekali lalu tekan **Tes suara** lagi.
5. Pesan *"Tidak ada halaman web yang terbuka"*: buka `http://localhost:3000` di browser dan biarkan terbuka, atau pakai mesin **lewat Termux:API**.
6. Mesin **Termux:API / termux-tts-speak** diam: pastikan aplikasi **Termux:API** terpasang dari sumber yang sama dengan Termux (F-Droid atau GitHub, jangan campur dengan Play Store), lalu jalankan `termux-media-player` atau `termux-tts-speak "halo"` langsung di Termux untuk melihat errornya. Matikan penghemat baterai untuk Termux dan Termux:API.

Terminal Termux mencetak `[suara] ...` setiap komentar dibacakan dan `[suara gagal] ...` bila ada error.

**Gagal terhubung: "Room ID tidak ditemukan"**

Pesan error memuat **Detail** (kode error asli tiap jalur) dan **Diagnosa** (cek DNS, DNS alternatif, TCP, HTTPS, dengan kesimpulan). Panduan singkat:

| Yang tampil | Yang dilakukan |
|---|---|
| `[ENOTFOUND]` / DNS gagal | Ganti DNS ke `1.1.1.1` / `8.8.8.8` (server juga mencoba DNS alternatif otomatis lewat DNS-over-HTTPS) |
| `[ECONNREFUSED]` / `[ECONNRESET]` / `[ETIMEDOUT]` | Jaringan atau provider memblokir TikTok: coba VPN, ganti dari data seluler ke WiFi (atau sebaliknya) |
| `403` | TikTok menolak IP ini: ganti jaringan atau isi API key Euler Stream di ⚙ Pengaturan |
| Jaringan normal | Akun tidak sedang LIVE atau username salah |

Semua permintaan ke TikTok dipaksa lewat `https://` karena library bawaan memakai `http://` (port 80) yang diputus di sebagian jaringan.

**`!play` tidak ada suaranya / lagu tidak ketemu**

- Ketuk layar sekali jika muncul tombol kuning, karena browser mewajibkan sentuhan pertama sebelum memutar audio.
- Lihat baris `[musik]` di terminal Termux: `yt-dlp tidak ditemukan` berarti yang diputar hanya pratinjau 30 detik; jalankan `pkg install yt-dlp` untuk lagu penuh.
- Pesan "tautan kedaluwarsa atau diblokir" di chat: coba `!play` lagi atau perbarui yt-dlp.

**Like tetap 0**

Server memakai total like dari TikTok; kalau tidak dikirim, server menghitung sendiri dari like per event, dan mengawali dari info room saat tersambung. Jika masih 0, jalankan `DEBUG=1 npm start` dan lihat baris `[debug like]` di terminal (3 event pertama): itu data mentah yang dikirim TikTok.

**Lainnya**

- **Komentar tidak muncul**: pastikan akun sedang LIVE dan publik.
- **`npm install` gagal**: jalankan `pkg upgrade`, lalu ulangi.
