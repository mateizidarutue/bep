/**
 * layout.js
 * ---------
 * Hub-and-spoke layout with progressive disclosure.
 *
 * Overview:
 *   case meta-graph with stable community placement
 *
 * Focused view (collapsed):
 *   PO node (left) -> CORR line -> POItem node -> summary chip
 *
 * Expanded view (click POItem):
 *   POItem node -> connector -> event timeline (left-to-right by timestamp)
 *   DF edges between consecutive events as horizontal arrows
 */

"use strict";

export const ITEM_COLORS = [
  "#159a67", "#8b5cf6", "#d97706", "#dc2626", "#0284c7",
];
export const PO_COLOR = "#2563eb";

export const PO_R = 20;
export const ITEM_R = 14;
export const EVENT_R = 7;

export const PO_X = 80;
export const ITEM_X = 200;
export const TIMELINE_X0 = 272;

const ROW_H_COLLAPSED = 52;
const ROW_H_EXPANDED = 124;
const BLOCK_PAD_TOP = 24;
const BLOCK_PAD_BOT = 16;
const MULTI_PO_GAP = 28;
const TIMELINE_PAD_R = 48;
const MIN_EVENT_SPACING = 22;
const MIN_RESOURCE_SPACING = 46;
const HOUR_MS = 1000 * 60 * 60;

const OVERVIEW_PAD_X = 80;
const OVERVIEW_PAD_Y = 70;
const COMMUNITY_GAP = 36;
const COMMUNITY_SPIRAL_STEP = 18;
const COMMUNITY_SPIRAL_TURNS = Math.PI * (3 - Math.sqrt(5));
const CLUSTER_INNER_R = 44;
const CLUSTER_RING_GAP = 26;
const SATELLITE_RING_GAP = 28;
const SATELLITES_PER_RING = 5;
const FOCUS_RESOURCE_LIMIT = 8;
const FOCUS_ATTR_LIMIT = 8;

export function computeLayout(graphs, expanded, width, options = {}) {
  if (graphs.length === 1 && graphs[0]?.isOverviewNetwork) {
    return _layoutOverviewNetwork(graphs[0], width);
  }

  const timelineW = Math.max(width - TIMELINE_X0 - TIMELINE_PAD_R, 180);
  let curY = 20;
  const poBlocks = [];
  graphs.forEach(graph => {
    const block = _layoutBlock(graph, expanded, curY, timelineW, options);
    poBlocks.push(block);
    curY += block.totalHeight + MULTI_PO_GAP;
  });
  return {
    overviewNetwork: false,
    poBlocks,
    totalHeight: curY,
    patterns: poBlocks[0]?.patterns ?? { dominantPattern: [], entityPatterns: {} },
    summary: _summarizeFocusBlocks(poBlocks),
  };
}

