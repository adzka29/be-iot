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
**Auth:** Bearer session wajib  
**Permission:** `alerts` read (GET) · `alerts` write (acknowledge / resolve)

```
TELEMETRY ingest / live sim
        │
   ┌────┴────┐
raiseAlerts()  syncNoContact()   ← command/detection (bukan GET)
   └────┬────┘
        ▼
      alerts
        │
   GET /api/alerts/*   ← read-only
   POST ack / resolve  ← actor dari session
   POST …/ticket       ← tickets write
```

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/alerts` | session + `alerts.read` |
| GET | `/api/alerts/summary` | session + `alerts.read` |
| GET | `/api/alerts/filters/options` | session + `alerts.read` |
| GET | `/api/alerts/export.csv` | session + `alerts.read` |
| GET | `/api/alerts/sos` | session + `alerts.read` — shortcut `alert_type=SOS` + status open |
| GET | `/api/alerts/:alertId` | session + `alerts.read` |
| POST | `/api/alerts/:alertId/acknowledge` | session + `alerts` write |
| POST | `/api/alerts/:alertId/resolve` | session + `alerts` write |
| POST | `/api/alerts/:alertId/ticket` | session + `tickets` write |

`GET` **tidak** menjalankan `syncNoContact()`. Detection NO_CONTACT jalan di ingest (`raiseAlerts` → scan) dan seed/live simulator (satu kali per tick).

### Dedup / lifecycle

Identitas incident terbuka: `soldier_id` + `alert_type` + status `ACTIVE|ACKNOWLEDGED`.

- Packet berikutnya dengan flag sama → update `last_seen_at` / `source_record_id`, **bukan** alert baru.
- Flag kembali normal → status **`CLEARED`** (engine).
- Operator: `ACTIVE` → `ACKNOWLEDGED` → **`RESOLVED`**.
- `CLEARED` ≠ `RESOLVED`. Engine tidak menghidupkan kembali alert yang sudah `RESOLVED` tanpa incident baru (setelah episode tutup, flag on lagi → alert baru).
- `NO_CONTACT`: gap > 30 menit → `ACTIVE`; telemetry kembali → **`CLEARED`** (bukan RESOLVED). Scheduler idempotent via open-alert check.

Acknowledge / resolve **tidak** menerima `{ "by": "…" }` di body. Backend mengisi `acknowledged_by` / `resolved_by` dari user session (`user.name`).

### `group_id` pada alert

Application-level identifier = **nama group** (string, sama dengan `explorer_records.group_id` / Personnel enrichment), bukan numeric FK.

### Summary timeline buckets

Response `GET /api/alerts/summary` menyertakan `timeline_bucket`:

| Window | Bucket |
|--------|--------|
| `timeRange=30d` (dan sinonim) | `1d` |
| span ≤ 1 jam (`from_time`/`to_time` atau range pendek) | `5m` |
| default / 24h-class | `1h` |

```json
{
  "total": 12,
  "timeline_bucket": "1h",
  "timeline": [{ "time": "2026-10-07T12:00:00Z", "count": 2 }],
  "by_severity": [],
  "by_type": []
}
```

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

Buat ticket dari alert:

```http
POST /api/alerts/:alertId/ticket
Authorization: Bearer ...
```

→ `201` ticket baru (`source_alert_id` unik per alert). Permission: **`tickets` write**.

---

## 9. History

Prefix: `/api/history`  
**Auth:** Bearer session wajib  
**Permission:** `history` read

| Layer | Peran |
|-------|--------|
| **Explorer** | “Data apa yang masuk?” — inspect/search records |
| **History** | “Prajurit ini bergerak/terekam bagaimana?” — track & histori TELEMETRY |
| **Alerts** | “Ada kondisi abnormal?” — dari `raiseAlerts()` |
| **Audit** | Action log CREATE/UPDATE/ACK… (bukan History) |

Sumber: **`explorer_records`** (domain default **`TELEMETRY`**).  
`UPLINK` / `SATELLITE_BURST` = transport/audit internal — **bukan** default History.

```
explorer_records (TELEMETRY)
        │
   ┌────┼────┐
