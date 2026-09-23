"""
Daily Garmin Connect sync — run by .github/workflows/garmin-sync.yml.

Resumes a session from a previously-saved token store (see garmin_login.py,
run once locally) and writes a compact JSON summary of the last N days to
data/garmin.json, which the static PWA fetches directly.

Field extraction is defensive (.get() with fallbacks) because Garmin's
internal API isn't officially documented — some fields may be missing for a
given day (e.g. no smart scale weigh-in, no HRV on older watches) and that's
expected, not a bug.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from garminconnect import Garmin

TOKEN_STORE = os.getenv("GARMINTOKENS", str(Path("~/.garminconnect").expanduser()))
DAYS_BACK = int(os.getenv("GARMIN_SYNC_DAYS", "14"))
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "garmin.json"


def safe_call(fn, *args, default=None):
    try:
        return fn(*args)
    except Exception as e:  # Garmin's API is flaky/undocumented — skip, don't crash the whole sync.
        print(f"  warn: {fn.__name__} failed: {e}", file=sys.stderr)
        return default


def as_dict(value) -> dict:
    """Garmin endpoints return None / lists / dicts inconsistently; `.get` on anything but a
    dict raised AttributeError OUTSIDE safe_call and aborted the whole sync run."""
    return value if isinstance(value, dict) else {}


def summarize_day(client, day: date) -> dict:
    d = day.isoformat()
    out = {"date": d}

    stats = as_dict(safe_call(client.get_stats, d))
    out["steps"] = stats.get("totalSteps")
    out["activeCalories"] = stats.get("activeKilocalories")
    out["totalCalories"] = stats.get("totalKilocalories")
    out["restingHeartRate"] = stats.get("restingHeartRate")

    sleep = as_dict(safe_call(client.get_sleep_data, d))
    sleep_seconds = as_dict(sleep.get("dailySleepDTO")).get("sleepTimeSeconds")
    out["sleepHours"] = round(sleep_seconds / 3600, 1) if sleep_seconds else None
    out["sleepScore"] = as_dict(as_dict(sleep.get("sleepScores")).get("overall")).get("value")

    hrv_summary = as_dict(as_dict(safe_call(client.get_hrv_data, d)).get("hrvSummary"))
    out["hrvLastNightAvg"] = hrv_summary.get("lastNightAvg")
    out["hrvStatus"] = hrv_summary.get("status")

    out["avgStressLevel"] = as_dict(safe_call(client.get_all_day_stress, d)).get("avgStressLevel")

    battery = safe_call(client.get_body_battery, d, d, default=[])
    first = as_dict(battery[0]) if isinstance(battery, list) and battery else {}
    values = first.get("bodyBatteryValuesArray") or []
    levels = [v[1] for v in values if isinstance(v, list) and len(v) > 1 and v[1] is not None]
    out["bodyBatteryHigh"] = max(levels) if levels else None
    out["bodyBatteryLow"] = min(levels) if levels else None

    body_comp = as_dict(safe_call(client.get_body_composition, d))
    weight_g = as_dict(body_comp.get("totalAverage")).get("weight")
    out["weightKg"] = round(weight_g / 1000, 1) if weight_g else None

    activities = safe_call(client.get_activities_by_date, d, d, default=[])
    out["activities"] = [
        {
            "name": a.get("activityName"),
            "type": as_dict(a.get("activityType")).get("typeKey"),
            "durationMin": round((a.get("duration") or 0) / 60, 1),
            "calories": a.get("calories"),
            "avgHeartRate": a.get("averageHR"),
        }
        for a in (activities if isinstance(activities, list) else [])
        if isinstance(a, dict)
    ]

    return out


def main():
    client = Garmin()
    client.login(TOKEN_STORE)
    print("Resumed Garmin session from token store.")

    today = date.today()
    days = []
    for i in range(DAYS_BACK):
        day = today - timedelta(days=i)
        print(f"Fetching {day.isoformat()}...")
        days.append(summarize_day(client, day))

    # Only rewrite the file when the data itself changed. Writing a fresh syncedAt on every
    # run meant the "commit only if changed" step committed every 2 hours around the clock
    # (≈550 commits in 2 months, each triggering a Pages rebuild). syncedAt now means "when
    # the data last changed", which the app shows as the sync age.
    try:
        previous = json.loads(OUTPUT_PATH.read_text(encoding="utf-8")).get("days")
    except (OSError, ValueError):
        previous = None
    if previous == days:
        print("No changes in Garmin data - leaving data/garmin.json untouched.")
        return

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps({"syncedAt": datetime.now(timezone.utc).isoformat(), "days": days}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_PATH} ({len(days)} days).")


if __name__ == "__main__":
    main()
