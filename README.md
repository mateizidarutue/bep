# EKG Preprocessing — BPI Challenge 2019

Preprocessing pipeline for building an Event Knowledge Graph (EKG) from the BPI Challenge 2019 XES event log, as part of the Bachelor End Project *"Layout Algorithm for Event Knowledge Graphs"* at TU/e (2025–2026).

**Dataset:** Purchase order handling process of a large Dutch multinational.
**Source:** van Dongen, B.F. (2019). BPI Challenge 2019. 4TU.ResearchData. https://doi.org/10.4121/uuid:d06aff4b-79f0-45e6-8ec8-e19730c248f1

---

## EKG Data Model

| Node label | Key attributes                  | Description                       |
|------------|---------------------------------|-----------------------------------|
| `:Event`   | `id`, `activity`, `timestamp`   | One node per event occurrence     |
| `:Entity`  | `id`, `EntityType`              | One node per entity instance      |
| `:Log`     | `id`                            | One node for the whole log        |

| Relationship | From → To            | Description                               |
|--------------|----------------------|-------------------------------------------|
| `:CORR`      | `:Event` → `:Entity` | Event is correlated to entity             |
| `:DF`        | `:Event` → `:Event`  | Directly-follows per entity               |
| `:HAS`       | `:Log` → `:Event`    | Log contains event                        |

**Entity types:**
- `PO` — Purchase Order document (`case:Purchasing Document`)
- `POItem` — Purchase Order line item (`case:concept:name`, i.e. the full case ID)

---

## Repository Structure

```
ekg-bpic2019/
├── README.md
├── requirements.txt
├── .gitignore
│
├── scripts/
│   ├── explore_xes.py          # Inspect the XES before converting
│   └── bpic2019_to_ekg.py      # XES → EKG CSVs
│
├── data/
│   └── raw/                    # Place BPI_Challenge_2019.xes here (not committed)
│
├── output/                     # Generated CSVs land here (not committed)
│
└── docs/
    └── neo4j_import.md         # Cypher LOAD CSV commands
```

---

## Setup

```bash
pip install -r requirements.txt
```

---

## Usage

### 1. Explore the log first

```bash
python scripts/explore_xes.py data/raw/BPI_Challenge_2019.xes
```

### 2. Convert to EKG CSVs

Full log:
```bash
python scripts/bpic2019_to_ekg.py \
    --input data/raw/BPI_Challenge_2019.xes \
    --output output/
```

Sample (first N cases — useful for testing):
```bash
python scripts/bpic2019_to_ekg.py \
    --input data/raw/BPI_Challenge_2019.xes \
    --output output/ \
    --sample 1000
```

### 3. Load into Neo4j

See [`docs/neo4j_import.md`](docs/neo4j_import.md).

---

## Output Files

All six files are written to `--output`:

| File           | Contents                                      |
|----------------|-----------------------------------------------|
| `events.csv`   | Event nodes with activity, timestamp, attrs   |
| `entities.csv` | Entity nodes with EntityType (PO or POItem)   |
| `corr.csv`     | CORR edges: event → entity                    |
| `df.csv`       | DF edges: event → event per entity            |
| `log.csv`      | Single log node                               |
| `has.csv`      | HAS edges: log → event                        |

---

## References

- Esser, S., & Fahland, D. (2021). Multi-dimensional event data in graph databases. *Journal on Data Semantics*, 10(1–2), 109–141.
- van Dongen, B.F. (2019). BPI Challenge 2019. 4TU.ResearchData. https://doi.org/10.4121/uuid:d06aff4b-79f0-45e6-8ec8-e19730c248f1