Explorer History Alerts
           │
    Summary / Track / Charts
```

| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/history` | List TELEMETRY |
| GET | `/api/history/filters/options` | Soldier, group name, time, position_source |
| GET | `/api/history/summary` | Jarak, avg HR/batt, `total_records` (= telemetry) |
| GET | `/api/history/statistics` | `telemetry_count`, by_position_source, by_soldier |
| GET | `/api/history/charts` | Bucket per jam (HR/battery) — agregasi aktual, bukan hard-code |
| GET | `/api/history/track` | GPS track TELEMETRY saja |
| GET | `/api/history/export.csv` | Export sesuai filter |
| GET | `/api/history/point/:recordId` | Detail TELEMETRY (404 jika bukan TELEMETRY) |

### Query wajib

```
?scope=SOLDIER&soldier_id=104&timeRange=all
?scope=GROUP&group_id=Alpha&timeRange=all
```

**`group_id` di History** = nilai yang tersimpan di `explorer_records.group_id`  
(= **nama group string** hasil enrichment, bukan numeric `groups.id`).  
Tanpa personnel/group enrichment → GROUP scope sering `0` (normal).

Default category = **TELEMETRY**.  
`history_data_type` boleh override untuk debug backend; FE operasional jangan kirim UPLINK/MESH.

### Response notes

- `data_type` di item History = label dari **category** → `"TELEMETRY"` (bukan DB `SOLDIER_TELEMETRY`).
- `summary.total_records` / `telemetry_count` = jumlah TELEMETRY (bukan transport).
- `track` length boleh ≠ `total_records` jika ada dedupe / titik tanpa koordinat.
- Detail `point`: `position`, `vitals`, `device` (batt+flags), `packet_reference`, `raw_data`.  
  **Tidak** ada Communication legacy (`hop_count` / `rssi` / `snr`) — payload 21-byte tidak membawanya.

SOS TELEMETRY tetap muncul (`flags.sos`); legacy `is_sos` bukan filter.

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

## 12. Operations — FE integration contract

Prefix: `/api/operations`  
**Auth:** `Authorization: Bearer <session_id>` wajib di semua endpoint  
**Permission:** `operations.read` (GET) · `operations` / write (POST/PATCH/DELETE + lifecycle)

### ID types (jangan campur)

| Nama di URL/body | Tipe | Asal |
|------------------|------|------|
| `:operationId` / `id` | number | PK `operations` |
| `:groupId` / `group_id` / `group_ids[]` | number | PK `groups` (Settings) |
| `:geofenceId` / `geofence_id` / `geofence_ids[]` | number | PK `geofences` |
| `soldier_id` / `leader_soldier_id` / `member_soldier_ids[]` | number | Personnel (`103`; `"S-103"` → `103`) |
| `group_id` di Alerts/Explorer | **string nama** | Bukan PK — beda kontrak |

Status operation: `PLANNING` | `ACTIVE` | `ON_HOLD` | `COMPLETED` | `CANCELLED`.

---

### Endpoint map

