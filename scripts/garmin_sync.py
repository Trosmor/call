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


def summarize_day(client, day: date) -> dict:
    d = day.isoformat()
    out = {"date": d}

    stats = safe_call(client.get_stats, d, default={})
    out["steps"] = stats.get("totalSteps")
    out["activeCalories"] = stats.get("activeKilocalories")
    out["totalCalories"] = stats.get("totalKilocalories")
    out["restingHeartRate"] = stats.get("restingHeartRate")

    sleep = safe_call(client.get_sleep_data, d, default={})
    daily_sleep = (sleep or {}).get("dailySleepDTO") or {}
    sleep_seconds = daily_sleep.get("sleepTimeSeconds")
    out["sleepHours"] = round(sleep_seconds / 3600, 1) if sleep_seconds else None
    out["sleepScore"] = ((sleep or {}).get("sleepScores") or {}).get("overall", {}).get("value")

    hrv = safe_call(client.get_hrv_data, d, default={})
    hrv_summary = (hrv or {}).get("hrvSummary") or {}
    out["hrvLastNightAvg"] = hrv_summary.get("lastNightAvg")
    out["hrvStatus"] = hrv_summary.get("status")

    stress = safe_call(client.get_all_day_stress, d, default={})
    out["avgStressLevel"] = (stress or {}).get("avgStressLevel")

    battery = safe_call(client.get_body_battery, d, d, default=[])
    if battery:
        values = (battery[0] or {}).get("bodyBatteryValuesArray") or []
        levels = [v[1] for v in values if isinstance(v, list) and len(v) > 1 and v[1] is not None]
        out["bodyBatteryHigh"] = max(levels) if levels else None
        out["bodyBatteryLow"] = min(levels) if levels else None
    else:
        out["bodyBatteryHigh"] = None
        out["bodyBatteryLow"] = None

    body_comp = safe_call(client.get_body_composition, d, default={})
    weight_g = (body_comp or {}).get("totalAverage", {}).get("weight")
    out["weightKg"] = round(weight_g / 1000, 1) if weight_g else None

    activities = safe_call(client.get_activities_by_date, d, d, default=[]) or []
    out["activities"] = [
        {
            "name": a.get("activityName"),
            "type": (a.get("activityType") or {}).get("typeKey"),
            "durationMin": round((a.get("duration") or 0) / 60, 1),
            "calories": a.get("calories"),
            "avgHeartRate": a.get("averageHR"),
        }
        for a in activities
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

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps({"syncedAt": datetime.now(timezone.utc).isoformat(), "days": days}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_PATH} ({len(days)} days).")


if __name__ == "__main__":
    main()
