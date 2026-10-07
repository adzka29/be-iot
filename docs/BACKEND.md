# TrackForge / SYNAPSE-T — Dokumentasi Backend Lengkap

Referensi mendalam untuk API, skema, seed, dan aturan bisnis.  
Ringkasan tinggi: lihat [`README.md`](../README.md).

---

## 1. Konvensi umum

### Base URL

```
http://localhost:8000
```

### Auth header

```http
Authorization: Bearer <session_id>
```

atau

```http
X-Session-Id: <session_id>
```

Beberapa endpoint lama/guard juga mengenal `X-User-Id` (internal); **FE sebaiknya memakai Bearer session**.

### Format waktu

ISO-8601 UTC, contoh: `2026-10-07T08:00:00Z`.

### Error

- `401` authentication required  
- `403` permission denied / account not active  
- `404` not found  
- `409` conflict (lifecycle, duplicate link, delete rule)  
- `422` validation  
- Body error lewat `DetailExceptionFilter` (pesan di field detail)

### Pagination

Sesuai implementasi aktual:

- **Explorer**: `limit` + `offset`
- **Tickets**: `limit` + `offset`
- **History**: `limit` + `offset` (plus scope soldier/group)
- **Operations**: `page` + `limit` → `{ items, page, limit, total }`
- **Personnel**: `page` + `limit`

---

## 2. Health

| Method | Path | Auth | Keterangan |
|--------|------|------|------------|
| GET | `/health` | Tidak | Liveness |
| GET | `/openapi.json` | Tidak | OpenAPI stub |

---

## 3. Users & session

| Method | Path | Auth | Permission |
|--------|------|------|------------|
| POST | `/users/login` | Tidak | — |
| POST | `/users/logout` | Session | — |
| POST | `/users/human` | Biasanya admin flow | user_access |
| GET | `/users` | Session | user_access |
| GET | `/users/summary` | Session | user_access |
| GET | `/users/:userId/permissions` | Session | user_access |
| PATCH | `/users/:userId/human` | Session | user_access |

### Login

```http
POST /users/login
Content-Type: application/json

{ "account": "superadmin", "password": "superadmin" }
```

`account` bisa username atau email.

Response (ringkas): `session_id`, profil user, access/role.

### Buat human user

```json
{
  "name": "Field Reader",
  "username": "field.reader",
  "email": "field.reader@trackforge.id",
  "password": "temporary-password",
  "department": optional,
  "title": optional
}
```

Status user: `INACTIVE` | `ACTIVE` | `SUSPENDED` | `DISABLED`  
Verification: `PENDING` | `VERIFIED`

Write operations (operations/tickets/dll.) biasanya butuh: HUMAN + VERIFIED + ACTIVE + binding role aktif.

---

## 4. Profile

| Method | Path | Auth |
|--------|------|------|
| GET | `/auth/me` | Session |
| PATCH | `/users/me` | Session |
| GET | `/users/me/profile-image` | Session |
| DELETE | `/users/me/profile-image` | Session |

`GET /auth/me` mengembalikan profil + `access.role` + daftar `permissions` efektif — sumber kebenaran menu FE.

---

## 5. Roles & user-role bindings

### Roles

| Method | Path |
|--------|------|
| GET | `/roles` |
| GET | `/roles/summary` |
| POST | `/roles` |
| GET | `/roles/:roleId/detail` |
| PUT | `/roles/:roleId` |
| DELETE | `/roles/:roleId` |

Permission catalog: setiap domain punya code full (`operations`) dan read (`operations.read`).

### Bindings (`/user-roles`)

| Method | Path |
|--------|------|
| GET | `/user-roles` |
| POST | `/user-roles` |
| PATCH | `/user-roles/:bindingId/status` |

```json
{ "user_id": 2, "role_id": 4, "valid_from": null, "valid_until": null }
```

Satu user hanya punya satu binding (UNIQUE user_id). Status: `ACTIVE` | `SUSPENDED` | `REVOKED`.

### Role seed & grants

Lihat tabel di README §5. Source of truth: `src/database/access.ts` → `SEED_ROLES`.

---