| Method | Path | Perm | Response |
|--------|------|------|----------|
| GET | `/api/operations` | read | list page |
| GET | `/api/operations/summary` | read | counts |
| GET | `/api/operations/filters/options` | read | filter enums |
| GET | `/api/operations/groups/options` | read | group picker |
| GET | `/api/operations/personnel/options` | read | soldier picker |
| POST | `/api/operations` | write | **detail** (`201`) |
| GET | `/api/operations/:operationId` | read | **detail** |
| PATCH | `/api/operations/:operationId` | write | **detail** |
| DELETE | `/api/operations/:operationId` | write | empty `204` |
| POST | `/api/operations/:operationId/activate` | write | **detail** |
| POST | `/api/operations/:operationId/hold` | write | **detail** |
| POST | `/api/operations/:operationId/resume` | write | **detail** |
| POST | `/api/operations/:operationId/complete` | write | **detail** |
| POST | `/api/operations/:operationId/cancel` | write | **detail** |
| GET | `/api/operations/:operationId/groups` | read | `{ items: GroupItem[] }` |
| POST | `/api/operations/:operationId/groups` | write | **detail** |
| DELETE | `/api/operations/:operationId/groups/:groupId` | write | **detail** |
| POST | `/api/operations/:operationId/geofences` | write | **detail** |
| DELETE | `/api/operations/:operationId/geofences/:geofenceId` | write | **detail** |
| GET | `/api/operations/:operationId/personnel` | read | `{ items: PersonnelItem[] }` |
| GET | `/api/operations/:operationId/map` | read | map payload |
| GET | `/api/operations/:operationId/alerts` | read | `{ items: OpAlert[] }` |
| GET | `/api/operations/:operationId/tickets` | read | `{ items: OpTicket[] }` |

Field ekstra di body → `422 unexpected fields: …`.

---

### Shared response shapes

#### `OperationListItem` — `GET /api/operations` → `items[]`

| Field | Type | Keterangan |
|-------|------|------------|
| `id` | number | |
| `operation_code` | string | mis. `OP-2026-001` |
| `name` | string | |
| `description` | string \| null | |
| `type` | string \| null | |
| `status` | string | enum di atas |
| `start_at` | string | ISO UTC |
| `end_at` | string | ISO UTC |
| `group_count` | number | |
| `personnel_count` | number | unique soldiers di scope |
| `geofence_count` | number | |
| `created_at` | string | ISO UTC |

```json
{
  "items": [],
  "page": 1,
  "limit": 20,
  "total": 3
}
```

#### `OperationDetail` — create / get / patch / lifecycle / add-remove group|geofence

| Field | Type |
|-------|------|
| `id` | number |
| `operation_code` | string |
| `name` | string |
| `description` | string \| null |
| `type` | string \| null |
| `status` | string |
| `start_at` | string |
| `end_at` | string |
| `groups` | `GroupRef[]` |
| `geofences` | `{ id, name, kind, color, area_km2 }[]` |
| `summary` | `{ group_count, personnel_count, geofence_count }` |
| `counts` | `{ groups, personnel, geofences }` — alias angka yang sama |
| `created_by` | `{ id, name }` |
| `created_at` | string |

#### `GroupRef`

| Field | Type |
|-------|------|
| `id` | number | PK groups |
| `name` | string |
| `leader_soldier_id` | number \| null |
| `personnel_count` | number |

#### `GroupItem` — `GET .../groups` → `items[]`

| Field | Type |
|-------|------|
| `id` | number |
| `name` | string |
| `leader_soldier_id` | number \| null |
| `commander` | `{ soldier_id }` \| null |
| `personnel_count` | number |
| `status` | string | status group Settings |

#### `PersonnelItem` — `GET .../personnel` → `items[]`

| Field | Type | Keterangan |
|-------|------|------------|
| `soldier_id` | number | |
| `group_id` | number | **PK groups** (bukan nama) |
| `group_name` | string | |

#### Map — `GET .../map`

```json
{
  "operation": { "id": 1, "name": "Ops Alpha" },
  "groups": [],
  "personnel": [],
  "geofences": [{ "id": 1, "name": "Zone A", "polygon": [[106.81, -6.20], [106.83, -6.20], [106.82, -6.22]] }],
  "positions": [{
    "soldier_id": 103,
    "group_id": 1,
    "group_name": "Alpha",
    "latitude": -6.21,
    "longitude": 106.82,
    "event_time": "2026-10-07T12:00:00Z"
  }]
}
```

`latitude` / `longitude` / `event_time` bisa `null` jika belum ada TELEMETRY.

