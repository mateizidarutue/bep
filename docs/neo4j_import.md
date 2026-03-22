# Loading BPIC 2019 EKG into Neo4j

## Prerequisites

- Neo4j Desktop (≥ 4.x) with APOC plugin
- CSVs accessible via URL (GitHub raw) or placed in `$NEO4J_HOME/import/`
- Heap: at least **5 GB** for the full log (`dbms.memory.heap.max_size=5G`)

Replace `<BASE_URL>` below with your GitHub raw base URL or `file:///path/to/output`.

---

## 1 — Constraints

```cypher
CREATE CONSTRAINT event_id  IF NOT EXISTS FOR (e:Event)  REQUIRE e.id IS UNIQUE;
CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT log_id    IF NOT EXISTS FOR (l:Log)    REQUIRE l.id IS UNIQUE;
```

## 2 — Log node

```cypher
LOAD CSV WITH HEADERS FROM '<BASE_URL>/log.csv' AS row
MERGE (:Log {id: row.log_id});
```

## 3 — Event nodes

```cypher
LOAD CSV WITH HEADERS FROM '<BASE_URL>/events.csv' AS row
CREATE (:Event {
    id:        row.event_id,
    activity:  row.activity,
    timestamp: datetime(row.timestamp),
    po_id:     row.po_id,
    poitem_id: row.poitem_id
});
```

## 4 — Entity nodes

```cypher
LOAD CSV WITH HEADERS FROM '<BASE_URL>/entities.csv' AS row
MERGE (:Entity {id: row.entity_id, EntityType: row.EntityType});
```

## 5 — HAS edges

```cypher
LOAD CSV WITH HEADERS FROM '<BASE_URL>/has.csv' AS row
MATCH (l:Log   {id: row.log_id})
MATCH (e:Event {id: row.event_id})
CREATE (l)-[:HAS]->(e);
```

## 6 — CORR edges (batched)

```cypher
CALL apoc.periodic.iterate(
  'LOAD CSV WITH HEADERS FROM "<BASE_URL>/corr.csv" AS row RETURN row',
  'MATCH (e:Event  {id: row.event_id})
   MATCH (n:Entity {id: row.entity_id})
   CREATE (e)-[:CORR]->(n)',
  {batchSize: 10000, parallel: false}
);
```

## 7 — DF edges (batched)

```cypher
CALL apoc.periodic.iterate(
  'LOAD CSV WITH HEADERS FROM "<BASE_URL>/df.csv" AS row RETURN row',
  'MATCH (src:Event {id: row.source_event_id})
   MATCH (tgt:Event {id: row.target_event_id})
   CREATE (src)-[:DF {entity_id: row.entity_id, EntityType: row.EntityType}]->(tgt)',
  {batchSize: 10000, parallel: false}
);
```

---

## Verification

```cypher
// Node and edge counts
MATCH (n) RETURN labels(n) AS label, count(n) AS n ORDER BY n DESC;
MATCH ()-[r]->() RETURN type(r) AS rel, count(r) AS n ORDER BY n DESC;

// Events for one POItem
MATCH (e:Event)-[:CORR]->(n:Entity {EntityType: 'POItem'})
WHERE n.id = '5100000000_1'
RETURN e.activity, e.timestamp ORDER BY e.timestamp;

// Events shared across a PO (cross-item DF)
MATCH (e:Event)-[:CORR]->(n:Entity {EntityType: 'PO'})
WHERE n.id = '5100000000'
RETURN e.activity, e.timestamp, e.poitem_id ORDER BY e.timestamp;
```