function _layoutOverviewNetwork(graph, width) {
  const clusters = [...graph.clusters].sort(
    (a, b) => b.nodeIds.length - a.nodeIds.length || a.label.localeCompare(b.label)
  );
  if (graph.meta?.focusCommunityId && clusters.length === 1) {
    return _layoutFocusedCommunity(graph, width, clusters[0]);
  }
  const clusterLayouts = [];
  const nodeLayouts = [];
  const nodePos = {};
  const clusterModels = clusters.map(cluster => {
    const members = graph.nodes
      .filter(node => cluster.nodeIds.includes(node.id))
      .sort((a, b) => b.weightedDegree - a.weightedDegree || b.degree - a.degree || a.id.localeCompare(b.id));

    const radius = CLUSTER_INNER_R + Math.max(0, Math.ceil((members.length - 1) / 6)) * CLUSTER_RING_GAP;
    const satellites = [
      ..._layoutSatelliteArc(cluster.resources ?? [], radius + 42, 0.68 * Math.PI, 1.32 * Math.PI),
      ..._layoutSatelliteArc(cluster.attributes ?? [], radius + 42, -0.32 * Math.PI, 0.32 * Math.PI),
    ];
    const outerRadius = satellites.reduce(
      (max, satellite) => Math.max(max, Math.hypot(satellite.dx, satellite.dy) + Math.max(satellite.w, satellite.h) * 0.6),
      radius + 28,
    );

    return {
      ...cluster,
      members,
      radius,
      outerRadius,
      satellites,
    };
  });

  const placed = [];
  clusterModels.forEach((cluster, index) => {
    if (index === 0) {
      placed.push({ ...cluster, cx: 0, cy: 0 });
      return;
    }

    let chosen = null;
    for (let step = 1; step < 2400; step++) {
      const angle = step * COMMUNITY_SPIRAL_TURNS;
      const distance = cluster.outerRadius + 80 + step * COMMUNITY_SPIRAL_STEP * 0.34;
      const candidateX = Math.cos(angle) * distance;
      const candidateY = Math.sin(angle) * distance;
      const collides = placed.some(other => {
        const minGap = cluster.outerRadius + other.outerRadius + COMMUNITY_GAP;
        return Math.hypot(candidateX - other.cx, candidateY - other.cy) < minGap;
      });
      if (!collides) {
        chosen = { x: candidateX, y: candidateY };
        break;
      }
    }

    placed.push({
      ...cluster,
      cx: chosen?.x ?? 0,
      cy: chosen?.y ?? 0,
    });
  });

  const bounds = placed.reduce((acc, cluster) => {
    acc.minX = Math.min(acc.minX, cluster.cx - cluster.outerRadius);
    acc.maxX = Math.max(acc.maxX, cluster.cx + cluster.outerRadius);
    acc.minY = Math.min(acc.minY, cluster.cy - cluster.outerRadius);
    acc.maxY = Math.max(acc.maxY, cluster.cy + cluster.outerRadius);
    return acc;
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

  const shiftX = Math.max(OVERVIEW_PAD_X - bounds.minX, (width / 2) - ((bounds.minX + bounds.maxX) / 2));
  const shiftY = OVERVIEW_PAD_Y + 32 - bounds.minY;

  placed.forEach(cluster => {
    const centerX = cluster.cx + shiftX;
    const centerY = cluster.cy + shiftY;

    clusterLayouts.push({
      ...cluster,
      x: centerX,
      y: centerY,
      width: cluster.outerRadius * 2,
      height: cluster.outerRadius * 2,
      count: cluster.members.length,
      satellites: cluster.satellites.map(satellite => ({
        ...satellite,
        x: centerX + satellite.dx,
        y: centerY + satellite.dy,
      })),
    });

    cluster.members.forEach((node, memberIndex) => {
      let x = centerX;
      let y = centerY;

      if (memberIndex > 0) {
        const ringIndex = Math.floor((memberIndex - 1) / 6) + 1;
        const slotIndex = (memberIndex - 1) % 6;
        const slotCount = Math.min(6 * ringIndex, cluster.members.length - (ringIndex - 1) * 6 - 1);
        const angle = (-Math.PI / 2) + (slotIndex / Math.max(slotCount, 1)) * Math.PI * 2;
        const ringRadius = CLUSTER_INNER_R + (ringIndex - 1) * CLUSTER_RING_GAP;
        x = centerX + Math.cos(angle) * ringRadius;
        y = centerY + Math.sin(angle) * ringRadius;
      }

      const layoutNode = {
        ...node,
        x,
        y,
        r: 12 + Math.min(node.filteredEvents, 40) * 0.12,
      };
      nodeLayouts.push(layoutNode);
      nodePos[node.id] = layoutNode;
    });
  });

  const edgeLayouts = graph.edges
    .filter(edge => nodePos[edge.source] && nodePos[edge.target])
    .map(edge => {
      const src = nodePos[edge.source];
      const tgt = nodePos[edge.target];
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = dx / dist;
      const ny = dy / dist;
      const mx = (src.x + tgt.x) / 2;
      const my = (src.y + tgt.y) / 2;
      const curve = Math.min(42, dist * 0.16);
      return {
        ...edge,
        x1: src.x + nx * src.r,
        y1: src.y + ny * src.r,
        x2: tgt.x - nx * tgt.r,
        y2: tgt.y - ny * tgt.r,
        cx: mx - ny * curve,
        cy: my + nx * curve,
      };
    });

  const totalHeight = (bounds.maxY - bounds.minY) + OVERVIEW_PAD_Y * 2 + 40;

  return {
    overviewNetwork: true,
    totalHeight,
    network: {
      nodes: nodeLayouts,
      edges: edgeLayouts,
      communityEdges: graph.communityEdges ?? [],
      clusters: clusterLayouts,
      meta: graph.meta,
    },
  };
}

function _layoutFocusedCommunity(graph, width, cluster) {
  const members = graph.nodes
    .filter(node => cluster.nodeIds.includes(node.id))
    .sort((a, b) => b.weightedDegree - a.weightedDegree || b.degree - a.degree || a.id.localeCompare(b.id));

  const centerX = Math.max(width * 0.5, OVERVIEW_PAD_X + 360);
  const centerY = OVERVIEW_PAD_Y + 340;
  const focusRadius = Math.max(138, Math.min(width * 0.18, 230));
  const nodeLayouts = [];
  const nodePos = {};

  members.forEach((node, index) => {
    let x = centerX;
    let y = centerY;
    if (index > 0) {
      const angle = index * COMMUNITY_SPIRAL_TURNS;
      const distance = Math.min(focusRadius, 26 + Math.sqrt(index) * 26);
      x = centerX + Math.cos(angle) * distance;
      y = centerY + Math.sin(angle) * distance;
    }

    const layoutNode = {
      ...node,
      x,
      y,
      r: 13 + Math.min(node.filteredEvents, 36) * 0.18,
    };
    nodeLayouts.push(layoutNode);
    nodePos[node.id] = layoutNode;
  });

  const resourceSatellites = _layoutFocusSatelliteColumn(
    (cluster.resources ?? []).slice(0, FOCUS_RESOURCE_LIMIT),
    centerX - focusRadius - 150,
    centerY - 120,
    "resource",
  );
  const attributeSatellites = _layoutFocusSatelliteColumn(
    (cluster.attributes ?? []).slice(0, FOCUS_ATTR_LIMIT),
    centerX + focusRadius + 150,
    centerY - 120,
    "attribute",
  );
  const satellites = [...resourceSatellites, ...attributeSatellites];

  const edgeLayouts = graph.edges
    .filter(edge => nodePos[edge.source] && nodePos[edge.target])
    .map(edge => {
      const src = nodePos[edge.source];
      const tgt = nodePos[edge.target];
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = dx / dist;
      const ny = dy / dist;
      const mx = (src.x + tgt.x) / 2;
      const my = (src.y + tgt.y) / 2;
      const curve = Math.min(54, dist * 0.18);
      return {
        ...edge,
        x1: src.x + nx * src.r,
        y1: src.y + ny * src.r,
        x2: tgt.x - nx * tgt.r,
        y2: tgt.y - ny * tgt.r,
        cx: mx - ny * curve,
        cy: my + nx * curve,
      };
    });

  const minX = Math.min(
    centerX - focusRadius - 220,
    ...satellites.map(s => s.x - s.w / 2),
  );
  const maxX = Math.max(
    centerX + focusRadius + 220,
    ...satellites.map(s => s.x + s.w / 2),
  );
  const minY = Math.min(centerY - focusRadius - 130, ...satellites.map(s => s.y - s.h / 2));
  const maxY = Math.max(centerY + focusRadius + 130, ...satellites.map(s => s.y + s.h / 2));

  return {
    overviewNetwork: true,
    totalHeight: maxY + OVERVIEW_PAD_Y,
    network: {
      nodes: nodeLayouts,
      edges: edgeLayouts,
      communityEdges: [],
      clusters: [{
        ...cluster,
        x: centerX,
        y: centerY,
        radius: focusRadius,
        outerRadius: Math.max(maxX - centerX, centerX - minX, maxY - centerY, centerY - minY),
        width: maxX - minX,
        height: maxY - minY,
        count: members.length,
        satellites,
      }],
      meta: graph.meta,
    },
  };
}

function _layoutSatelliteArc(entries, baseRadius, startAngle, endAngle) {
  return (entries ?? []).map((entry, index) => {
    const ringIndex = Math.floor(index / SATELLITES_PER_RING);
    const slotIndex = index % SATELLITES_PER_RING;
    const remaining = Math.max((entries?.length ?? 0) - ringIndex * SATELLITES_PER_RING, 0);
    const slotCount = Math.min(SATELLITES_PER_RING, remaining || SATELLITES_PER_RING);
    const angle = startAngle + ((slotIndex + 0.5) / Math.max(slotCount, 1)) * (endAngle - startAngle);
    const radius = baseRadius + ringIndex * SATELLITE_RING_GAP;
    const label = entry.shortLabel ?? entry.label ?? "";
    return {
      ...entry,
      dx: Math.cos(angle) * radius,
      dy: Math.sin(angle) * radius,
      w: Math.min(136, Math.max(44, 18 + label.length * (entry.type === "attribute" ? 5.3 : 4.9))),
      h: entry.type === "attribute" ? 18 : 20,
      angle,
    };
  });
}

function _layoutFocusSatelliteColumn(entries, x, startY, type) {
  return (entries ?? []).map((entry, index) => {
    const label = entry.shortLabel ?? entry.label ?? "";
    return {
      ...entry,
      type,
      x,
      y: startY + index * 28,
      w: Math.min(168, Math.max(72, 20 + label.length * (type === "attribute" ? 5.1 : 4.8))),
      h: type === "attribute" ? 18 : 20,
    };
  });
}

function _layoutBlock(graph, expanded, startY, timelineW, options = {}) {
  const { po, poAttrs, itemAttrsById } = graph;
  const allItems = [...(graph.allItems ?? graph.items ?? [])];
  const visibleItems = [...(graph.items ?? allItems)];
  const allEvents = [...(graph.allEvents ?? graph.events ?? [])];
  const allDfItem = [...(graph.allDfItem ?? graph.dfItem ?? [])];
  const allDfPo = [...(graph.allDfPo ?? graph.dfPo ?? [])];
  allEvents.forEach(e => { if (!e.id) e.id = e.event_id; });
  const evById = Object.fromEntries(allEvents.map(e => [e.id, e]));
  const eventsByItem = _groupBy(allEvents, e => e.poitem_id);
  const dfItemByEntity = _groupBy(allDfItem, edge => edge.entityId);
  const patternAnalysis = _analyzeEntityPatterns(allItems, eventsByItem, dfItemByEntity, evById);
  const items = options.showDeviantsOnly
    ? allItems.filter(item => !(patternAnalysis.entityPatterns[item]?.followsDominant ?? true))
    : visibleItems;
  const displayedDfItemCount = items.reduce((sum, item) => sum + (dfItemByEntity[item]?.length ?? 0), 0);

  const rowHeights = items.map(item => expanded.has(item) ? ROW_H_EXPANDED : ROW_H_COLLAPSED);
  const contentH = rowHeights.reduce((a, b) => a + b, 0);
  const totalHeight = BLOCK_PAD_TOP + contentH + BLOCK_PAD_BOT;
  const poMidY = startY + BLOCK_PAD_TOP + contentH / 2;

  const itemRows = [];
  let rowY = startY + BLOCK_PAD_TOP;
  let blockContentMaxX = ITEM_X + ITEM_R + 180;

  items.forEach((item, i) => {
    const h = rowHeights[i];
    const midY = rowY + h / 2;
    const color = ITEM_COLORS[i % ITEM_COLORS.length];
    const isExp = expanded.has(item);
    const itemAttrs = itemAttrsById?.[item] ?? {};
    const entityPattern = patternAnalysis.entityPatterns[item] ?? {
      sequence: [],
      followsDominant: true,
      entityType: "POItem",
    };

    const itemEvs = [...(eventsByItem[item] ?? [])].sort(_compareEvents);
    const evCount = itemEvs.length;
    const firstDate = itemEvs[0]?.date;
    const lastDate = itemEvs.at(-1)?.date;
    const dateRange = firstDate ? `${_fmt(firstDate)} -> ${_fmt(lastDate)}` : "no events";

    let timelineNodes = [];
    let dfItemEdges = [];
    let resourceNodes = [];
    let resourceLinks = [];
    let laneX2 = ITEM_X + ITEM_R + 180;

    if (isExp && itemEvs.length > 0) {
      const minT = itemEvs[0].date.getTime();
      const maxT = itemEvs.at(-1).date.getTime();
      const span = Math.max(maxT - minT, 1);

      let xs = itemEvs.map(e => TIMELINE_X0 + ((e.date.getTime() - minT) / span) * timelineW);
      for (let j = 1; j < xs.length; j++) {
        if (xs[j] - xs[j - 1] < MIN_EVENT_SPACING) xs[j] = xs[j - 1] + MIN_EVENT_SPACING;
      }

      timelineNodes = itemEvs.map((e, j) => ({ ...e, x: xs[j], y: midY, r: EVENT_R, color }));
      const posMap = Object.fromEntries(timelineNodes.map(n => [n.id, n]));

      dfItemEdges = (dfItemByEntity[item] ?? [])
        .filter(edge => {
          const se = evById[edge.source];
          const te = evById[edge.target];
          return se && te && se.poitem_id === item && te.poitem_id === item && posMap[edge.source] && posMap[edge.target];
        })
        .map(edge => {
          const src = posMap[edge.source];
          const tgt = posMap[edge.target];
          const srcEvent = evById[edge.source];
          const tgtEvent = evById[edge.target];
          return {
            id: `df-${edge.entityId}-${edge.source}-${edge.target}`,
            entityId: edge.entityId,
            sourceId: edge.source,
            targetId: edge.target,
            sourceActivity: srcEvent?.activity ?? edge.source,
            targetActivity: tgtEvent?.activity ?? edge.target,
            gapHours: _hoursBetween(srcEvent?.date, tgtEvent?.date),
            isBottleneck: false,
            type: Math.abs(src.x - tgt.x) < 2 ? "arc" : "line",
            x1: src.x,
            y1: src.y,
            x2: tgt.x,
            y2: tgt.y,
            color,
          };
        });

      const resY = rowY + 42;
      const byResource = {};
      timelineNodes.filter(n => _hasResourceValue(n.org_resource)).forEach(n => {
        if (!byResource[n.org_resource]) byResource[n.org_resource] = [];
        byResource[n.org_resource].push(n);
      });

      resourceNodes = Object.entries(byResource)
        .map(([resource, nodes]) => ({
          id: resource,
          label: resource,
          shortLabel: _shortResource(resource),
          count: nodes.length,
          color: nodes[0].resourceColor,
          x: nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length,
          y: resY,
          nodes,
        }))
        .sort((a, b) => a.x - b.x);

      for (let j = 1; j < resourceNodes.length; j++) {
        if (resourceNodes[j].x - resourceNodes[j - 1].x < MIN_RESOURCE_SPACING) {
          resourceNodes[j].x = resourceNodes[j - 1].x + MIN_RESOURCE_SPACING;
        }
      }
      for (let j = resourceNodes.length - 2; j >= 0; j--) {
        resourceNodes[j].x = Math.min(resourceNodes[j].x, resourceNodes[j + 1].x - MIN_RESOURCE_SPACING);
      }

      const maxX = TIMELINE_X0 + timelineW;
      resourceNodes = resourceNodes.map(node => ({
        ...node,
        x: Math.max(TIMELINE_X0 + 10, Math.min(node.x, maxX)),
      }));

      resourceLinks = resourceNodes.flatMap(node =>
        node.nodes.map(n => ({
          id: `res-${node.id}-${n.id}`,
          x1: node.x,
          y1: node.y + 10,
          x2: n.x,
          y2: midY - EVENT_R - 2,
          color: node.color,
        }))
      );

      const lastTimelineX = timelineNodes.at(-1)?.x ?? TIMELINE_X0;
      const lastResourceX = resourceNodes.reduce((max, node) => Math.max(max, node.x + 12), TIMELINE_X0);
      laneX2 = Math.max(lastTimelineX + EVENT_R + 46, lastResourceX + 18);
    }

    itemRows.push({
      item,
      i,
      h,
      midY,
      rowY,
      color,
      followsDominant: entityPattern.followsDominant,
      sequence: entityPattern.sequence,
      entityType: entityPattern.entityType,
      isExp,
      timelineNodes,
      dfItemEdges,
      resourceNodes,
      resourceLinks,
      itemAttrs,
      evCount,
      dateRange,
      laneX2,
      corrEdge: { x1: ITEM_X, y1: midY, x2: PO_X, y2: poMidY },
    });
    blockContentMaxX = Math.max(blockContentMaxX, laneX2);
    rowY += h;
  });

  const allPos = {};
  itemRows.forEach(row => {
    if (row.isExp) {
      row.timelineNodes.forEach(n => { allPos[n.id] = { x: n.x, y: n.y }; });
    } else {
      allEvents
        .filter(e => e.poitem_id === row.item)
        .forEach(e => { allPos[e.id] = { x: ITEM_X, y: row.midY }; });
    }
  });

  const displayedItemSet = new Set(itemRows.map(row => row.item));
  const dfPoEdges = (allDfPo ?? [])
    .filter(edge => {
      const se = evById[edge.source];
      const te = evById[edge.target];
      return se && te && se.poitem_id !== te.poitem_id && allPos[edge.source] && allPos[edge.target];
    })
    .filter(edge => displayedItemSet.has(evById[edge.source]?.poitem_id) && displayedItemSet.has(evById[edge.target]?.poitem_id))
    .map(edge => {
      const src = allPos[edge.source];
      const tgt = allPos[edge.target];
      const mx = (src.x + tgt.x) / 2;
      const dy = Math.abs(src.y - tgt.y);
      const cy = Math.min(src.y, tgt.y) - Math.max(dy * 0.4, 24);
      return { id: `dfpo-${edge.source}-${edge.target}`, x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y, cx: mx, cy };
    });

  _annotateSyncEvents(itemRows, patternAnalysis, displayedItemSet);
  const bottleneckThresholdHours = _annotateBottlenecks(itemRows);

  return {
    po,
    items,
    patterns: {
      dominantPattern: patternAnalysis.dominantPattern,
      entityPatterns: Object.fromEntries(
        Object.entries(patternAnalysis.entityPatterns).map(([entityId, entry]) => [
          entityId,
          {
            sequence: entry.sequence,
            followsDominant: entry.followsDominant,
          },
        ])
      ),
      entityType: patternAnalysis.entityType,
    },
    totalHeight,
    poMidY,
    startY,
    itemRows,
    contentMaxX: blockContentMaxX,
    dfPoEdges,
    displayedDfItemCount,
    poAttrs,
    meta: graph.meta,
    bottleneckThresholdHours,
    isOverview: false,
  };
}

function _analyzeEntityPatterns(entityIds, eventsByEntity, edgesByEntity, evById) {
  const entityEntries = {};
  const sequenceCounts = new Map();
  let entityType = "POItem";

  entityIds.forEach(entityId => {
    const events = [...(eventsByEntity[entityId] ?? [])].sort(_compareEvents);
    const edges = (edgesByEntity[entityId] ?? []).filter(edge => evById[edge.source] && evById[edge.target]);
    const traced = _traceEntityPath(events, edges, evById);
    const sequence = traced.eventIds
      .map(eventId => evById[eventId]?.activity)
      .filter(Boolean);
    const sequenceKey = JSON.stringify(sequence);
    if (sequence.length > 0) {
      sequenceCounts.set(sequenceKey, (sequenceCounts.get(sequenceKey) ?? 0) + 1);
    }
    entityType = edges[0]?.entityType ?? entityType;
    entityEntries[entityId] = {
      entityId,
      entityType: edges[0]?.entityType ?? entityType,
      sequence,
      eventIds: traced.eventIds,
      predecessorActivities: traced.predecessorActivities,
      successorActivities: traced.successorActivities,
      followsDominant: true,
    };
  });

  const dominantPatternKey = [...sequenceCounts.entries()]
    .sort((a, b) =>
      b[1] - a[1] ||
      JSON.parse(b[0]).length - JSON.parse(a[0]).length ||
      a[0].localeCompare(b[0])
    )[0]?.[0] ?? "[]";
  const dominantPattern = JSON.parse(dominantPatternKey);

  Object.values(entityEntries).forEach(entry => {
    entry.followsDominant = entry.sequence.length === 0 || _sameSequence(entry.sequence, dominantPattern);
  });

  const eventMemberships = new Map();
  const syncContextsByEvent = new Map();
  Object.values(entityEntries).forEach(entry => {
    [...new Set(entry.eventIds)].forEach(eventId => {
      if (!eventMemberships.has(eventId)) eventMemberships.set(eventId, new Set());
      eventMemberships.get(eventId).add(entry.entityId);
      if (!syncContextsByEvent.has(eventId)) syncContextsByEvent.set(eventId, []);
      syncContextsByEvent.get(eventId).push({
        entityId: entry.entityId,
        predecessorActivities: entry.predecessorActivities[eventId] ?? [],
        successorActivities: entry.successorActivities[eventId] ?? [],
      });
    });
  });

  return {
    entityType,
    dominantPattern,
    entityPatterns: entityEntries,
    eventMemberships,
    syncContextsByEvent,
  };
}

function _traceEntityPath(events, edges, evById) {
  const predecessorIds = {};
  const successorIds = {};
  const nodeIds = new Set(events.map(event => event.id));

  edges.forEach(edge => {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
    if (!successorIds[edge.source]) successorIds[edge.source] = [];
    if (!predecessorIds[edge.target]) predecessorIds[edge.target] = [];
    successorIds[edge.source].push(edge.target);
    predecessorIds[edge.target].push(edge.source);
  });

  const nodes = [...nodeIds].filter(eventId => evById[eventId]).sort(_compareEventIds(evById));
  const starts = nodes.filter(eventId => (predecessorIds[eventId] ?? []).length === 0);
  const orderedStarts = (starts.length ? starts : nodes).sort(_compareEventIds(evById));
  const visited = new Set();
  const orderedEventIds = [];
  const queue = [...orderedStarts];

  while (queue.length) {
    let current = queue.shift();
    while (current && !visited.has(current)) {
      orderedEventIds.push(current);
      visited.add(current);
      const nextIds = [...new Set(successorIds[current] ?? [])]
        .filter(eventId => !visited.has(eventId))
        .sort(_compareEventIds(evById));
      if (nextIds.length <= 1) {
        current = nextIds[0] ?? null;
        continue;
      }
      queue.unshift(...nextIds.slice(1));
      current = nextIds[0];
    }
  }

  nodes.forEach(eventId => {
    if (!visited.has(eventId)) orderedEventIds.push(eventId);
  });

  const predecessorActivities = {};
  const successorActivities = {};
  nodes.forEach(eventId => {
    predecessorActivities[eventId] = [...new Set((predecessorIds[eventId] ?? [])
      .map(id => evById[id]?.activity)
      .filter(Boolean))];
    successorActivities[eventId] = [...new Set((successorIds[eventId] ?? [])
      .map(id => evById[id]?.activity)
      .filter(Boolean))];
  });

  return { eventIds: orderedEventIds, predecessorActivities, successorActivities };
}

function _annotateSyncEvents(itemRows, patternAnalysis, displayedItemSet) {
  itemRows.forEach(row => {
    row.timelineNodes = row.timelineNodes.map(node => {
      const sharedEntityIds = [...(patternAnalysis.eventMemberships.get(node.id) ?? new Set())]
        .filter(entityId => displayedItemSet.has(entityId))
        .sort((a, b) => a.localeCompare(b));
      const syncDegree = Math.max(sharedEntityIds.length, 1);
      return {
        ...node,
        isSyncEvent: sharedEntityIds.length > 1,
        syncDegree,
        sharedEntityIds,
        syncContexts: (patternAnalysis.syncContextsByEvent.get(node.id) ?? [])
          .filter(context => displayedItemSet.has(context.entityId))
          .sort((a, b) => a.entityId.localeCompare(b.entityId)),
      };
    });
  });
}

function _annotateBottlenecks(itemRows) {
  const edges = itemRows.flatMap(row => row.dfItemEdges).filter(edge => Number.isFinite(edge.gapHours));
  const threshold = _quantile(edges.map(edge => edge.gapHours), 0.75);
  itemRows.forEach(row => {
    row.dfItemEdges = row.dfItemEdges.map(edge => ({
      ...edge,
      isBottleneck: Number.isFinite(threshold) && edge.gapHours > threshold,
    }));
  });
  return threshold;
}

function _summarizeFocusBlocks(blocks) {
  return blocks.reduce((summary, block) => {
    summary.totalItems += block.meta?.totalItems ?? 0;
    summary.shownItems += block.itemRows.length;
    summary.totalEvents += block.meta?.totalEvents ?? 0;
    summary.filteredEvents += block.itemRows.reduce((sum, row) => sum + row.evCount, 0);
    summary.dfItemCount += block.displayedDfItemCount ?? block.itemRows.reduce((sum, row) => sum + row.dfItemEdges.length, 0);
    summary.dfPoCount += block.dfPoEdges.length;
    return summary;
  }, {
    totalItems: 0,
    shownItems: 0,
    totalEvents: 0,
    filteredEvents: 0,
    dfItemCount: 0,
    dfPoCount: 0,
  });
}

function _groupBy(items, getKey) {
  return (items ?? []).reduce((acc, item) => {
    const key = getKey(item);
    if (key === undefined || key === null || key === "") return acc;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function _compareEvents(a, b) {
  return (a?.date?.getTime?.() ?? 0) - (b?.date?.getTime?.() ?? 0) ||
    String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

function _compareEventIds(evById) {
  return (a, b) => _compareEvents(evById[a], evById[b]);
}

function _hoursBetween(a, b) {
  if (!(a instanceof Date) || Number.isNaN(a.getTime()) || !(b instanceof Date) || Number.isNaN(b.getTime())) {
    return 0;
  }
  return Math.max((b.getTime() - a.getTime()) / HOUR_MS, 0);
}

function _quantile(values, q) {
  const sorted = [...(values ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function _sameSequence(a, b) {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function _fmt(d) {
  return d?.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) ?? "?";
}

function _shortResource(resource) {
  return resource.length > 12 ? `${resource.slice(0, 9)}...` : resource;
}

function _hasResourceValue(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim();
  return normalized !== "" && normalized.toUpperCase() !== "NONE";
}