#### Op alerts / tickets (ringkas)

`GET .../alerts` → `items[]`:

| Field | Type | Catatan |
|-------|------|---------|
| `id` | number | alert id |
| `type` | string | = `alert_type` |
| `severity` | string | |
| `soldier_id` | number \| null | |
| `group_id` | number \| null | **PK groups** (di-map dari nama alert) |
| `status` | string | ACTIVE / ACKNOWLEDGED / CLEARED / RESOLVED |
| `event_time` | string | |

`GET .../tickets` → `items[]`:

| Field | Type |
|-------|------|
| `id` | number |
| `ticket_code` | string |
| `status` | string |
| `priority` | string |
| `source_alert_id` | number |
| `alert_type` | string |

---

### Wizard helpers (tanpa `:operationId`)

#### `GET /api/operations/summary`

```json
{
  "total": 5,
  "planning": 1,
  "active": 2,
  "on_hold": 0,
  "completed": 1,
  "cancelled": 1
}
```

#### `GET /api/operations/filters/options`

```json
{
  "statuses": ["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"],
  "groups": [{ "id": 1, "name": "Alpha" }]
}
```

#### `GET /api/operations/groups/options` → `{ "items": GroupChoice[] }`

`GroupChoice` = `GroupRef` + `commander_name` (saat ini selalu `null`).

#### `GET /api/operations/personnel/options?q=`

| Field | Type | Keterangan |
|-------|------|------------|
| `soldier_id` | number | |
| `name` | string | |
| `group_id` | number \| null | PK groups |
| `group_name` | string \| null | |
| `access_group` | string | `group_name` atau `"UNASSIGNED"` |
| `last_seen` | string \| null | ISO dari TELEMETRY terakhir |
| `lat` / `lon` | number \| null | dari TELEMETRY terakhir |

Response: `{ "items": [ ... ] }`.

#### `GET /api/operations` — query

| Query | Type | Default | Keterangan |
|-------|------|---------|------------|
| `q` | string | — | search `name` / `operation_code` |
| `status` | string | — | satu status; unknown → `400` |
| `group_id` | number | — | filter operation yang link group PK ini |
| `start_from` / `start_to` | ISO | — | filter `start_at` |
| `page` | number | `1` | |
| `limit` | number | `20` | max `100` |

---

### Create — `POST /api/operations` → `201` + `OperationDetail`

Body **hanya** field berikut (lainnya → `422`):

| Field | Wajib | Type | Rules |
|-------|-------|------|-------|
| `name` | Ya | string | trim, max 160 |
| `description` | Tidak | string \| null | max 2000 |
| `start_at` | Ya | ISO string | |
| `end_at` | Ya | ISO string | harus `> start_at` |
| `type` | Tidak | string \| null | mis. `Reconnaissance` |
| `group_ids` | Tidak | number[] | existing group PKs |
| `groups` | Tidak | InlineGroup[] | create group baru lalu link |
| `geofence_ids` | Tidak | number[] | existing geofence PKs |
| `new_geofences` | Tidak | InlineGeofence[] | create fence baru lalu link |
| `status` | **Jangan kirim** | — | selalu `PLANNING` |

#### `InlineGroup`

| Field | Wajib | Type |
|-------|-------|------|
| `name` | Ya | string |
| `member_soldier_ids` | Ya | number[] (min 1; soldier harus ada di Personnel) |
| `leader_soldier_id` | Tidak | number — jika ada, dijamin masuk members |
| `description` | Tidak | string \| null |

#### `InlineGeofence`

| Field | Wajib | Type |
|-------|-------|------|
| `name` | Ya | string |
| `polygon` **atau** `geometry_json` | Ya | `[[lng,lat],...]` (≥3) **atau** GeoJSON Polygon |
| `kind` | Tidak | string \| null |
| `color` | Tidak | string \| null (hex) |
| `description` | Tidak | string \| null |
| `area_km2` | Tidak | number — auto-hitung jika kosong |

