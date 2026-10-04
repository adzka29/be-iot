import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TRACKFORGE_DB", str(tmp_path / "trackforge.db"))
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
