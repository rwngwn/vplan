import asyncio

from app.main import healthz


def test_healthz_endpoint():
    assert asyncio.run(healthz()) == {"status": "ok"}
