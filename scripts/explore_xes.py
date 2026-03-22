"""
explore_xes.py
--------------
Inspect a XES event log before converting it. Prints attribute names,
value samples, timestamp range, activity list, and trace length statistics.

Usage:
    python scripts/explore_xes.py data/raw/BPI_Challenge_2019.xes
    python scripts/explore_xes.py data/raw/BPI_Challenge_2019.xes --traces 3
"""

import argparse
import sys
from pathlib import Path

import pandas as pd
import pm4py


def explore(xes_path: Path, show_traces: int = 0) -> None:
    print(f"\n{'='*60}")
    print(f"  XES EXPLORER: {xes_path.name}")
    print(f"{'='*60}\n")

    print("Loading...")
    log = pm4py.read_xes(str(xes_path))
    df = pm4py.convert_to_dataframe(log)
    print(f"  {len(log)} traces, {len(df)} events\n")

    # ── Columns ───────────────────────────────────────────────────────────────
    case_cols  = [c for c in df.columns if c.startswith("case:")]
    event_cols = [c for c in df.columns if not c.startswith("case:")]

    print(f"── Case-level attributes ({len(case_cols)}) ────────────────────────")
    for c in case_cols:
        sample = df[c].dropna().iloc[0] if df[c].notna().any() else "N/A"
        print(f"  {c:<50} unique={df[c].nunique():<8} sample={repr(str(sample)[:50])}")

    print(f"\n── Event-level attributes ({len(event_cols)}) ───────────────────────")
    for c in event_cols:
        sample = df[c].dropna().iloc[0] if df[c].notna().any() else "N/A"
        print(f"  {c:<50} unique={df[c].nunique():<8} nulls={df[c].isna().sum():<8} sample={repr(str(sample)[:50])}")

    # ── Timestamp ─────────────────────────────────────────────────────────────
    if "time:timestamp" in df.columns:
        df["time:timestamp"] = pd.to_datetime(df["time:timestamp"], utc=True)
        print(f"\n── Timestamp range ───────────────────────────────────────────")
        print(f"  Min: {df['time:timestamp'].min()}")
        print(f"  Max: {df['time:timestamp'].max()}")

    # ── Activities ────────────────────────────────────────────────────────────
    if "concept:name" in df.columns:
        acts = df["concept:name"].value_counts()
        print(f"\n── Activities ({len(acts)} unique) ───────────────────────────────")
        for act, count in acts.items():
            print(f"  {count:>8}  {act}")

    # ── Trace lengths ─────────────────────────────────────────────────────────
    lengths = df.groupby("case:concept:name").size()
    print(f"\n── Trace length distribution ─────────────────────────────────")
    print(f"  Min={lengths.min()}  Max={lengths.max()}  "
          f"Median={lengths.median():.1f}  Mean={lengths.mean():.1f}")

    # ── Optional raw traces ───────────────────────────────────────────────────
    if show_traces > 0:
        print(f"\n── First {show_traces} traces ────────────────────────────────────")
        for i, trace in enumerate(log[:show_traces]):
            print(f"\n  [{trace.attributes.get('concept:name', i)}]")
            for event in trace:
                print(f"    {event.get('time:timestamp','')}  {event.get('concept:name','')}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("xes", type=Path)
    parser.add_argument("--traces", type=int, default=0)
    args = parser.parse_args()
    if not args.xes.exists():
        print(f"File not found: {args.xes}", file=sys.stderr)
        sys.exit(1)
    explore(args.xes, args.traces)


if __name__ == "__main__":
    main()
