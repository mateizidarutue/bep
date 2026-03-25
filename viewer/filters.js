/**
 * filters.js
 * ----------
 * Handles all data loading, parsing, and filter state management.
 * Completely decoupled from rendering - returns plain JS objects.
 *
 * Responsibilities:
 *   - Parse the CSVs produced by bpic2019_to_ekg.py
 *   - Build an in-memory index of the full graph
 *   - Expose focused PO subgraphs and a dataset-agnostic overview meta-graph
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

const OVERVIEW_KNN = 4;
const OVERVIEW_SIM_MIN = 0.34;
const OVERVIEW_LABEL_ACTIVITY_COUNT = 2;
const OVERVIEW_MAX_COMMON_SHARE = 0.8;

let store = null;

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
  const result = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") inQuote = !inQuote;
    else if (ch === "," && !inQuote) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

export function buildStore(sources) {
  const events = parseCSV(sources.events);
  const entities = parseCSV(sources.entities);
  const dfRows = parseCSV(sources.df);

  events.forEach(event => {
    event.date = new Date(event.timestamp);
  });

  const eventById = Object.fromEntries(events.map(event => [event.event_id, event]));
  const entityById = Object.fromEntries(entities.map(entity => [entity.entity_id, entity]));

  const eventsByPo = {};
  const eventsByItem = {};
  const itemsByPo = {};

  events.forEach(event => {
    if (!eventsByPo[event.po_id]) eventsByPo[event.po_id] = [];
    eventsByPo[event.po_id].push(event);

    if (!eventsByItem[event.poitem_id]) eventsByItem[event.poitem_id] = [];
    eventsByItem[event.poitem_id].push(event);

    if (!itemsByPo[event.po_id]) itemsByPo[event.po_id] = new Set();
    itemsByPo[event.po_id].add(event.poitem_id);
  });

  const dfItemByEntity = {};
  const dfPoByPo = {};
  dfRows.forEach(row => {
    if (row.EntityType === "POItem") {
      if (!dfItemByEntity[row.entity_id]) dfItemByEntity[row.entity_id] = [];
      dfItemByEntity[row.entity_id].push([row.source_event_id, row.target_event_id]);
    } else if (row.EntityType === "PO") {
      if (!dfPoByPo[row.entity_id]) dfPoByPo[row.entity_id] = [];
      dfPoByPo[row.entity_id].push([row.source_event_id, row.target_event_id]);
    }
  });

  const allActivities = [...new Set(events.map(event => event.activity))].sort();
  const allResources = [...new Set(events.map(event => event.org_resource).filter(_isMeaningfulResource))].sort();
  const activityColorByName = _buildColorMap(allActivities, ACTIVITY_PALETTE);
  const resourceColorByName = _buildColorMap(allResources, RESOURCE_PALETTE, "#94a3b8");

  events.forEach(event => {
    event.activityColor = activityColorByName[event.activity] ?? "#64748b";
    event.resourceColor = _isMeaningfulResource(event.org_resource)
      ? (resourceColorByName[event.org_resource] ?? "#94a3b8")
      : "#cbd5e1";
  });

  const poList = Object.entries(eventsByPo)
    .map(([po, evs]) => ({
      id: po,
      eventCount: evs.length,
      itemCount: itemsByPo[po]?.size ?? 0,
    }))
    .sort((a, b) => b.itemCount - a.itemCount || b.eventCount - a.eventCount);

  const poSummaryById = _buildPoSummaries(poList, eventsByPo, itemsByPo);
  _applyOverviewFeatureSelection(poSummaryById);
  const poOverviewEdges = _buildOverviewRelations(poSummaryById);
  const { communities, communityByPoId } = _buildOverviewCommunities(poSummaryById, poOverviewEdges);

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
    poSummaryById,
    poOverviewEdges,
    communities,
    communityByPoId,
  };

  return store;
}

export function getStore() {
  if (!store) throw new Error("Store not built - call buildStore() first.");
  return store;
}

export function getGraph(poId, filters = {}) {
  if (!store) throw new Error("Store not built.");

  const { maxItems = 0 } = filters;

  let items = [...(store.itemsByPo[poId] ?? [])].sort();
  if (maxItems > 0) items = items.slice(0, maxItems);
  const itemSet = new Set(items);

  let events = (store.eventsByPo[poId] ?? []).filter(event => itemSet.has(event.poitem_id));
  events = _filterEvents(events, filters);

  const eventIdSet = new Set(events.map(event => event.event_id));
  const dfItem = items.flatMap(item =>
    (store.dfItemByEntity[item] ?? []).filter(([source, target]) => eventIdSet.has(source) && eventIdSet.has(target))
  );
  const dfPo = (store.dfPoByPo[poId] ?? []).filter(([source, target]) => eventIdSet.has(source) && eventIdSet.has(target));

  const meta = {
    totalEvents: (store.eventsByPo[poId] ?? []).length,
    filteredEvents: events.length,
    totalItems: store.itemsByPo[poId]?.size ?? 0,
    shownItems: items.length,
    dfItemCount: dfItem.length,
    dfPoCount: dfPo.length,
  };

  const poAttrs = store.poSummaryById[poId]?.attrs ?? {};
  const itemAttrsById = Object.fromEntries(
    items.map(item => [item, _pickAttrs(store.eventsByItem[item]?.[0], ITEM_ATTR_KEYS)])
  );

  return { po: poId, items, events, dfItem, dfPo, meta, poAttrs, itemAttrsById };
}

export function getOverviewGraph(filters = {}) {
  if (!store) throw new Error("Store not built.");
  const { communityId = null, minEdgeWeight = OVERVIEW_SIM_MIN } = filters;

  const nodes = [];
  const visibleSet = new Set();

  store.poList.forEach(po => {
    const summary = store.poSummaryById[po.id];
    const community = store.communityByPoId[po.id] ?? {
      id: po.id,
      label: "Community",
      hint: "",
      weightedDegree: 0,
    };
    if (communityId && community.id !== communityId) return;
    const filteredEvents = _filterEvents(store.eventsByPo[po.id] ?? [], filters);
    if (filteredEvents.length === 0) return;

    const filteredItems = new Set(filteredEvents.map(event => event.poitem_id)).size;
    nodes.push({
      id: summary.id,
      label: summary.id,
      attrs: summary.attrs,
      displayAttrs: summary.overviewDisplayAttrs,
      attrKeys: summary.overviewAttrKeys,
      resources: summary.overviewResources,
      clusterKey: community.id,
      clusterLabel: community.label,
      clusterCode: community.code,
      clusterHint: community.hint,
      firstDate: summary.firstDate,
      lastDate: summary.lastDate,
      totalEvents: summary.eventCount,
      filteredEvents: filteredEvents.length,
      totalItems: summary.itemCount,
      filteredItems,
      resourceCount: summary.overviewResourceCount,
      topResources: summary.overviewTopResources,
      topActivities: summary.topActivities,
      weightedDegree: community.weightedDegree ?? 0,
    });
    visibleSet.add(summary.id);
  });

  const edges = store.poOverviewEdges.filter(edge =>
    edge.weight >= minEdgeWeight &&
    visibleSet.has(edge.source) && visibleSet.has(edge.target)
  );

  const degreeById = {};
  const weightedDegreeById = {};
  edges.forEach(edge => {
    degreeById[edge.source] = (degreeById[edge.source] ?? 0) + 1;
    degreeById[edge.target] = (degreeById[edge.target] ?? 0) + 1;
    weightedDegreeById[edge.source] = (weightedDegreeById[edge.source] ?? 0) + edge.weight;
    weightedDegreeById[edge.target] = (weightedDegreeById[edge.target] ?? 0) + edge.weight;
  });

  nodes.forEach(node => {
    node.degree = degreeById[node.id] ?? 0;
    node.weightedDegree = weightedDegreeById[node.id] ?? node.weightedDegree ?? 0;
  });

  const clusters = Object.values(nodes.reduce((acc, node) => {
    if (!acc[node.clusterKey]) {
      acc[node.clusterKey] = {
        id: node.clusterKey,
        label: node.clusterLabel,
        code: node.clusterCode,
        hint: node.clusterHint,
        nodeIds: [],
        resources: [],
        attributes: [],
      };
    }
    acc[node.clusterKey].nodeIds.push(node.id);
    return acc;
  }, {}));

  clusters.forEach(cluster => {
    const members = nodes.filter(node => node.clusterKey === cluster.id);
    cluster.resources = _aggregateCommunityResources(members);
    cluster.attributes = _aggregateCommunityAttrs(members);
  });

  clusters.sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.label.localeCompare(b.label));
  const communityEdges = _buildCommunityEdges(edges, nodes);

  const meta = {
    poCount: nodes.length,
    totalPoCount: store.poList.length,
    clusterCount: clusters.length,
    overviewEdgeCount: edges.length,
    overviewCommunityEdgeCount: communityEdges.length,
    filteredEvents: nodes.reduce((sum, node) => sum + node.filteredEvents, 0),
    totalEvents: nodes.reduce((sum, node) => sum + node.totalEvents, 0),
    shownItems: nodes.reduce((sum, node) => sum + node.filteredItems, 0),
    totalItems: nodes.reduce((sum, node) => sum + node.totalItems, 0),
    dfItemCount: 0,
    dfPoCount: 0,
    focusCommunityId: communityId,
  };

  return {
    isOverviewNetwork: true,
    nodes,
    edges,
    communityEdges,
    clusters,
    meta,
  };
}

export function getResourcesForPo(poId) {
  if (!store) return [];
  const events = store.eventsByPo[poId] ?? [];
  return [...new Set(events.map(event => event.org_resource).filter(_isMeaningfulResource))].sort();
}

export function getActivityCountsForPo(poId) {
  if (!store) return {};
  const events = store.eventsByPo[poId] ?? [];
  return _countBy(events, event => event.activity);
}

export async function loadFromServer(basePath = "../output") {
  const files = ["events", "entities", "corr", "df"];
  try {
    const texts = await Promise.all(
      files.map(file =>
        fetch(`${basePath}/${file}.csv`).then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
      )
    );
    return Object.fromEntries(files.map((file, i) => [file, texts[i]]));
  } catch (err) {
    console.warn("Server load failed:", err.message);
    return null;
  }
}

export async function loadFromFiles(fileList) {
  const needed = ["events", "entities", "corr", "df"];
  const byName = {};
  for (const file of fileList) {
    const base = file.name.replace(".csv", "");
    if (needed.includes(base)) byName[base] = file;
  }

  const missing = needed.filter(name => !byName[name]);
  if (missing.length > 0) {
    throw new Error(`Missing files: ${missing.join(", ")}.csv`);
  }

  const texts = await Promise.all(needed.map(name => byName[name].text()));
  return Object.fromEntries(needed.map((name, i) => [name, texts[i]]));
}

function _buildPoSummaries(poList, eventsByPo, itemsByPo) {
  const summaries = {};

  poList.forEach(po => {
    const events = [...(eventsByPo[po.id] ?? [])].sort((a, b) => a.date - b.date);
    const attrs = _pickAttrs(events[0], PO_ATTR_KEYS);
    const displayAttrs = _pickStableContextAttrs(events);
    const resources = [...new Set(events.map(event => event.org_resource).filter(_isMeaningfulResource))].sort();
    const activityCounts = _countBy(events, event => event.activity);
    const topActivities = Object.entries(activityCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([activity, count]) => ({ activity, count }));

    summaries[po.id] = {
      id: po.id,
      attrs,
      displayAttrs,
      attrKeys: Object.keys(displayAttrs),
      itemCount: itemsByPo[po.id]?.size ?? 0,
      eventCount: events.length,
      firstDate: events[0]?.date ?? null,
      lastDate: events.at(-1)?.date ?? null,
      centerTime: _caseCenterTime(events[0]?.date ?? null, events.at(-1)?.date ?? null),
      resources,
      resourceCount: resources.length,
      topResources: resources.slice(0, 3),
      activityCounts,
      topActivities,
      contextTokens: Object.entries(displayAttrs).map(([key, value]) => `${key}:${value}`),
      overviewDisplayAttrs: displayAttrs,
      overviewAttrKeys: Object.keys(displayAttrs),
      overviewResources: resources,
      overviewResourceCount: resources.length,
      overviewTopResources: resources.slice(0, 3),
      overviewContextTokens: Object.entries(displayAttrs).map(([key, value]) => `${key}:${value}`),
    };
  });

  return summaries;
}

function _buildOverviewRelations(poSummaryById) {
  const summaries = Object.values(poSummaryById).sort((a, b) => a.id.localeCompare(b.id));
  const candidates = [];

  const datasetStart = Math.min(...summaries.map(summary => summary.firstDate?.getTime() ?? Infinity));
  const datasetEnd = Math.max(...summaries.map(summary => summary.lastDate?.getTime() ?? -Infinity));
  const timelineSpan = Number.isFinite(datasetStart) && Number.isFinite(datasetEnd)
    ? Math.max(datasetEnd - datasetStart, 1)
    : 1;

  for (let i = 0; i < summaries.length; i++) {
    for (let j = i + 1; j < summaries.length; j++) {
      const edge = _scoreOverviewPair(summaries[i], summaries[j], timelineSpan);
      if (edge && edge.weight >= OVERVIEW_SIM_MIN) candidates.push(edge);
    }
  }

  const rankedByNode = {};
  candidates.forEach(edge => {
    if (!rankedByNode[edge.source]) rankedByNode[edge.source] = [];
    if (!rankedByNode[edge.target]) rankedByNode[edge.target] = [];
    rankedByNode[edge.source].push(edge);
    rankedByNode[edge.target].push(edge);
  });

  Object.values(rankedByNode).forEach(edges => {
    edges.sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  });

  return candidates
    .filter(edge => {
      const topForSource = (rankedByNode[edge.source] ?? []).slice(0, OVERVIEW_KNN);
      const topForTarget = (rankedByNode[edge.target] ?? []).slice(0, OVERVIEW_KNN);
      return topForSource.includes(edge) || topForTarget.includes(edge);
    })
    .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

function _applyOverviewFeatureSelection(poSummaryById) {
  const summaries = Object.values(poSummaryById ?? {});
  const caseCount = summaries.length;
  if (!caseCount) return;

  const resourceCaseFreq = _countDocumentFrequency(summaries.map(summary => summary.resources));
  const contextCaseFreq = _countDocumentFrequency(summaries.map(summary => summary.contextTokens));

  summaries.forEach(summary => {
    const overviewResources = summary.resources.filter(resource =>
      _isInformativeOverviewValue(resource, resourceCaseFreq[resource] ?? 0, caseCount)
    );
    const overviewContextTokens = summary.contextTokens.filter(token =>
      _isInformativeOverviewToken(token, contextCaseFreq[token] ?? 0, caseCount)
    );
    const overviewDisplayAttrs = Object.fromEntries(
      Object.entries(summary.displayAttrs ?? {}).filter(([key, value]) =>
        overviewContextTokens.includes(`${key}:${value}`)
      )
    );

    summary.overviewResources = overviewResources;
    summary.overviewResourceCount = overviewResources.length;
    summary.overviewTopResources = overviewResources.slice(0, 3);
    summary.overviewContextTokens = overviewContextTokens;
    summary.overviewDisplayAttrs = overviewDisplayAttrs;
    summary.overviewAttrKeys = Object.keys(overviewDisplayAttrs);
  });
}

function _scoreOverviewPair(a, b, timelineSpan) {
  const activitySimilarity = _cosineSimilarity(a.activityCounts, b.activityCounts);
  const resourceSimilarity = _jaccardSimilarity(a.overviewResources, b.overviewResources);
  const contextSimilarity = _jaccardSimilarity(a.overviewContextTokens, b.overviewContextTokens);
  const temporalSimilarity = _temporalSimilarity(a.centerTime, b.centerTime, timelineSpan);
  const sizeSimilarity = _sizeSimilarity(a, b);

  const weight =
    activitySimilarity * 0.48 +
    resourceSimilarity * 0.18 +
    contextSimilarity * 0.18 +
    temporalSimilarity * 0.10 +
    sizeSimilarity * 0.06;

  if (weight <= 0) return null;

  const reasons = [];
  if (activitySimilarity >= 0.25) reasons.push(`activity profile ${Math.round(activitySimilarity * 100)}% aligned`);
  if (resourceSimilarity >= 0.2) reasons.push(_sharedValueReason("shared resources", a.overviewResources, b.overviewResources));
  if (contextSimilarity >= 0.2) {
    reasons.push(_sharedValueReason("shared context", a.overviewContextTokens, b.overviewContextTokens, token => token.replace(":", " = ")));
  }
  if (temporalSimilarity >= 0.55) reasons.push("close in time");
  if (sizeSimilarity >= 0.75) reasons.push("similar case size");

  return {
    id: `${a.id}__${b.id}`,
    source: a.id,
    target: b.id,
    weight,
    reasons: reasons.slice(0, 3),
    components: {
      activitySimilarity,
      resourceSimilarity,
      contextSimilarity,
      temporalSimilarity,
      sizeSimilarity,
    },
  };
}

function _buildOverviewCommunities(poSummaryById, edges) {
  const summaries = Object.values(poSummaryById);
  const adjacency = {};
  const weightedDegreeById = Object.fromEntries(summaries.map(summary => [summary.id, 0]));

  edges.forEach(edge => {
    if (!adjacency[edge.source]) adjacency[edge.source] = [];
    if (!adjacency[edge.target]) adjacency[edge.target] = [];
    adjacency[edge.source].push({ id: edge.target, weight: edge.weight });
    adjacency[edge.target].push({ id: edge.source, weight: edge.weight });
    weightedDegreeById[edge.source] += edge.weight;
    weightedDegreeById[edge.target] += edge.weight;
  });

  const labels = Object.fromEntries(summaries.map(summary => [summary.id, summary.id]));
  const order = [...summaries].sort((a, b) =>
    (weightedDegreeById[b.id] ?? 0) - (weightedDegreeById[a.id] ?? 0) || a.id.localeCompare(b.id)
  );

  for (let iteration = 0; iteration < 16; iteration++) {
    let changed = false;

    order.forEach(summary => {
      const neighbors = adjacency[summary.id] ?? [];
      if (!neighbors.length) return;

      const scores = {};
      neighbors.forEach(neighbor => {
        const label = labels[neighbor.id];
        scores[label] = (scores[label] ?? 0) + neighbor.weight;
      });

      const bestLabel = Object.entries(scores)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

      if (bestLabel && bestLabel !== labels[summary.id]) {
        labels[summary.id] = bestLabel;
        changed = true;
      }
    });

    if (!changed) break;
  }

  const groups = Object.values(summaries.reduce((acc, summary) => {
    const label = labels[summary.id];
    if (!acc[label]) acc[label] = { sourceLabel: label, nodeIds: [] };
    acc[label].nodeIds.push(summary.id);
    return acc;
  }, {})).sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.sourceLabel.localeCompare(b.sourceLabel));

  const communityByPoId = {};
  const communities = groups.map((group, index) => {
    const members = group.nodeIds.map(id => poSummaryById[id]).filter(Boolean);
    const activityTotals = {};
    members.forEach(member => {
      Object.entries(member.activityCounts).forEach(([activity, count]) => {
        activityTotals[activity] = (activityTotals[activity] ?? 0) + count;
      });
    });

    const hint = Object.entries(activityTotals)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, OVERVIEW_LABEL_ACTIVITY_COUNT)
      .map(([activity]) => activity)
      .join(" / ");

    const code = `Community ${String(index + 1).padStart(2, "0")}`;
    const community = {
      id: `community-${String(index + 1).padStart(2, "0")}`,
      code,
      label: hint || code,
      hint: hint ? code : "",
      nodeIds: group.nodeIds,
    };

    community.nodeIds.forEach(id => {
      communityByPoId[id] = {
        ...community,
        weightedDegree: weightedDegreeById[id] ?? 0,
      };
    });

    return community;
  });

  return { communities, communityByPoId };
}

function _filterEvents(events, filters = {}) {
  const {
    activities = null,
    resource = null,
    dateFrom = null,
    dateTo = null,
  } = filters;

  let out = events;
  if (activities && activities.size > 0) {
    out = out.filter(event => activities.has(event.activity));
  } else if (activities && activities.size === 0) {
    out = [];
  }
  if (resource) {
    out = out.filter(event => event.org_resource === resource);
  }
  if (dateFrom) {
    const from = new Date(dateFrom);
    out = out.filter(event => event.date >= from);
  }
  if (dateTo) {
    const to = new Date(dateTo);
    out = out.filter(event => event.date <= to);
  }
  return out;
}

function _pickAttrs(obj, keys) {
  if (!obj) return {};
  return Object.fromEntries(
    keys
      .filter(key => obj[key] !== undefined && obj[key] !== null && obj[key] !== "")
      .map(key => [key, obj[key]])
  );
}

function _pickStableContextAttrs(events, limit = Infinity) {
  if (!events?.length) return {};

  const keys = Object.keys(events[0]).filter(_isStableContextKey);
  const stable = [];

  keys.forEach(key => {
    const values = [...new Set(events.map(event => event[key]).filter(value => value !== undefined && value !== null && value !== ""))];
    if (values.length === 1) stable.push([key, values[0]]);
  });

  stable.sort((a, b) =>
    String(a[1]).length - String(b[1]).length || a[0].localeCompare(b[0])
  );

  return Object.fromEntries(stable.slice(0, limit));
}

function _isStableContextKey(key) {
  if (!key) return false;
  const normalized = key.toLowerCase();
  if (normalized === "activity" || normalized === "timestamp" || normalized === "date") return false;
  if (normalized === "org_resource" || normalized === "resourcecolor" || normalized === "activitycolor") return false;
  if (normalized === "lifecycle_transition") return false;
  if (normalized === "po_id" || normalized === "poitem_id") return false;
  if (normalized === "event_id" || normalized.endsWith("_id")) return false;
  return true;
}

function _isMeaningfulResource(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim();
  if (!normalized) return false;
  return normalized.toUpperCase() !== "NONE";
}

function _isInformativeOverviewToken(token, caseFrequency, caseCount) {
  const [, rawValue = token] = String(token ?? "").split(/:(.+)/, 2);
  return _isInformativeOverviewValue(rawValue, caseFrequency, caseCount);
}

function _isInformativeOverviewValue(value, caseFrequency, caseCount) {
  if (!_isMeaningfulOverviewValue(value)) return false;
  const share = caseCount > 0 ? caseFrequency / caseCount : 0;
  return share < OVERVIEW_MAX_COMMON_SHARE;
}

function _isMeaningfulOverviewValue(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim();
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  if (["none", "unknown", "n/a", "na", "null"].includes(lower)) return false;
  if (/^[a-z][a-z0-9]*_0+$/i.test(normalized)) return false;
  if (/^[a-z][a-z0-9]*id_0+$/i.test(normalized)) return false;
  if (/^0+$/.test(normalized)) return false;

  return true;
}

function _countDocumentFrequency(valueLists) {
  const counts = {};
  (valueLists ?? []).forEach(values => {
    [...new Set(values ?? [])].forEach(value => {
      counts[value] = (counts[value] ?? 0) + 1;
    });
  });
  return counts;
}

function _countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    if (!key) return acc;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function _caseCenterTime(firstDate, lastDate) {
  if (!firstDate && !lastDate) return null;
  if (!firstDate) return lastDate.getTime();
  if (!lastDate) return firstDate.getTime();
  return (firstDate.getTime() + lastDate.getTime()) / 2;
}

function _cosineSimilarity(aCounts, bCounts) {
  const keys = new Set([...Object.keys(aCounts ?? {}), ...Object.keys(bCounts ?? {})]);
  if (!keys.size) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  keys.forEach(key => {
    const a = aCounts?.[key] ?? 0;
    const b = bCounts?.[key] ?? 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  });

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function _jaccardSimilarity(aValues, bValues) {
  const a = new Set(aValues ?? []);
  const b = new Set(bValues ?? []);
  if (!a.size && !b.size) return 0;

  let intersection = 0;
  a.forEach(value => {
    if (b.has(value)) intersection += 1;
  });

  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

function _temporalSimilarity(aCenter, bCenter, timelineSpan) {
  if (!Number.isFinite(aCenter) || !Number.isFinite(bCenter)) return 0;
  return Math.max(0, 1 - (Math.abs(aCenter - bCenter) / Math.max(timelineSpan, 1)));
}

function _sizeSimilarity(a, b) {
  const eventSimilarity = _ratioSimilarity(a.eventCount, b.eventCount);
  const itemSimilarity = _ratioSimilarity(a.itemCount, b.itemCount);
  return eventSimilarity * 0.7 + itemSimilarity * 0.3;
}

function _ratioSimilarity(a, b) {
  if (!a && !b) return 1;
  const max = Math.max(a ?? 0, b ?? 0, 1);
  return 1 - (Math.abs((a ?? 0) - (b ?? 0)) / max);
}

function _sharedValueReason(label, aValues, bValues, formatter = value => value) {
  const bSet = new Set(bValues ?? []);
  const shared = [...new Set(aValues ?? [])].filter(value => bSet.has(value));
  if (!shared.length) return label;
  const preview = shared.slice(0, 2).map(formatter).join(", ");
  return shared.length > 2 ? `${label}: ${preview}, ...` : `${label}: ${preview}`;
}

function _aggregateCommunityResources(nodes) {
  const counts = {};
  nodes.forEach(node => {
    (node.resources ?? []).forEach(resource => {
      counts[resource] = (counts[resource] ?? 0) + 1;
    });
  });

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([resource, count]) => ({
      id: `resource:${resource}`,
      type: "resource",
      label: resource,
      shortLabel: _shortToken(resource, 12),
      count,
    }));
}

function _aggregateCommunityAttrs(nodes) {
  const counts = {};
  nodes.forEach(node => {
    Object.entries(node.displayAttrs ?? {}).forEach(([key, value]) => {
      const token = `${key}:${value}`;
      if (!counts[token]) {
        counts[token] = {
          id: `attr:${token}`,
          type: "attribute",
          key,
          value,
          label: `${_labelizeKey(key)}=${value}`,
          shortLabel: `${_labelizeKey(key)}=${_shortToken(value, 14)}`,
          count: 0,
        };
      }
      counts[token].count += 1;
    });
  });

  return Object.values(counts)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key) || String(a.value).localeCompare(String(b.value)));
}

function _buildCommunityEdges(edges, nodes) {
  const communityByNode = Object.fromEntries(nodes.map(node => [node.id, node.clusterKey]));
  const communityEdgeMap = new Map();

  edges.forEach(edge => {
    const sourceCommunity = communityByNode[edge.source];
    const targetCommunity = communityByNode[edge.target];
    if (!sourceCommunity || !targetCommunity || sourceCommunity === targetCommunity) return;

    const [source, target] = sourceCommunity < targetCommunity
      ? [sourceCommunity, targetCommunity]
      : [targetCommunity, sourceCommunity];
    const key = `${source}__${target}`;
    if (!communityEdgeMap.has(key)) {
      communityEdgeMap.set(key, {
        id: key,
        source,
        target,
        weight: 0,
        count: 0,
      });
    }

    const agg = communityEdgeMap.get(key);
    agg.weight += edge.weight;
    agg.count += 1;
  });

  return [...communityEdgeMap.values()]
    .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

function _labelizeKey(key) {
  return String(key ?? "").replaceAll("_", " ");
}

function _shortToken(value, maxChars = 14) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
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
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 46%)`;
}
