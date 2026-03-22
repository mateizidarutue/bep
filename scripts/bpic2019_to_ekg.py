"""
bpic2019_to_ekg.py
------------------
Converts the BPI Challenge 2019 XES event log into EKG-format CSVs.

Dataset:
    Purchase order handling process of a large Dutch multinational.
    van Dongen, B.F. (2019). BPI Challenge 2019. 4TU.ResearchData.
    https://doi.org/10.4121/uuid:d06aff4b-79f0-45e6-8ec8-e19730c248f1

XES structure:
    case:concept:name        — "<PurchasingDocument>_<Item>", e.g. "5100000000_1"
    case:Purchasing Document — The Purchase Order document ID
    concept:name             — Activity name (42 unique activities)
    time:timestamp           — Event timestamp
    org:resource             — User or batch job

Entity types (native multi-object):
    PO      — Purchase Order document  (case:Purchasing Document)
    POItem  — Purchase Order line item (case:concept:name)

Each event is correlated to both its PO and its POItem.
DF edges are built separately per entity type.

Usage:
    python scripts/bpic2019_to_ekg.py \\
        --input  data/raw/BPI_Challenge_2019.xes \\
        --output output/

    python scripts/bpic2019_to_ekg.py \\
        --input  data/raw/BPI_Challenge_2019.xes \\
        --output output/ \\
        --sample 1000
"""

import argparse
import sys
from pathlib import Path

import pandas as pd
import pm4py
from tqdm import tqdm

# ── Constants ─────────────────────────────────────────────────────────────────

LOG_ID       = "LOG_BPIC2019"
PO_COL       = "case:Purchasing Document"   # canonical XES attribute name
ITEM_COL     = "case:concept:name"          # full "<PO>_<item>" case ID

ENTITY_TYPE_PO     = "PO"
ENTITY_TYPE_POITEM = "POItem"

# Case-level attributes to carry onto Event nodes.
# The BPIC 2019 XES stores these on the first event of each trace.
CASE_ATTRS = [
    "case:Purchasing Document",
    "case:Item Type",
    "case:Item Category",
    "case:Spend area text",
    "case:Spend classification text",
    "case:Sub spend area text",
    "case:Company",
    "case:Document Type",
    "case:Source",
    "case:Vendor",
    "case:Name",
    "case:GR-Based Inv. Verif.",
    "case:Goods Receipt",
]

EVENT_ATTRS = [
    "org:resource",
    "lifecycle:transition",
]


# ── Load ──────────────────────────────────────────────────────────────────────

def load(xes_path: Path, sample: int | None) -> pd.DataFrame:
    print(f"Loading: {xes_path}")
    log = pm4py.read_xes(str(xes_path))
    if sample is not None:
        print(f"  Sampling first {sample} cases...")
    df = pm4py.convert_to_dataframe(log)
    df["time:timestamp"] = pd.to_datetime(df["time:timestamp"], utc=True)

    # Filter out events with clearly erroneous timestamps (known data quality issue)
    n_before = len(df)
    df = df[df["time:timestamp"].dt.year >= 2015].copy()
    n_dropped = n_before - len(df)
    if n_dropped > 0:
        print(f"  Dropped {n_dropped} events with timestamps before 2015 (data quality filter)")

    # Force PO column to string early — pandas reads it as float (2000000000.0)
    # which would produce IDs like "2000000000.0" throughout the pipeline
    if PO_COL in df.columns:
        df[PO_COL] = df[PO_COL].astype("Int64").astype(str).replace("<NA>", pd.NA)

    # Sample by unique case IDs, not by raw row count
    if sample is not None:
        case_ids = df[ITEM_COL].unique()[:sample]
        df = df[df[ITEM_COL].isin(case_ids)].copy()

    df = df.sort_values([ITEM_COL, "time:timestamp"]).reset_index(drop=True)
    print(f"  {len(df)} events, {df[ITEM_COL].nunique()} POItems", end="")
    if PO_COL in df.columns:
        print(f", {df[PO_COL].nunique()} POs")
    else:
        print()
    return df


# ── Resolve PO column ─────────────────────────────────────────────────────────

def resolve_po_col(df: pd.DataFrame) -> str:
    """
    Return the column holding the PO document ID.
    Falls back to splitting the case ID on the last '_' if the canonical
    attribute is missing (some XES exports omit it).
    """
    if PO_COL in df.columns and df[PO_COL].notna().any():
        return PO_COL
    print(f"  Warning: '{PO_COL}' not found — deriving PO ID from case ID")
    df["_po_derived"] = df[ITEM_COL].str.rsplit("_", n=1).str[0]
    return "_po_derived"


# ── Build nodes ───────────────────────────────────────────────────────────────