## 6. Ingest (perangkat)

```
Field Soldier → LoRa Mesh → Gateway → Satellite Burst → POST /api/ingest
```

### Authentication

| Lingkungan | Auth |
|------------|------|
| Prototype / local | Tidak memakai **user session** (bukan login FE) |
| Production | **Device/gateway authentication** wajib — API key / HMAC / mTLS (bukan user Bearer). Siapa pun di internet publik tidak boleh spoof telemetry. |

Ini memisahkan **user auth** (FE session) dari **device auth** (gateway credential).

### `POST /api/ingest`

Menerima satellite burst mentah:

- `burst_hex` / `raw_hex` — hex penuh (6-byte header + N×21-byte payloads), **atau**
- `burst_base64` — base64 setara

Opsional: `gateway_id`, `burst_id`, `received_at`, `record_origin`, `freshness`.

```json
{
  "burst_hex": "<6-byte header + N×21-byte payloads as hex>",
  "gateway_id": "GW-1",
  "burst_id": "burst-optional-client-id",
  "received_at": "2026-10-07T10:00:00Z"
}
```

Alur:

1. Validasi panjang / N (1–15)
2. Simpan raw burst sebagai transport audit (`UPLINK` / `SATELLITE_BURST`) — **bukan** soldier telemetry
3. Decode tiap 21-byte payload → satu record `TELEMETRY` / `SOLDIER_TELEMETRY`
4. Enrich `group_id` dari Personnel master (lookup only; tidak invent personnel)
5. `raiseAlerts()` per soldier dari flags

Response:

```json
{
  "burst": { "id": 1, "category": "UPLINK", "data_type": "SATELLITE_BURST", "...": "..." },
  "burst_id": "burst-...",
  "soldier_count": 3,
  "records": [ { "category": "TELEMETRY", "soldier_id": 101, "...": "..." } ]
}
```

Legacy routes **dihapus** (bukan compatibility):  
`/telemetry`, `/mesh-frame`, `/uplink`, `/beacon`, `/special`, `/system`.

### Kategori `explorer_records`

| Category / data_type | Peran |
|----------------------|--------|
| `TELEMETRY` / `SOLDIER_TELEMETRY` | **Domain bisnis utama** — record yang dibaca Explorer, History, Alerts |
| `UPLINK` / `SATELLITE_BURST` | **Internal transport/audit** saja — jejak burst mentah, bukan domain Explorer FE |

Explorer default = `TELEMETRY` saja.  
`include_transport=1` hanya untuk debugging/traceability internal — **jangan** dihidupkan kembali sebagai filter UPLINK/MESH di FE Explorer.

---

## 7. Explorer

Prefix: `/api/explorer`  
Permission domain: `explorer`

Explorer adalah **generic search / inspection layer** untuk operational entity records.

Current production domain:

- Soldier telemetry (`TELEMETRY`)

Future domains may include (tanpa membongkar konsep Explorer):

- Weapon telemetry
- Vehicle telemetry
- Other operational entity telemetry

Transport protocols (`UPLINK`, `MESH`, dll.) **bukan** business domain.

Pemisahan menu FE:

| Menu | Domain |
|------|--------|
| **Explorer** | Cari / inspect record |
| **Operations** | Group + assignment |
| **Prajurit** | Kondisi/status personel |
| **Alerts** | Alert / severity |
| **History** | Chronological telemetry / track |
| **Audit** | CREATE / UPDATE / DELETE / ACKNOWLEDGE |

| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/explorer` | List + filter |
| GET | `/api/explorer/summary` | Aggregat |
| GET | `/api/explorer/filters/options` | Opsi filter UI |
| GET | `/api/explorer/export.csv` | Export |
| GET | `/api/explorer/:recordId` | Detail |

### Filter Explorer

Filter utama (kontrak FE):

- `q`
- `soldier_id`
- `from_time`
- `to_time`
- `timeRange`
- `limit`
- `offset`

Explorer **tidak** menggunakan Group, Status, Severity, atau Alert sebagai filter utama — itu domain menu lain.

`category` / `transport` / `include_transport` hanya untuk kebutuhan internal/debugging, bukan default FE Explorer.

SOS: `flags.sos = true` tetap berarti record `TELEMETRY` muncul di Explorer (dan History). Field legacy `is_sos` **bukan** business filter.

Response item memaparkan field publik + objek `data` (parsed `data_json`). Name/group enrichment hanya ada jika Personnel/Groups master sudah diisi (lihat seed no-op).

---

## 8. Alerts

Prefix: `/api/alerts`  
Permission: `alerts`

| Method | Path |
|--------|------|
| GET | `/api/alerts` |
| GET | `/api/alerts/summary` |
| GET | `/api/alerts/filters/options` |
| GET | `/api/alerts/export.csv` |
| GET | `/api/alerts/sos` |
| GET | `/api/alerts/:alertId` |
| POST | `/api/alerts/:alertId/acknowledge` |
| POST | `/api/alerts/:alertId/resolve` |

### Tipe alert (dari flag / aturan)

| Type | Severity default | Sumber |
|------|------------------|--------|
| SOS | CRITICAL | flags.sos |
| CASUALTY | CRITICAL | flags.casualty |
| ARRHYTHMIA | CRITICAL | flags.arrhythmia |
| LOW_BATTERY | WARNING | flags.low_battery |
| HEAT_STRESS | WARNING | flags.heat_stress |
| STRAP_DISCONNECTED | INFO | strap off |
| NO_CONTACT | INFO | gap > 30 menit tanpa telemetry |

Status terbuka: `ACTIVE`, `ACKNOWLEDGED` → resolve menutup.

Buat ticket dari alert:

```http
POST /api/alerts/:alertId/ticket
Authorization: Bearer ...
```

→ `201` ticket baru (`source_alert_id` unik per alert).

---

## 9. History

Prefix: `/api/history`  
Permission: `history`

| Layer | Peran |
|-------|--------|
| **Explorer** | Record inspection / search |
| **History** | Chronological telemetry history / track |

Keduanya membaca **`explorer_records` TELEMETRY yang sama**.  
History **tidak** punya tabel/seed telemetry terpisah.

Action/audit (`CREATE`, `UPDATE`, `DELETE`, `ACKNOWLEDGE`, …) tetap milik **Audit logs** (section 14), bukan History.

| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/history` | List titik |
| GET | `/api/history/filters/options` | Filter UI |
| GET | `/api/history/summary` | Summary (+ timeRange) |
| GET | `/api/history/statistics` | Statistik |
| GET | `/api/history/charts` | Data chart |
| GET | `/api/history/track` | Track per soldier |
| GET | `/api/history/export.csv` | Export |
| GET | `/api/history/point/:recordId` | Satu titik |

Preset waktu (mis. All time / 30 day) diterapkan di summary/list sesuai query `timeRange` / from-to.  
SOS telemetry tetap muncul (`flags.sos`); legacy `is_sos` bukan filter.

---

## 10. Geofences

Prefix: `/api/geofences`

| Method | Path |
|--------|------|
| GET | `/api/geofences` |
| POST | `/api/geofences` |
| DELETE | `/api/geofences/:geofenceId` |

### Create (API geofence global)

```json
{
  "name": "North Perimeter",
  "polygon": [
    [106.8, -6.2],
    [106.81, -6.2],
    [106.805, -6.21]
  ]
}
```

Historically butuh 3 sudut. Schema menyimpan `polygon_json`, `type` default `silent`, `status` `active`.

Kolom tambahan wizard: `kind`, `color`, `area_km2`, `description`.

---

## 11. Personnel & Groups master

Semua endpoint di bawah ini **wajib Bearer session**.  
FE auth gateway saja **tidak cukup** — BE menegakkan permission.

| Method | Path | Permission |
|--------|------|------------|
| GET | `/api/groups`, `/api/groups/:id` | `groups` read |
| POST / PATCH | `/api/groups`… | `groups` write |
| GET | `/api/personnel`, `/api/personnel/:id` | `personal` read |
| POST / PATCH | `/api/personnel`… | `personal` write |
| PUT | `/api/personnel/by-soldier/:soldierId/group` | `personal` **dan** `groups` write |

