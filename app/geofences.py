import json
import math
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from .database import get_connection

router = APIRouter(prefix="/api/geofences", tags=["Geofences"])


class GeofenceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=200)
    status: str = "active"
    groups: list[str] = Field(default_factory=list, max_length=8)
    polygon: list[list[float]] = Field(min_length=3, max_length=3)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("name is required")
        return name

    @field_validator("status")
    @classmethod
    def clean_status(cls, value: str) -> str:
        if value not in {"active", "inactive"}:
            raise ValueError("status must be active or inactive")
        return value

    @field_validator("groups")
    @classmethod
    def clean_groups(cls, value: list[str]) -> list[str]:
        groups = []
        for item in value:
            name = item.strip()
            if name and name not in groups:
                groups.append(name[:40])
        return groups

    @field_validator("polygon")
    @classmethod
    def clean_polygon(cls, value: list[list[float]]) -> list[list[float]]:
        points: list[list[float]] = []
        for point in value:
            if len(point) != 2:
                raise ValueError("each corner needs longitude and latitude")
            lng, lat = float(point[0]), float(point[1])
            if not math.isfinite(lng) or not math.isfinite(lat):
                raise ValueError("corner is not a number")
            if not -180 <= lng <= 180 or not -90 <= lat <= 90:
                raise ValueError("corner is outside the map")
            points.append([lng, lat])
        return points


class GeofenceOut(BaseModel):
    id: int
    name: str
    description: str
    type: str
    status: str
    groups: list[str]
    polygon: list[list[float]]
    area_km2: float
    triggered_24h: int
    last_triggered: str | None
    created_at: str


class GeofenceList(BaseModel):
    items: list[GeofenceOut]


def _area_km2(points: list[list[float]]) -> float:
    area = 0.0
    for index, (lng, lat) in enumerate(points):
        next_lng, next_lat = points[(index + 1) % len(points)]
        area += lng * next_lat - next_lng * lat
    area = abs(area) / 2
    mean_lat = sum(point[1] for point in points) / len(points)
    km_lat = 111.32
    km_lng = 111.32 * math.cos(math.radians(mean_lat))
    return round(area * km_lat * km_lng, 1)


def _row_to_api(row) -> dict:
    polygon = json.loads(row["polygon_json"])
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "type": row["type"],
        "status": row["status"],
        "groups": json.loads(row["groups_json"]),
        "polygon": polygon,
        "area_km2": row["area_km2"],
        "triggered_24h": 0,
        "last_triggered": None,
        "created_at": row["created_at"],
    }


@router.get("", response_model=GeofenceList)
def list_geofences():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM geofences ORDER BY id DESC").fetchall()
    return {"items": [_row_to_api(row) for row in rows]}


@router.post("", response_model=GeofenceOut, status_code=201)
def create_geofence(body: GeofenceIn):
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    area = _area_km2(body.polygon)
    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO geofences (name, description, type, status, groups_json, polygon_json, area_km2, created_at)
            VALUES (?, ?, 'silent', ?, ?, ?, ?, ?)
            """,
            (
                body.name,
                body.description.strip(),
                body.status,
                json.dumps(body.groups),
                json.dumps(body.polygon),
                area,
                created_at,
            ),
        )
        row = conn.execute("SELECT * FROM geofences WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _row_to_api(row)


@router.delete("/{geofence_id}", status_code=204)
def delete_geofence(geofence_id: int):
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM geofences WHERE id = ?", (geofence_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Geofence not found")
    return None
