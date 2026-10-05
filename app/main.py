from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel
from .alerts import router as alerts_router
from .api.operations import router as operations_router
from .api.tickets import alert_ticket_router, router as tickets_router
from .audit import router as audit_router
from .bindings import router as bindings_router
from .database import init_db
from .explorer import router as explorer_router
from .geofences import router as geofences_router
from .history import router as history_router
from .ingest import router as ingest_router
from .profile import auth_router, profile_router
from .roles import catalog_router, router as roles_router
from .users import router as users_router


class HealthOut(BaseModel):
    status: str
    storage: str


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="TrackForge Backend",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthOut, tags=["Health"])
def health():
    return {
        "status": "ok",
        "storage": "sqlite-local",
    }


app.include_router(explorer_router)
app.include_router(geofences_router)
app.include_router(alerts_router)
app.include_router(alert_ticket_router)
app.include_router(tickets_router)
app.include_router(history_router)
app.include_router(operations_router)
app.include_router(users_router)
app.include_router(auth_router)
app.include_router(profile_router)
app.include_router(roles_router)
app.include_router(catalog_router)
app.include_router(bindings_router)
app.include_router(audit_router)
app.include_router(ingest_router)