### Groups

```json
{ "name": "Bravo", "description": "Second squad" }
```

### Personnel

```json
{ "soldier_id": 110, "name": "Soldier 110", "group_id": 1 }
```

Assign group by soldier:

```json
{ "group_id": 1 }
```

atau unassign dengan `group_id: null`.

Response field berguna FE:

- `soldier_id`, `name`, `group_id`, `group_name`
- `access_group` = nama group atau `"UNASSIGNED"`

---

## 12. Operations

Prefix: `/api/operations`  
Permission domain: **`operations`** (read vs write)

Semua endpoint di bawah ini butuh Bearer session.

### Read helpers

| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/operations` | List + filter `q,status,group_id,start_from,start_to,page,limit` |
| GET | `/api/operations/summary` | Count per status |
| GET | `/api/operations/filters/options` | Status + groups |
| GET | `/api/operations/groups/options` | Picker group + personnel_count |
| GET | `/api/operations/personnel/options?q=` | Roster wizard (personnel + last lat/lon/seen) |
| GET | `/api/operations/:id` | Detail |
| GET | `/api/operations/:id/groups` | Groups linked |
| GET | `/api/operations/:id/personnel` | Anggota via membership |
| GET | `/api/operations/:id/map` | operation + groups + positions + geofences |
| GET | `/api/operations/:id/alerts` | Alerts di scope soldier/group |
| GET | `/api/operations/:id/tickets` | Tickets dari alert scope |

### Write — create (wizard + legacy)

```http
POST /api/operations
```

Body diizinkan:

| Field | Wajib | Keterangan |
|-------|-------|------------|
| `name` | Ya | Trim, max 160 |
| `description` | Tidak | Max 2000 |
| `start_at` / `end_at` | Ya | `end_at > start_at` |
| `type` | Tidak | Mis. `Reconnaissance` |
| `group_ids` | Tidak | Link group existing |
| `groups` | Tidak | Inline create group+members |
| `geofence_ids` | Tidak | Link geofence existing |
| `new_geofences` | Tidak | Inline create geofence |
| `status` | **Ditolak** | Selalu PLANNING |

Inline group (gunakan `soldier_id` integer yang **benar-benar ada** di Personnel master development — jangan mengarang identitas Danru):

```json
{
  "name": "Example Group",
  "leader_soldier_id": "<existing-soldier-id>",
  "member_soldier_ids": ["<existing-soldier-id>"]
}
```

Contoh valid setelah master terisi (mis. lewat wizard sebelumnya): `"leader_soldier_id": 103`, `"member_soldier_ids": [103, 106, 110]`. String `"S-103"` dinormalisasi ke `103` jika dikirim, tetapi identitas harus berasal dari roster nyata.

Inline geofence:

```json
{
  "name": "New Zone",
  "kind": "recon",
  "color": "#F2A900",
  "polygon": [[lng,lat],[lng,lat],[lng,lat]],
  "geometry_json": "{\"type\":\"Polygon\",\"coordinates\":[[[...]]]}",
  "area_km2": 0.3
}
```

`geometry_json` opsional: GeoJSON Polygon → ring diekstrak ke `polygon_json` (titik penutup ring dibuang jika ada).

Transaksi: gagal di tengah → rollback seluruh create.

Response detail mencakup:

```json
{
  "id": 1,
  "operation_code": "OP-2026-001",
  "name": "...",
  "type": "Reconnaissance",
  "status": "PLANNING",
  "groups": [{ "id": 1, "name": "Example Group", "leader_soldier_id": 103, "personnel_count": 3 }],
  "geofences": [{ "id": 1, "name": "...", "kind": "recon", "color": "#F2A900", "area_km2": 0.3 }],
  "summary": { "group_count": 1, "personnel_count": 8, "geofence_count": 1 },
  "created_by": { "id": 1, "name": "Superadmin" },
  "created_at": "..."
}
```

### Update

```http
PATCH /api/operations/:id
```

Field: `name`, `description`, `start_at`, `end_at`, `type`, `group_ids`, `geofence_ids`.  
`status` lewat PATCH **ditolak** — pakai endpoint lifecycle.

### Delete

```http
DELETE /api/operations/:id
→ 204
```

| Status | Hasil |
|--------|-------|
| PLANNING, COMPLETED, CANCELLED | 204 soft-delete |
| ACTIVE, ON_HOLD | 409 |

### Lifecycle

| Method | Path | Dari → Ke |
|--------|------|-----------|
| POST | `.../activate` | PLANNING → ACTIVE |
| POST | `.../hold` | ACTIVE → ON_HOLD |
| POST | `.../resume` | ON_HOLD → ACTIVE |
| POST | `.../complete` | ACTIVE/ON_HOLD → COMPLETED |
| POST | `.../cancel` | PLANNING/ACTIVE/ON_HOLD → CANCELLED |

### Nested groups / geofences

```http
POST /api/operations/:id/groups
{ "group_id": 1 }
# atau
{ "name": "Bravo Cell", "leader_soldier_id": 111, "member_soldier_ids": [111, 112] }