Contoh wizard:

```json
{
  "name": "Night Recon",
  "description": "Sector east",
  "type": "Reconnaissance",
  "start_at": "2026-10-08T01:00:00Z",
  "end_at": "2026-10-08T09:00:00Z",
  "group_ids": [1],
  "groups": [{
    "name": "Bravo Cell",
    "leader_soldier_id": 111,
    "member_soldier_ids": [111, 112, 113]
  }],
  "geofence_ids": [],
  "new_geofences": [{
    "name": "AO East",
    "kind": "recon",
    "color": "#F2A900",
    "polygon": [[106.81, -6.20], [106.83, -6.20], [106.82, -6.22]]
  }]
}
```

Transaksi: gagal di tengah → rollback seluruh create.

---

### Update — `PATCH /api/operations/:operationId` → `OperationDetail`

Body allowed: `name`, `description`, `start_at`, `end_at`, `type`, `group_ids`, `geofence_ids`.  
Minimal satu field. `group_ids` / `geofence_ids` = **replace penuh** link (bukan merge).  
`status` → `422 unexpected fields`. Jangan kirim `groups` / `new_geofences` di PATCH — pakai nested POST.

---

### Delete — `DELETE /api/operations/:operationId` → `204`

| Status sekarang | Hasil |
|-----------------|-------|
| PLANNING, COMPLETED, CANCELLED | soft-delete OK |
| ACTIVE, ON_HOLD | `409` — complete/cancel dulu |

---

### Lifecycle (body kosong) → `OperationDetail`

| Method | Path | Dari → Ke |
|--------|------|-----------|
| POST | `.../activate` | PLANNING → ACTIVE |
| POST | `.../hold` | ACTIVE → ON_HOLD |
| POST | `.../resume` | ON_HOLD → ACTIVE |
| POST | `.../complete` | ACTIVE \| ON_HOLD → COMPLETED (+ `completed_at`) |
| POST | `.../cancel` | PLANNING \| ACTIVE \| ON_HOLD → CANCELLED |

Salah transisi → `409` (`operation cannot move from X to Y`).

---

### Nested groups / geofences

#### `POST .../groups` → `OperationDetail`

Opsi A — link existing:

```json
{ "group_id": 1 }
```

Opsi B — create + link (sama `InlineGroup`):

```json
{
  "name": "Bravo Cell",
  "leader_soldier_id": 111,
  "member_soldier_ids": [111, 112]
}
```

Duplicate → `409`. Missing → `422`.

#### `DELETE .../groups/:groupId` → `OperationDetail`

Unlink saja (group Settings tidak dihapus). Belum linked → `404`.

#### `POST .../geofences` → `OperationDetail`

```json
{ "geofence_id": 1 }
```

atau body `InlineGeofence` (`name` + `polygon` / `geometry_json`).

#### `DELETE .../geofences/:geofenceId` → `OperationDetail`

Unlink; belum linked → `404`.

---

### Scope derived data

```
operation_groups → group_members → personnel (+ last TELEMETRY)
```

Fallback: `personnel.group_id` jika members kosong.

### FE flow singkat (wizard)

1. Login → simpan Bearer.  
2. `GET .../groups/options` + `GET .../personnel/options?q=` (+ `GET /api/geofences` jika perlu).  
3. `POST /api/operations` sekali di Review.  
4. Redirect: `GET /api/operations/:id` + `GET .../map`.  
5. Tombol lifecycle sesuai `status` + permission write.  
6. Jangan kirim `status` saat create; jangan PATCH `status`.

---

## 13. Tickets

Ticket **hanya** dibuat dari alert (`POST /api/alerts/:id/ticket`).  
`POST /api/tickets` → **405 Method Not Allowed**.  
**Auth:** Bearer session; create-from-alert requires **`tickets` write** (domain `tickets` in the permission catalog).

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