def build_events(df: pd.DataFrame, po_col: str) -> pd.DataFrame:
    events = pd.DataFrame({
        "event_id":  "E_" + df.index.astype(str),
        "activity":  df["concept:name"],
        "timestamp": df["time:timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "po_id":     df[po_col].astype(str),
        "poitem_id": df[ITEM_COL],
    })
    for col in EVENT_ATTRS:
        if col in df.columns:
            events[col.replace(":", "_")] = df[col].values
    for col in CASE_ATTRS:
        if col in df.columns:
            key = col.replace("case:", "").replace(" ", "_").replace("-", "_").replace(".", "")
            # propagate first non-null value within each case (first-event storage pattern)
            events[key] = df.groupby(ITEM_COL)[col].transform("first").values
    return events


def build_entities(df: pd.DataFrame, po_col: str) -> pd.DataFrame:
    poitems = pd.DataFrame({
        "entity_id":  df[ITEM_COL].unique(),
        "EntityType": ENTITY_TYPE_POITEM,
    })
    pos = pd.DataFrame({
        "entity_id":  df[po_col].dropna().unique(),
        "EntityType": ENTITY_TYPE_PO,
    })
    # Concatenate separately — no risk of cross-type deduplication
    return pd.concat([poitems, pos], ignore_index=True)


# ── Build edges ───────────────────────────────────────────────────────────────

def build_corr(df: pd.DataFrame, po_col: str) -> pd.DataFrame:
    poitem_corr = pd.DataFrame({
        "event_id":  "E_" + df.index.astype(str),
        "entity_id": df[ITEM_COL].values,
    })
    po_corr = pd.DataFrame({
        "event_id":  "E_" + df.index.astype(str),
        "entity_id": df[po_col].astype(str).values,
    })
    return pd.concat([poitem_corr, po_corr], ignore_index=True)


def _df_edges_for(df: pd.DataFrame, group_col: str, entity_type: str) -> list[dict]:
    df = df.copy()
    df["event_id"] = "E_" + df.index.astype(str)
    records = []
    for entity_id, group in tqdm(
        df.groupby(group_col, sort=False),
        desc=f"DF — {entity_type}",
        total=df[group_col].nunique(),
    ):
        eids = group.sort_values("time:timestamp")["event_id"].tolist()
        for i in range(len(eids) - 1):
            records.append({
                "source_event_id": eids[i],
                "target_event_id": eids[i + 1],
                "entity_id":       str(entity_id),
                "EntityType":      entity_type,
            })
    return records


def build_df(df: pd.DataFrame, po_col: str) -> pd.DataFrame:
    records = (
        _df_edges_for(df, ITEM_COL, ENTITY_TYPE_POITEM) +
        _df_edges_for(df, po_col,   ENTITY_TYPE_PO)
    )
    return pd.DataFrame(records)


def build_log_has(events: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    log_df = pd.DataFrame({"log_id": [LOG_ID]})
    has_df = pd.DataFrame({"log_id": LOG_ID, "event_id": events["event_id"]})
    return log_df, has_df


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert BPI Challenge 2019 XES to EKG CSVs."
    )
    parser.add_argument("--input",  type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample", type=int,  default=None, metavar="N",
                        help="Use only the first N cases (for testing)")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    args.output.mkdir(parents=True, exist_ok=True)

    df     = load(args.input, args.sample)
    po_col = resolve_po_col(df)
    print(f"  PO column: '{po_col}'")

    print("Building Event nodes...")
    events   = build_events(df, po_col)

    print("Building Entity nodes...")
    entities = build_entities(df, po_col)

    print("Building CORR edges...")
    corr     = build_corr(df, po_col)

    print("Building DF edges...")
    df_edges = build_df(df, po_col)

    print("Building Log + HAS edges...")
    log_df, has_df = build_log_has(events)

    out = args.output
    events.to_csv(  out / "events.csv",   index=False)
    entities.to_csv(out / "entities.csv", index=False)
    corr.to_csv(    out / "corr.csv",     index=False)
    df_edges.to_csv(out / "df.csv",       index=False)
    log_df.to_csv(  out / "log.csv",      index=False)
    has_df.to_csv(  out / "has.csv",      index=False)

    print(f"\n✓ Done — {out.resolve()}")
    print(f"  Events:   {len(events)}")
    print(f"  Entities: {len(entities)}  "
          f"(PO: {(entities['EntityType'] == ENTITY_TYPE_PO).sum()}, "
          f"POItem: {(entities['EntityType'] == ENTITY_TYPE_POITEM).sum()})")
    print(f"  CORR:     {len(corr)}")
    print(f"  DF:       {len(df_edges)}")


if __name__ == "__main__":
    main()