DELETE /api/operations/:id/groups/:groupId

POST /api/operations/:id/geofences
{ "geofence_id": 1 }
# atau body new geofence (sama shape new_geofences[])

DELETE /api/operations/:id/geofences/:geofenceId
```

Duplicate link → `409`.

### Scope derived data

Personnel / map / alerts / tickets dihitung dari:

```
operation_groups → group_members → personnel (+ last telemetry)
```

Fallback: `personnel.group_id` jika members kosong.

---

## 13. Tickets

Ticket **hanya** dibuat dari alert (`POST /api/alerts/:id/ticket`).  
`POST /api/tickets` → **405 Method Not Allowed**.

| Method | Path |
|--------|------|
| GET | `/api/tickets` |
| GET | `/api/tickets/summary` |
| GET | `/api/tickets/filters/options` |
| GET | `/api/tickets/:ticketId` |
| PATCH | `/api/tickets/:ticketId` |
| POST | `/api/tickets/:ticketId/assign` |
| POST | `/api/tickets/:ticketId/start-working` |
| POST | `/api/tickets/:ticketId/waiting` |
| POST | `/api/tickets/:ticketId/resolve` |
| POST | `/api/tickets/:ticketId/close` |
| POST | `/api/tickets/:ticketId/collaborators` |
| DELETE | `/api/tickets/:ticketId/collaborators/:userId` |
| POST | `/api/tickets/:ticketId/tasks` |
| PATCH | `/api/tickets/:ticketId/tasks/:taskId` |
| POST | `/api/tickets/:ticketId/updates` |

### Status ticket

`OPEN` → `IN_PROGRESS` → `WAITING` → `RESOLVED` → `CLOSED`

Priority: `CRITICAL` | `HIGH` | `MEDIUM` | `LOW` (sering diturunkan dari severity alert).

---

## 14. Audit logs

Prefix: `/audit-logs`  
Permission: `activity_log`

| Method | Path |
|--------|------|
| GET | `/audit-logs` |
| GET | `/audit-logs/summary` |
| GET | `/audit-logs/categories` |
| GET | `/audit-logs/export` |
| GET | `/audit-logs/me` |
| POST | `/audit-logs` |
| GET | `/audit-logs/:eventId` |
| DELETE | `/audit-logs/:eventId` |

Kategori: `AUTHENTICATION`, `PERSONNEL`, `GROUPS`, `OPERATIONS`, `ALERTS`, `TICKETS`, `USER_ACCESS`, `SYSTEM`, …  
Actions: `LOGIN`, `CREATE`, `UPDATE`, `DELETE`, `ASSIGN`, `ACKNOWLEDGE`, `RESOLVE`, …

Operations menulis audit otomatis pada create/update/delete/lifecycle/assign group-geofence.

---

## 15. Skema SQLite (detail kolom kunci)

### `explorer_records` (inti arsitektur)

| Kolom | Keterangan |
|-------|------------|
| `id` | PK |
| `category` | Domain bisnis: default `TELEMETRY`. Transport `UPLINK` = audit internal |
| `data_type` | Mis. `SOLDIER_TELEMETRY`, `SATELLITE_BURST` |
| `entity_type` / `entity_id` | Generic entity (sekarang `SOLDIER` + id) |
| `soldier_id` | Integer perangkat (nullable untuk non-soldier future domains) |
| `group_id` | **Nama** group hasil enrichment (TEXT), atau null |
| `gateway_id` | Gateway |
| `event_time` / `received_at` / `created_at` | Timestamps |
| `position_source` / `transport` / `freshness` | Metadata posisi & jalur |
| `severity` / `record_origin` | Opsional |
| `raw_format` / `raw_hex` / `raw_bytes_length` | Jejak mentah |
| `data_json` | Payload parsed + **burst traceability**: `burst_id`, `burst_record_id`, `burst_index` |
| `is_sos` | **Legacy schema** — bukan business filter Explorer/History. Sumber SOS = `data.flags.sos` |

Alur:

```
POST /api/ingest → SATELLITE_BURST (audit) + N × TELEMETRY
TELEMETRY → Explorer + History
TELEMETRY → raiseAlerts() → alerts.source_record_id
```

### `alerts`

| Kolom | Keterangan |
|-------|------------|
| `id` | PK |
| `alert_code` | Kode unik tampilan |
| `alert_type` | SOS, CASUALTY, … |
| `severity` | CRITICAL / WARNING / INFO |
| `status` | `ACTIVE` / `ACKNOWLEDGED` / `RESOLVED` |
| `soldier_id` / `group_id` / `gateway_id` | Scope |
| **`source_record_id`** | FK ke `explorer_records.id` telemetry asal — **bukan orphan**; diisi `raiseAlerts()` |
| `event_time` / `first_seen_at` / `last_seen_at` | Timeline |
| `message` / `details_json` | Deskripsi |
| `acknowledged_*` / `resolved_*` | Lifecycle |
| `created_at` / `updated_at` | Audit timestamps |

Kontrak: setiap alert flag-derived punya `source_record_id` → telemetry. Verifikasi seed: 0 orphan alert.

### `personnel`

| Kolom | Tipe | Catatan |
|-------|------|---------|
| id | INTEGER PK | |
| soldier_id | INTEGER UNIQUE | ID perangkat |
| name | TEXT | |
| group_id | INTEGER FK → groups | Primary org group |
| status | ACTIVE/INACTIVE | |
| created_at / updated_at | TEXT | |

### `group_members`

| Kolom | Tipe |
|-------|------|
| group_id | INTEGER PK part |
| soldier_id | INTEGER PK part |
| created_at | TEXT |

### `operations`

| Kolom | Tipe | Catatan |
|-------|------|---------|
| id | INTEGER PK | Numeric ID API |
| operation_code | TEXT UNIQUE | `OP-YYYY-NNN` |
| name, description, type | TEXT | |
| status | CHECK enum | lifecycle |
| start_at, end_at | TEXT | |
| created_by | INTEGER FK users | |
| completed_at, deleted_at | TEXT | soft delete |

### `geofences` (tambahan)

| Kolom | Catatan |
|-------|---------|
| polygon_json | Array `[[lng,lat],...]` |
| kind / color | Nullable, wizard |
| area_km2 | REAL |
| type | default `silent` (bukan kind) |

---

## 16. Flags telemetry (bitfield)

Diimplementasi di `src/mesh/frame.ts`:

| Bit / field | Arti |
|-------------|------|
| sos | SOS button |
| casualty | Casualty |
| arrhythmia | Arrhythmia |
| position_source | GNSS / DEAD_RECKONING / TRILATERATION / STALE |
| strap_connected | Chest strap |
| low_battery | Battery low |
| heat_stress | Heat stress |

Payload length tetap **21 bytes**; frame penuh **25 bytes**.

---

## 17. Seed data detail (unified SYNAPSE-T simulator)

Temporary offline/demo simulator. **Satu** fungsi: `seedExplorer` (tidak ada `seedAlerts` / `seedHistory` terpisah).

Dipanggil dari `DatabaseService.initDb()` hanya jika `explorer_records` kosong (`TRACKFORGE_SEED != 0`).

1. Schema CREATE/ALTER  
2. `seedPersonnelMaster` — **no-op**  
3. **`seedExplorer` (unified)**  
4. `seedAccess`  
5. `runRetentionIfDue` (rolling 30 hari)  
6. Live simulator (opsional) lanjut setelah seed

### Volume TELEMETRY

| Parameter | Nilai |
|-----------|--------|
| Soldiers | **15** (`101`–`115`) |
| Interval | **30 detik** / soldier |
| Per menit | **30** records total (2 × 15) |
| Per jam | **1.800** |
| Per 24 jam (default) | **43.200** |
| Retention | hapus TELEMETRY / SATELLITE_BURST / alerts **> 30 hari** |

Env:
- `TRACKFORGE_SEED_HOURS` (default `24`; e2e `0.75`)
- `TRACKFORGE_SEED_BASE` — jika kosong, window seed **berakhir di jam wall-clock sekarang** (Explorer/History tidak “jam beda”)
- `TRACKFORGE_LIVE_SIM=0` mematikan live tick tiap 30 detik (wajib di test)

Live simulator lanjut memakai timestamp aktual (bukan clock historis tetap).

Setiap paket = **21-byte** soldier telemetry lengkap (bukan Position/Device vs Vitals split).

### Alert scenarios (via flags → `raiseAlerts`)

Bounded windows (bukan flag aktif 24 jam penuh):

| Soldier | Scenario |
|---------|----------|
| 101–103, 105, 107, 109, 111, 113 | normal |
| **104** | SOS |
| **106** | ARRHYTHMIA |
| **108** | HEAT_STRESS |
| **110** | LOW_BATTERY |
| **112** | STRAP_DISCONNECTED |
| **114** | CASUALTY |
| **115** | NO_CONTACT via **gap telemetry > 30 menit** (bukan flag) |

Semua alert flag-derived punya `source_record_id`. Tidak ada orphan insert ke `alerts`.

### Konsekuensi seedPersonnelMaster no-op

```
43.200 TELEMETRY (soldier_id 101–115, 24h)
        ↓
