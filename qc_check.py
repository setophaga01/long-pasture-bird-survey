#!/usr/bin/env python3
"""Pre-publish checks for the Long Pasture survey CSVs.

Run this after each survey, before committing:

    python scripts/qc_check.py

It does not modify anything. It prints problems and a per-station summary,
and exits 1 if it found something that would misrepresent the data on the map.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
STATIONS = ROOT / "data" / "stations.csv"
DETECTIONS = ROOT / "data" / "detections.csv"

VALID_BANDS = {"0-25", "25-50", "50-100", ">100"}
VALID_POINT_TYPES = {"view", "radius"}
BEYOND = ">100"

# Long Pasture sits in a small box. Anything outside it is a typo or a
# dropped minus sign, which is the classic way a station lands in Asia.
LAT_RANGE = (41.69, 41.72)
LON_RANGE = (-70.29, -70.26)


def main() -> int:
    problems: list[str] = []
    warnings: list[str] = []

    stations = pd.read_csv(STATIONS)
    detections = pd.read_csv(DETECTIONS)

    # --- stations -----------------------------------------------------

    if stations.station_id.duplicated().any():
        dupes = stations.loc[stations.station_id.duplicated(), "station_id"].tolist()
        problems.append(f"duplicate station_id: {dupes}")

    bad_type = set(stations.point_type.dropna()) - VALID_POINT_TYPES
    if bad_type:
        problems.append(f"unexpected point_type values: {sorted(bad_type)}")

    off_map = stations[
        ~stations.lat.between(*LAT_RANGE) | ~stations.lon.between(*LON_RANGE)
    ]
    for _, row in off_map.iterrows():
        problems.append(
            f"{row.station_id} at {row.lat}, {row.lon} is outside the sanctuary box "
            "— check for a sign error or swapped lat/lon"
        )

    # --- detections ---------------------------------------------------

    bad_bands = set(detections.distance_band.dropna()) - VALID_BANDS
    if bad_bands:
        problems.append(f"unexpected distance_band values: {sorted(bad_bands)}")

    orphans = set(detections.station_id) - set(stations.station_id)
    if orphans:
        problems.append(f"detections reference unknown stations: {sorted(orphans)}")

    if (detections["count"] <= 0).any():
        problems.append("at least one detection has a count of zero or less")

    missing = detections[detections.common_name.isna() | detections.species_code.isna()]
    if len(missing):
        problems.append(f"{len(missing)} detection rows are missing a species")

    # One species code should map to exactly one common name, always.
    mixed = detections.groupby("species_code").common_name.nunique()
    for code in mixed[mixed > 1].index:
        names = sorted(detections.loc[detections.species_code == code, "common_name"].unique())
        problems.append(f"species_code {code} used for more than one name: {names}")

    # Effort fields repeat on every row of a visit, so they must agree.
    for field in ("time", "weather", "date"):
        if field not in detections.columns:
            warnings.append(f"no {field} column — effort data is incomplete")
            continue
        clashes = detections.groupby(["week", "station_id"])[field].nunique()
        for (wk, sid) in clashes[clashes > 1].index:
            problems.append(f"week {wk} {sid} has more than one {field} value")

    # Same station, species and band twice in a visit: legal, but it means
    # nothing in the row distinguishes them. Worth a look before publishing.
    key = ["week", "station_id", "species_code", "distance_band"]
    if all(k in detections.columns for k in key):
        repeats = detections.groupby(key).size()
        repeats = repeats[repeats > 1]
        for idx, n in repeats.items():
            warnings.append(
                f"week {idx[0]} {idx[1]}: {idx[2]} appears {n}× in band {idx[3]} "
                "— sum these into one row unless they were separate groups"
            )

    # --- summary ------------------------------------------------------

    merged = detections.merge(
        stations[["station_id", "point_type", "habitat_type"]], on="station_id", how="left"
    )
    inside = merged[merged.distance_band != BEYOND]

    summary = pd.DataFrame(
        {
            "type": merged.groupby("station_id").point_type.first(),
            "habitat": merged.groupby("station_id").habitat_type.first(),
            "within100": inside.groupby("station_id")["count"].sum(),
            "beyond100": merged[merged.distance_band == BEYOND].groupby("station_id")["count"].sum(),
            "species": inside.groupby("station_id").species_code.nunique(),
        }
    ).fillna(0)
    summary[["within100", "beyond100", "species"]] = summary[
        ["within100", "beyond100", "species"]
    ].astype(int)

    print(summary.sort_values("within100", ascending=False).to_string())
    print()
    weeks = sorted(int(w) for w in detections.week.dropna().unique()) if "week" in detections else []
    print(
        f"{len(detections)} detections · {detections['count'].sum()} individuals · "
        f"{detections.species_code.nunique()} species · weeks {weeks}"
    )
    print()

    for w in warnings:
        print(f"note:    {w}")
    for p in problems:
        print(f"PROBLEM: {p}")

    if not problems:
        print("No blocking problems found.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
