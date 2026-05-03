from datetime import datetime, timezone, timedelta

from app.auto_analysis import AutoAnalysisPipeline


def test_auto_analysis_debounce_coalesce_and_idempotency():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def now_fn():
        return now

    telemetry = {}
    pipeline = AutoAnalysisPipeline(telemetry, now_fn=now_fn)
    pipeline.min_delta_chars = 1

    pipeline.enqueue("t1", "note_saved", "hello world", "k1")
    assert pipeline.run_ready() == []

    now_plus = now + timedelta(seconds=3)
    now = now_plus
    out = pipeline.run_ready()
    assert len(out) == 1

    pipeline.enqueue("t1", "note_saved", "hello world", "k1")
    assert telemetry.get("auto_analysis_idempotent_skips", 0) >= 1