Personnel / Groups master kosong
        ↓
Explorer menampilkan soldier_id; name/group sering null
```

### SOS

`flags.sos` pada TELEMETRY S-104 → muncul di Explorer + History; alert SOS via `raiseAlerts`.  
Legacy `is_sos` bukan business filter.

---

## 18. Struktur source

```
src/
  main.ts                 # Nest bootstrap, ValidationPipe, port
  app.module.ts
  common/                 # audit, session helpers, sql bind, records, filters
  database/               # DatabaseService, access, personnel, seed, alert-rules, entities
  mesh/                   # frame encode/decode
  ingest/
  explorer/
  alerts/
  history/
  geofences/
  personnel/
  users/
  profile/
  roles/
  bindings/
  audit/
  tickets/
  operations/             # controller, service, repository, dto/
test/                     # e2e harness + suites
data/trackforge.db        # runtime DB lokal (jangan commit secrets)
docs/BACKEND.md           # file ini
README.md
```

---

## 19. Checklist integrasi FE (Operations wizard)

1. Login → simpan `session_id`.  
2. `GET /api/operations/groups/options` — pilih group existing.  
3. `GET /api/operations/personnel/options?q=` — pilih anggota / leader di peta.  
4. `GET /api/geofences` — pilih zona existing (opsional).  
5. Draw polygon → kirim di `new_geofences[]` (atau `geometry_json`).  
6. `POST /api/operations` sekali di Review.  
7. Redirect detail: `GET /api/operations/:id` + `/map`.  
8. Lifecycle buttons sesuai status + permission write.  
9. Jangan kirim `status` saat create.  
10. Handle 409 delete pada ACTIVE/ON_HOLD dengan copy: complete/cancel dulu.

---

## 20. Perintah operasional

```bash
# Dev
npm install
npm run start:dev

# Test
npm test

# Prod
npm run build
PORT=8000 TRACKFORGE_DB=/var/data/trackforge.db npm run start:prod
```

Deploy Railpack: `node dist/main.js` (`railpack.json`).
