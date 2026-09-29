# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/); versi mengikuti
[Semantic Versioning](https://semver.org/lang/id/).

## [1.0.0] — 2026-09-29
### Ditambahkan
- Rilis pertama sebagai plugin Claude Code (`kantor-agent@kantor-agent`) dengan marketplace sendiri, sekaligus bisa
  dipasang manual sebagai skill `/kantor-agent`.
- Kantor 3D tanpa konfigurasi (three.js r170, vendored): **Ketua** (sesi utama) dengan meja sendiri, **tim 4 orang**
  (Budi, Sari, Agus, Rina) yang santai di lounge dan duduk bekerja saat Claude memanggil subagent jenis apa pun, serta
  **freelancer** yang datang lewat pintu bila tim penuh (4 meja cadangan + kartu "+N").
- Penugasan deterministik dari data transkrip (stabil setelah muat ulang), termasuk segmen lanjutan, subagent
  bertingkat, subagent workflow, `TaskStop`, limit, dan subagent yang macet.
- Panel: aktivitas langsung ("Joko meminta Budi: …"), riwayat subagent, daftar tugas `TodoWrite` sesi utama, kartu
  status Santai / Bekerja / Selesai, statistik subagent hari ini & aktif sekarang; panel bisa diperkecil, ramah ponsel,
  menghormati `prefers-reduced-motion`.
- Runtime tanpa dependensi: Node ≥ 18 (utama) atau PHP ≥ 8.1, keluaran identik (`bin/parity.mjs`); `bin/kantor.sh`
  (`start`/`stop`/`status`/`restart`/`url`/`tunnel`/`tunnel-stop`/`detect`) idempoten dengan pemilihan port bebas
  otomatis; tidak menulis file apa pun ke folder project.
- Hook `SessionStart` opsional (mati secara bawaan) untuk menyalakan server otomatis.
- Keamanan: read-only, isi `tool_result` tidak pernah dibaca, redaksi rahasia, header `noindex`/CSP, whitelist aset,
  perlindungan DNS rebinding (Host), hanya GET/HEAD.
