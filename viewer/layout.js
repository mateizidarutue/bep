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

export function computeLayout(graphs, expanded, width) {
  if (graphs.length === 1 && graphs[0]?.isOverviewNetwork) {
    return _layoutOverviewNetwork(graphs[0], width);
  }

  const timelineW = Math.max(width - TIMELINE_X0 - TIMELINE_PAD_R, 180);
  let curY = 20;
  const poBlocks = [];
  graphs.forEach(graph => {
    const block = _layoutBlock(graph, expanded, curY, timelineW);
    poBlocks.push(block);
    curY += block.totalHeight + MULTI_PO_GAP;
  });
  return { overviewNetwork: false, poBlocks, totalHeight: curY };
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

function _layoutBlock(graph, expanded, startY, timelineW) {
  const { po, items, events, dfItem, dfPo, poAttrs, itemAttrsById } = graph;
  events.forEach(e => { if (!e.id) e.id = e.event_id; });
  const evById = Object.fromEntries(events.map(e => [e.id, e]));

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

    const itemEvs = events.filter(e => e.poitem_id === item).sort((a, b) => a.date - b.date);
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

      dfItemEdges = (dfItem ?? [])
        .filter(([s, t]) => {
          const se = evById[s];
          const te = evById[t];
          return se && te && se.poitem_id === item && te.poitem_id === item && posMap[s] && posMap[t];
        })
        .map(([s, t]) => {
          const src = posMap[s];
          const tgt = posMap[t];
          return {
            id: `df-${s}-${t}`,
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
      events
        .filter(e => e.poitem_id === row.item)
        .forEach(e => { allPos[e.id] = { x: ITEM_X, y: row.midY }; });
    }
  });

  const dfPoEdges = (dfPo ?? [])
    .filter(([s, t]) => {
      const se = evById[s];
      const te = evById[t];
      return se && te && se.poitem_id !== te.poitem_id && allPos[s] && allPos[t];
    })
    .map(([s, t]) => {
      const src = allPos[s];
      const tgt = allPos[t];
      const mx = (src.x + tgt.x) / 2;
      const dy = Math.abs(src.y - tgt.y);
      const cy = Math.min(src.y, tgt.y) - Math.max(dy * 0.4, 24);
      return { id: `dfpo-${s}-${t}`, x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y, cx: mx, cy };
    });

  return {
    po,
    items,
    totalHeight,
    poMidY,
    startY,
    itemRows,
    contentMaxX: blockContentMaxX,
    dfPoEdges,
    poAttrs,
    meta: graph.meta,
    isOverview: false,
  };
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
