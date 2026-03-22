/**
 * filters.js
 * ----------
 * Handles all data loading, parsing, and filter state management.
 * Completely decoupled from rendering — returns plain JS objects.
 *
 * Responsibilities:
 *   - Parse the six CSVs produced by bpic2019_to_ekg.py
 *   - Build an in-memory index of the full graph
 *   - Expose filter state and a getGraph(po, filters) function
 *     that returns a filtered subgraph ready for layout.js
 */

"use strict";

const ACTIVITY_PALETTE = [
  "#2563eb", "#7c3aed", "#ea580c", "#059669", "#dc2626",
  "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#0f766e",
  "#9333ea", "#c2410c",
];
const RESOURCE_PALETTE = [
  "#0f766e", "#7c3aed", "#b45309", "#2563eb", "#be123c",
  "#0369a1", "#4d7c0f", "#9333ea", "#b91c1c", "#475569",
];
const PO_ATTR_KEYS = ["Vendor", "Company", "Document_Type", "Source"];
const ITEM_ATTR_KEYS = ["Item_Type", "Item_Category", "Goods_Receipt", "GR_Based_Inv_Verif"];

// ── CSV parser (no external dependency) ───────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
    return obj;
  });
}

function splitCSVLine(line) {
  // Handles quoted fields with commas
  const result = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === "," && !inQuote) { result.push(cur.trim()); cur = ""; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

// ── Graph store ───────────────────────────────────────────────────────────────

/**
 * The full parsed graph — loaded once, filtered on demand.
 * @type {GraphStore | null}
 */
let store = null;

/**
 * Load and index all six CSV files.
 * Files are fetched relative to the base URL (for local server)
 * or provided as File objects (for drag-and-drop).
 *
 * @param {object} sources - { events, entities, corr, df } as text strings
 * @returns {GraphStore}
 */
export function buildStore(sources) {
  const events    = parseCSV(sources.events);
  const entities  = parseCSV(sources.entities);
  const corrRows  = parseCSV(sources.corr);
  const dfRows    = parseCSV(sources.df);

  // Parse timestamps once
  events.forEach(e => {
    e.date = new Date(e.timestamp);
  });

  // Index events by id
  const eventById = Object.fromEntries(events.map(e => [e.event_id, e]));

  // Build entity index
  const entityById = Object.fromEntries(entities.map(e => [e.entity_id, e]));

  // Group events by PO
  const eventsByPo = {};
  events.forEach(e => {
    const po = e.po_id;
    if (!eventsByPo[po]) eventsByPo[po] = [];
    eventsByPo[po].push(e);
  });

  // Group events by POItem
  const eventsByItem = {};
  events.forEach(e => {
    const item = e.poitem_id;
    if (!eventsByItem[item]) eventsByItem[item] = [];
    eventsByItem[item].push(e);
  });

  // PO → POItems mapping
  const itemsByPo = {};
  events.forEach(e => {
    if (!itemsByPo[e.po_id]) itemsByPo[e.po_id] = new Set();
    itemsByPo[e.po_id].add(e.poitem_id);
  });

  // DF edges indexed by entity type
  const dfItemEdges = dfRows
    .filter(r => r.EntityType === "POItem")
    .map(r => [r.source_event_id, r.target_event_id]);

  const dfPoEdges = dfRows
    .filter(r => r.EntityType === "PO")
    .map(r => [r.source_event_id, r.target_event_id]);

  // Group DF by entity id for fast lookup
  const dfItemByEntity = {};
  dfRows.filter(r => r.EntityType === "POItem").forEach(r => {
    const k = r.entity_id;
    if (!dfItemByEntity[k]) dfItemByEntity[k] = [];
    dfItemByEntity[k].push([r.source_event_id, r.target_event_id]);
  });

  const dfPoByPo = {};
  dfRows.filter(r => r.EntityType === "PO").forEach(r => {
    const k = r.entity_id;
    if (!dfPoByPo[k]) dfPoByPo[k] = [];
    dfPoByPo[k].push([r.source_event_id, r.target_event_id]);
  });

  // All unique activities in the dataset
  const allActivities = [...new Set(events.map(e => e.activity))].sort();
  const allResources = [...new Set(events.map(e => e.org_resource).filter(Boolean))].sort();
  const activityColorByName = _buildColorMap(allActivities, ACTIVITY_PALETTE);
  const resourceColorByName = _buildColorMap(allResources, RESOURCE_PALETTE, "#94a3b8");

  events.forEach(e => {
    e.activityColor = activityColorByName[e.activity] ?? "#64748b";
    e.resourceColor = resourceColorByName[e.org_resource] ?? "#94a3b8";
  });

  // PO list sorted by number of events (descending)
  const poList = Object.entries(eventsByPo)
    .map(([po, evs]) => ({
      id: po,
      eventCount: evs.length,
      itemCount: itemsByPo[po]?.size ?? 0,
    }))
    .sort((a, b) => b.itemCount - a.itemCount || b.eventCount - a.eventCount);

  store = {
    events,
    eventById,
    entityById,
    eventsByPo,
    eventsByItem,
    itemsByPo,
    dfItemByEntity,
    dfPoByPo,
    allActivities,
    allResources,
    activityColorByName,
    resourceColorByName,
    poList,
  };

  return store;
}

/**
 * Get the current store (throws if not loaded).
 */
export function getStore() {
  if (!store) throw new Error("Store not built — call buildStore() first.");
  return store;
}

/**
 * Extract and filter a subgraph for a given PO.
 *
 * @param {string} poId   - The PO entity ID
 * @param {object} filters
 * @param {Set<string>}  filters.activities  - Whitelisted activity names (all if null)
 * @param {string|null}  filters.resource    - Filter events by org_resource (null = all)
 * @param {string|null}  filters.dateFrom    - ISO string, events on or after
 * @param {string|null}  filters.dateTo      - ISO string, events on or before
 * @param {number}       filters.maxItems    - Limit to first N POItems (0 = all)
 * @param {boolean}      filters.showDfPo    - Include PO-level DF edges
 * @param {boolean}      filters.showDfItem  - Include item-level DF edges
 * @param {boolean}      filters.showCorr    - Include CORR edges
 *
 * @returns {object} { po, items, events, dfItem, dfPo, meta }
 */
export function getGraph(poId, filters = {}) {
  if (!store) throw new Error("Store not built.");

  const {
    activities = null,
    resource   = null,
    dateFrom   = null,
    dateTo     = null,
    maxItems   = 0,
  } = filters;

  // ── Get items for this PO ────────────────────────────────────────────────────
  let items = [...(store.itemsByPo[poId] ?? [])].sort();
  if (maxItems > 0) items = items.slice(0, maxItems);

  const itemSet = new Set(items);

  // ── Filter events ────────────────────────────────────────────────────────────
  let events = (store.eventsByPo[poId] ?? [])
    .filter(e => itemSet.has(e.poitem_id));

  if (activities && activities.size > 0) {
    events = events.filter(e => activities.has(e.activity));
  }
  if (resource) {
    events = events.filter(e => e.org_resource === resource);
  }
  if (dateFrom) {
    const from = new Date(dateFrom);
    events = events.filter(e => e.date >= from);
  }
  if (dateTo) {
    const to = new Date(dateTo);
    events = events.filter(e => e.date <= to);
  }

  const eventIdSet = new Set(events.map(e => e.event_id));

  // ── Filter DF edges (only include edges where both endpoints survived) ────────
  const dfItem = items.flatMap(item =>
    (store.dfItemByEntity[item] ?? [])
      .filter(([s, t]) => eventIdSet.has(s) && eventIdSet.has(t))
  );

  const dfPo = (store.dfPoByPo[poId] ?? [])
    .filter(([s, t]) => eventIdSet.has(s) && eventIdSet.has(t));

  // ── Meta (for status bar / stats panel) ──────────────────────────────────────
  const meta = {
    totalEvents: (store.eventsByPo[poId] ?? []).length,
    filteredEvents: events.length,
    totalItems: store.itemsByPo[poId]?.size ?? 0,
    shownItems: items.length,
    dfItemCount: dfItem.length,
    dfPoCount: dfPo.length,
  };

  const poAttrs = _pickAttrs(store.eventsByPo[poId]?.[0], PO_ATTR_KEYS);
  const itemAttrsById = Object.fromEntries(
    items.map(item => [item, _pickAttrs(store.eventsByItem[item]?.[0], ITEM_ATTR_KEYS)])
  );

  return { po: poId, items, events, dfItem, dfPo, meta, poAttrs, itemAttrsById };
}

/**
 * Get all unique resources across the currently selected PO.
 */
export function getResourcesForPo(poId) {
  if (!store) return [];
  const evs = store.eventsByPo[poId] ?? [];
  return [...new Set(evs.map(e => e.org_resource).filter(Boolean))].sort();
}

/**
 * Get activity counts for the currently selected PO (for filter panel).
 */
export function getActivityCountsForPo(poId) {
  if (!store) return {};
  const evs = store.eventsByPo[poId] ?? [];
  const counts = {};
  evs.forEach(e => {
    counts[e.activity] = (counts[e.activity] ?? 0) + 1;
  });
  return counts;
}

/**
 * Load CSV files from a local server (requires running via `npx serve` or similar).
 * Falls back gracefully — returns null if fetch fails.
 *
 * @param {string} basePath - e.g. "../output"
 * @returns {Promise<object|null>}
 */
export async function loadFromServer(basePath = "../output") {
  const files = ["events", "entities", "corr", "df"];
  try {
    const texts = await Promise.all(
      files.map(f =>
        fetch(`${basePath}/${f}.csv`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
      )
    );
    return Object.fromEntries(files.map((f, i) => [f, texts[i]]));
  } catch (err) {
    console.warn("Server load failed:", err.message);
    return null;
  }
}

/**
 * Load CSV files from File objects (drag-and-drop or file picker).
 * Expects an array/FileList of .csv files named events, entities, corr, df.
 *
 * @param {FileList|File[]} fileList
 * @returns {Promise<object>}
 */
export async function loadFromFiles(fileList) {
  const needed = ["events", "entities", "corr", "df"];
  const byName = {};
  for (const file of fileList) {
    const base = file.name.replace(".csv", "");
    if (needed.includes(base)) byName[base] = file;
  }

  const missing = needed.filter(n => !byName[n]);
  if (missing.length > 0) {
    throw new Error(`Missing files: ${missing.join(", ")}.csv`);
  }

  const texts = await Promise.all(
    needed.map(n => byName[n].text())
  );
  return Object.fromEntries(needed.map((n, i) => [n, texts[i]]));
}

function _pickAttrs(obj, keys) {
  if (!obj) return {};
  return Object.fromEntries(
    keys
      .filter(key => obj[key] !== undefined && obj[key] !== null && obj[key] !== "")
      .map(key => [key, obj[key]])
  );
}

function _buildColorMap(values, palette, fallbackBase = null) {
  const map = {};
  values.forEach((value, i) => {
    map[value] = palette[i] ?? fallbackBase ?? _hashColor(value);
  });
  return map;
}

function _hashColor(value) {
  let hash = 0;
  const s = String(value ?? "");
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash) + s.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 46%)`;
}
