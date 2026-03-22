/**
 * layout.js
 * ---------
 * Hub-and-spoke layout with progressive disclosure.
 *
 * Default view (collapsed):
 *   PO node (left) → CORR line → POItem node → summary chip
 *
 * Expanded view (click POItem):
 *   POItem node → connector → event timeline (left-to-right by timestamp)
 *   DF edges between consecutive events as horizontal arrows
 *
 * References: Esser & Fahland (2021), Sugiyama et al. (1981)
 */

"use strict";

export const ITEM_COLORS = [
  "#159a67", "#8b5cf6", "#d97706", "#dc2626", "#0284c7",
];
export const PO_COLOR = "#2563eb";

export const PO_R    = 20;
export const ITEM_R  = 14;
export const EVENT_R =  7;

export const PO_X        = 80;
export const ITEM_X      = 200;
export const TIMELINE_X0 = 272;

const ROW_H_COLLAPSED   = 52;
const ROW_H_EXPANDED    = 124;
const BLOCK_PAD_TOP     = 24;
const BLOCK_PAD_BOT     = 16;
const MULTI_PO_GAP      = 28;
const TIMELINE_PAD_R    = 48;
const MIN_EVENT_SPACING = 22;
const MIN_RESOURCE_SPACING = 46;

export function computeLayout(graphs, expanded, width) {
  const timelineW = Math.max(width - TIMELINE_X0 - TIMELINE_PAD_R, 180);
  let curY = 20;
  const poBlocks = [];
  graphs.forEach(graph => {
    const block = _layoutBlock(graph, expanded, curY, timelineW);
    poBlocks.push(block);
    curY += block.totalHeight + MULTI_PO_GAP;
  });
  return { poBlocks, totalHeight: curY };
}

function _layoutBlock(graph, expanded, startY, timelineW) {
  const { po, items, events, dfItem, dfPo, poAttrs, itemAttrsById } = graph;
  events.forEach(e => { if (!e.id) e.id = e.event_id; });
  const evById = Object.fromEntries(events.map(e => [e.id, e]));

  const rowHeights  = items.map(item => expanded.has(item) ? ROW_H_EXPANDED : ROW_H_COLLAPSED);
  const contentH    = rowHeights.reduce((a, b) => a + b, 0);
  const totalHeight = BLOCK_PAD_TOP + contentH + BLOCK_PAD_BOT;
  const poMidY      = startY + BLOCK_PAD_TOP + contentH / 2;

  const itemRows = [];
  let rowY = startY + BLOCK_PAD_TOP;

  items.forEach((item, i) => {
    const h     = rowHeights[i];
    const midY  = rowY + h / 2;
    const color = ITEM_COLORS[i % ITEM_COLORS.length];
    const isExp = expanded.has(item);
    const itemAttrs = itemAttrsById?.[item] ?? {};

    const itemEvs = events.filter(e => e.poitem_id === item).sort((a, b) => a.date - b.date);
    const evCount   = itemEvs.length;
    const firstDate = itemEvs[0]?.date;
    const lastDate  = itemEvs.at(-1)?.date;
    const dateRange = firstDate ? `${_fmt(firstDate)} → ${_fmt(lastDate)}` : "no events";

    let timelineNodes = [];
    let dfItemEdges   = [];
    let resourceNodes = [];
    let resourceLinks = [];

    if (isExp && itemEvs.length > 0) {
      const minT = itemEvs[0].date.getTime();
      const maxT = itemEvs.at(-1).date.getTime();
      const span = Math.max(maxT - minT, 1);

      let xs = itemEvs.map(e => TIMELINE_X0 + ((e.date.getTime() - minT) / span) * timelineW);
      for (let j = 1; j < xs.length; j++) {
        if (xs[j] - xs[j - 1] < MIN_EVENT_SPACING) xs[j] = xs[j - 1] + MIN_EVENT_SPACING;
      }

      timelineNodes = itemEvs.map((e, j) => ({ ...e, x: xs[j], y: midY, r: EVENT_R, color }));
      const posMap  = Object.fromEntries(timelineNodes.map(n => [n.id, n]));

      dfItemEdges = (dfItem ?? [])
        .filter(([s, t]) => {
          const se = evById[s], te = evById[t];
          return se && te && se.poitem_id === item && te.poitem_id === item && posMap[s] && posMap[t];
        })
        .map(([s, t]) => {
          const src = posMap[s], tgt = posMap[t];
          return { id: `df-${s}-${t}`, type: Math.abs(src.x - tgt.x) < 2 ? "arc" : "line",
                   x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y, color };
        });

      const resY = rowY + 42;
      const byResource = {};
      timelineNodes.filter(n => n.org_resource).forEach(n => {
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
    }

    itemRows.push({ item, i, h, midY, rowY, color, isExp, timelineNodes, dfItemEdges,
                    resourceNodes, resourceLinks, itemAttrs, evCount, dateRange,
                    corrEdge: { x1: ITEM_X, y1: midY, x2: PO_X, y2: poMidY } });
    rowY += h;
  });

  const allPos = {};
  itemRows.forEach(row => {
    if (row.isExp) {
      row.timelineNodes.forEach(n => { allPos[n.id] = { x: n.x, y: n.y }; });
    } else {
      events.filter(e => e.poitem_id === row.item).forEach(e => { allPos[e.id] = { x: ITEM_X, y: row.midY }; });
    }
  });

  const dfPoEdges = (dfPo ?? [])
    .filter(([s, t]) => {
      const se = evById[s], te = evById[t];
      return se && te && se.poitem_id !== te.poitem_id && allPos[s] && allPos[t];
    })
    .map(([s, t]) => {
      const src = allPos[s], tgt = allPos[t];
      const mx  = (src.x + tgt.x) / 2;
      const dy  = Math.abs(src.y - tgt.y);
      const cy  = Math.min(src.y, tgt.y) - Math.max(dy * 0.4, 24);
      return { id: `dfpo-${s}-${t}`, x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y, cx: mx, cy };
    });

  return { po, items, totalHeight, poMidY, startY, itemRows, dfPoEdges, poAttrs, meta: graph.meta };
}

function _fmt(d) {
  return d?.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) ?? "?";
}

function _shortResource(resource) {
  return resource.length > 12 ? `${resource.slice(0, 9)}...` : resource;
}
