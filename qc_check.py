from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
STATIONS = ROOT / "stations.csv"
DETECTIONS = ROOT / "detections.csv"

VALID_BANDS = {"0-25", "25-50", "50-100", ">100"}
VALID_POINT_TYPES = {"view", "radius"}
BEYOND = ">100"

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

    # Distance is required at the radius stations and not recorded at the view
    # stations, where the count is a harbor scan with no fixed radius.
    view_ids = set(stations.loc[stations.point_type == "view", "station_id"])
    radius_rows = detections[~detections.station_id.isin(view_ids)]
    no_band = radius_rows[radius_rows.distance_band.isna() | (radius_rows.distance_band == "")]
    for sid, n in no_band.groupby("station_id").size().items():
        problems.append(
            f"{sid} is a radius station but {n} of its rows have no distance_band "
            "— those birds are invisible to the within-100 m figure"
        )

    view_rows = detections[detections.station_id.isin(view_ids)]
    has_band = view_rows[view_rows.distance_band.notna() & (view_rows.distance_band != "")]
    if len(has_band):
        warnings.append(
            f"{len(has_band)} rows at the view stations still carry a distance_band; "
            "harmless, the map ignores it there"
        )

    mixed = detections.groupby("species_code").common_name.nunique()
    for code in mixed[mixed > 1].index:
        names = sorted(detections.loc[detections.species_code == code, "common_name"].unique())
        problems.append(f"species_code {code} used for more than one name: {names}")

    for field in ("time", "weather", "date"):
        if field not in detections.columns:
            warnings.append(f"no {field} column — effort data is incomplete")
            continue
        clashes = detections.groupby(["week", "station_id"])[field].nunique()
        for (wk, sid) in clashes[clashes > 1].index:
            problems.append(f"week {wk} {sid} has more than one {field} value")

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

    is_view = merged.station_id.isin(view_ids)

    # The within/beyond split only applies at the radius stations. View
    # stations report one total, matching what the map shows.
    radius = merged[~is_view]
    inside = radius[radius.distance_band != BEYOND]

    summary = pd.DataFrame(
        {
            "type": merged.groupby("station_id").point_type.first(),
            "habitat": merged.groupby("station_id").habitat_type.first(),
            "total": merged.groupby("station_id")["count"].sum(),
            "within100": inside.groupby("station_id")["count"].sum(),
            "beyond100": radius[radius.distance_band == BEYOND].groupby("station_id")["count"].sum(),
            "species": merged.groupby("station_id").species_code.nunique(),
        }
    )
    # a dash where the figure does not apply, rather than a misleading zero
    for col in ("within100", "beyond100"):
        summary[col] = summary[col].map(
            lambda v: "—" if pd.isna(v) else str(int(v))
        )
    summary[["total", "species"]] = summary[["total", "species"]].fillna(0).astype(int)

    print(summary.sort_values("total", ascending=False).to_string())
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
