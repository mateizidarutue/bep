/**
 * render.js
 * ---------
 * Renders the hub-and-spoke EKG layout.
 * Consumes output of layout.js. No layout logic here.
 *
 * Visual hierarchy (left → right):
 *   PO node → CORR dash → POItem node → [expand] → event timeline → DF arrows
 */

"use strict";

import {
  computeLayout,
  PO_COLOR, ITEM_COLORS,
  PO_R, ITEM_R, EVENT_R,
  PO_X, ITEM_X, TIMELINE_X0,
} from "./layout.js";

let svg, gRoot, zoom;
let miniSvg, miniRoot, miniViewport;
let _cb    = {};
let _graphs   = [];
let _expanded = new Set();
let _currentTransform = null;
let _lastTotalHeight = 0;
let _lastContentBounds = null;

const vis = { dfItem: true, dfPo: true, corr: true };
const opa = { dfItem: 0.8,  dfPo: 0.5, corr: 0.4 };
const FIT_PAD_X = 84;
const FIT_PAD_Y = 64;
const FIT_MAX_SCALE = 1.4;
const FIT_READABLE_MIN_SCALE = 0.32;
const CAMERA_EASE_MS = 420;
const MINIMAP_PAD = 28;

// ── Init ──────────────────────────────────────────────────────────────────────

export function init(svgId, onTooltipShow, onTooltipHide, onItemExpand, minimapId = null) {
  svg   = d3.select(`#${svgId}`);
  gRoot = svg.append("g").attr("class", "root");
  _currentTransform = d3.zoomIdentity;
  _addMarkers(svg.append("defs"));
  zoom = d3.zoom()
    .scaleExtent([0.05, 6])
    .wheelDelta(_wheelDelta)
    .on("zoom", e => {
      _currentTransform = e.transform;
      gRoot.attr("transform", _currentTransform);
      _updateMinimapViewport();
    });
  svg.call(zoom);
  svg.on("dblclick.zoom", null);

  if (minimapId) {
    miniSvg = d3.select(`#${minimapId}`);
    miniSvg.selectAll("*").remove();
    miniRoot = miniSvg.append("g").attr("class", "minimap-root");
    miniViewport = miniSvg.append("rect")
      .attr("class", "minimap-viewport")
      .attr("rx", 14)
      .attr("ry", 14);
    miniSvg.on("click", _onMinimapClick);
  }

  _cb = { onTooltipShow, onTooltipHide, onItemExpand };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function draw(graphs, expanded) {
  if (!svg) throw new Error("Call init() first.");
  _graphs   = graphs;
  _expanded = expanded;

  const w      = svg.node().clientWidth;
  const layout = computeLayout(graphs, expanded, w);

  gRoot.selectAll("*").remove();

  // Painter layers: back → front
  const lBg     = gRoot.append("g").attr("class", "l-bg");
  const lDfPo   = gRoot.append("g").attr("class", "l-dfpo");
  const lCorr   = gRoot.append("g").attr("class", "l-corr");
  const lDfItem = gRoot.append("g").attr("class", "l-dfitem");
  const lNodes  = gRoot.append("g").attr("class", "l-nodes");
  const lLabels = gRoot.append("g").attr("class", "l-labels");

  layout.poBlocks.forEach(block =>
    _drawBlock(block, lBg, lDfPo, lCorr, lDfItem, lNodes, lLabels)
  );

  _lastTotalHeight = layout.totalHeight;
  _applyVisibility();
  _updateTranslateExtent(layout.totalHeight);
  _refreshMinimap();
  fitToView(layout.totalHeight, { animate: true });
}

export function setVisibility(key, val) {
  vis[key] = val;
  _applyVisibility();
  _refreshMinimap();
}

export function setOpacity(key, val) {
  opa[key] = val;
  _applyVisibility();
  _refreshMinimap();
}

export function fitToView(totalHeight, options = {}) {
  if (!svg) return;
  const transform = _computeFitTransform(totalHeight);
  if (!transform) return;
  _applyTransform(transform, options.animate ?? true);
}

export function resetZoom() {
  fitToView(undefined, { animate: true });
}

export function panBy(dx, dy, options = {}) {
  if (!svg || !zoom) return;
  const animate = options.animate ?? true;
  const k = _currentTransform.k || 1;
  const selection = animate
    ? svg.transition().duration(CAMERA_EASE_MS / 2).ease(d3.easeCubicOut)
    : svg;
  selection.call(zoom.translateBy, dx / k, dy / k);
}

export function zoomBy(factor, options = {}) {
  if (!svg || !zoom) return;
  const animate = options.animate ?? true;
  const node = svg.node();
  const center = options.center ?? [node.clientWidth / 2, node.clientHeight / 2];
  const selection = animate
    ? svg.transition().duration(CAMERA_EASE_MS / 2).ease(d3.easeCubicOut)
    : svg;
  selection.call(zoom.scaleBy, factor, center);
}

// ── Draw one PO block ─────────────────────────────────────────────────────────

function _drawBlock(block, lBg, lDfPo, lCorr, lDfItem, lNodes, lLabels) {
  const { po, poMidY, startY, totalHeight, itemRows, dfPoEdges } = block;
  const W = _svgW();

  // Block background card
  lBg.append("rect")
    .attr("x", 12).attr("y", startY + 4)
    .attr("width", W - 24).attr("height", totalHeight - 8)
    .attr("fill", "rgba(37,99,235,0.04)")
    .attr("stroke", "rgba(37,99,235,0.14)")
    .attr("stroke-width", 1).attr("rx", 10);

  // Vertical guide line from PO down through all item rows
  lBg.append("line")
    .attr("x1", ITEM_X).attr("y1", startY + 24)
    .attr("x2", ITEM_X).attr("y2", startY + totalHeight - 16)
    .attr("stroke", "rgba(34,48,71,0.12)")
    .attr("stroke-width", 1);

  // PO node
  const poG = lNodes.append("g")
    .attr("transform", `translate(${PO_X},${poMidY})`)
    .style("cursor", "default");

  // Outer ring (subtle glow)
  poG.append("circle")
    .attr("r", PO_R + 5)
    .attr("fill", "rgba(37,99,235,0.08)")
    .attr("stroke", "none");

  poG.append("circle")
    .attr("r", PO_R)
    .attr("fill", "rgba(37,99,235,0.16)")
    .attr("stroke", PO_COLOR)
    .attr("stroke-width", 2);

  poG.append("text")
    .attr("text-anchor", "middle").attr("dy", "-0.15em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "8px").attr("font-weight", "600")
    .attr("fill", PO_COLOR).attr("pointer-events", "none")
    .text("PO");

  poG.append("text")
    .attr("text-anchor", "middle").attr("dy", "1em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "7px")
    .attr("fill", PO_COLOR).attr("opacity", 0.6).attr("pointer-events", "none")
    .text(po.slice(-6)); // last 6 digits to fit

  poG.on("mousemove", ev =>
    _cb.onTooltipShow(
      `<div class="tip-title">PO ${po}</div>
       <div class="tip-row">Items: <b>${block.items.length}</b></div>
       <div class="tip-row">Total events: <b>${block.meta?.totalEvents ?? "—"}</b></div>`,
      ev.offsetX, ev.offsetY
    )
  ).on("mouseleave", _cb.onTooltipHide);

  // PO-level DF arcs
  lDfPo.selectAll(null).data(dfPoEdges).join("path")
    .attr("class", "edge-dfpo")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none").attr("stroke", PO_COLOR)
    .attr("stroke-width", 1.2).attr("stroke-dasharray", "5 3")
    .attr("marker-end", "url(#arr-dfpo)");

  // Draw each item row
  itemRows.forEach(row => _drawItemRow(row, lCorr, lDfItem, lNodes, lLabels));
}

// ── Draw one POItem row ───────────────────────────────────────────────────────

function _drawItemRow(row, lCorr, lDfItem, lNodes, lLabels) {
  const { item, midY, rowY, h, color, isExp, corrEdge,
          timelineNodes, dfItemEdges, evCount, dateRange } = row;

  // CORR dash: POItem → PO node
  lCorr.append("line").attr("class", "edge-corr")
    .attr("x1", corrEdge.x1).attr("y1", corrEdge.y1)
    .attr("x2", corrEdge.x2).attr("y2", corrEdge.y2)
    .attr("stroke", color).attr("stroke-width", 1)
    .attr("stroke-dasharray", "3 4").attr("opacity", 0.3);

  // Row hover / expand background
  lNodes.append("rect")
    .attr("x", ITEM_X - ITEM_R - 8).attr("y", rowY + 6)
    .attr("width", _svgW() - ITEM_X + ITEM_R + 8 - 20)
    .attr("height", h - 12)
    .attr("fill",   isExp ? `${color}12` : "transparent")
    .attr("stroke", isExp ? `${color}40` : "transparent")
    .attr("stroke-width", 0.8).attr("rx", 8)
    .style("cursor", "pointer")
    .on("click",     () => _cb.onItemExpand(item))
    .on("mouseover", function() { if (!isExp) d3.select(this).attr("fill", `${color}08`).attr("stroke", `${color}30`); })
    .on("mouseout",  function() { if (!isExp) d3.select(this).attr("fill", "transparent").attr("stroke", "transparent"); });

  // POItem node
  const itemG = lNodes.append("g")
    .attr("transform", `translate(${ITEM_X},${midY})`)
    .style("cursor", "pointer")
    .on("click",      () => _cb.onItemExpand(item))
    .on("mousemove",  ev => _cb.onTooltipShow(
      `<div class="tip-title">${item}</div>
       <div class="tip-row">Type: <b>POItem</b></div>
       <div class="tip-row">Events: <b>${evCount}</b></div>
       <div class="tip-row">Range: <b>${dateRange}</b></div>
       <div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">${isExp ? "▲ Click to collapse" : "▼ Click to expand timeline"}</div>`,
      ev.offsetX, ev.offsetY
    ))
    .on("mouseleave", _cb.onTooltipHide);

  // Outer pulse ring (expanded only)
  if (isExp) {
    itemG.append("circle")
      .attr("r", ITEM_R + 6)
      .attr("fill", `${color}0a`)
      .attr("stroke", `${color}25`)
      .attr("stroke-width", 1);
  }

  itemG.append("circle")
    .attr("r", ITEM_R)
    .attr("fill", `${color}1a`)
    .attr("stroke", color)
    .attr("stroke-width", isExp ? 2.5 : 1.5);

  itemG.append("text")
    .attr("text-anchor", "middle").attr("dy", "0.35em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "10px").attr("fill", color)
    .attr("pointer-events", "none")
    .text(isExp ? "−" : "+");

  // Labels
  if (!isExp) {
    // Collapsed: item suffix + summary on two lines
    lLabels.append("text")
      .attr("x", ITEM_X + ITEM_R + 12).attr("y", midY - 6)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "11px").attr("font-weight", "600")
      .attr("fill", color)
      .text(`Item ${_suffix(item)}`);
    lLabels.append("text")
      .attr("x", ITEM_X + ITEM_R + 12).attr("y", midY + 9)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "9px").attr("fill", "var(--text-dim)")
      .text(`${evCount} events · ${dateRange}`);
  } else {
    // Expanded: item ID above node
    lLabels.append("text")
      .attr("x", ITEM_X).attr("y", rowY + 13)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px").attr("fill", color).attr("opacity", 0.65)
      .text(`Item ${_suffix(item)}`);
  }

  // ── Expanded timeline ──────────────────────────────────────────────────────
  if (!isExp || timelineNodes.length === 0) return;

  const firstX = timelineNodes[0].x;
  const lastX  = timelineNodes.at(-1).x;

  // Timeline baseline
  lNodes.append("line")
    .attr("x1", firstX - 12).attr("y1", midY)
    .attr("x2", lastX  + 12).attr("y2", midY)
    .attr("stroke", color).attr("stroke-width", 0.5).attr("opacity", 0.18);

  // Dotted connector: POItem node → first event
  lNodes.append("line")
    .attr("x1", ITEM_X + ITEM_R + 4).attr("y1", midY)
    .attr("x2", firstX - EVENT_R - 3).attr("y2", midY)
    .attr("stroke", color).attr("stroke-width", 0.8)
    .attr("stroke-dasharray", "3 3").attr("opacity", 0.4);

  // DF item edges
  lDfItem.selectAll(null).data(dfItemEdges).join("path")
    .attr("class", "edge-dfitem")
    .attr("d", d => {
      if (d.type === "arc") {
        const r = 16;
        return `M${d.x1},${d.y1} C${d.x1+r},${d.y1-r} ${d.x2+r},${d.y2-r} ${d.x2},${d.y2}`;
      }
      return `M${d.x1},${d.y1} L${d.x2},${d.y2}`;
    })
    .attr("fill", "none").attr("stroke", d => d.color)
    .attr("stroke-width", 1.5).attr("marker-end", "url(#arr-dfitem)");

  // Event nodes
  const evG = lNodes.selectAll(null).data(timelineNodes).join("g")
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer");

  // Outer hover ring (invisible until hover — CSS handles this via filter)
  evG.append("circle")
    .attr("r", EVENT_R + 4)
    .attr("fill", "transparent").attr("stroke", "transparent")
    .attr("class", "ev-hover-ring");

  evG.append("circle")
    .attr("r", EVENT_R)
    .attr("fill", d => d.color).attr("fill-opacity", 0.88)
    .attr("stroke", "#f8fbff").attr("stroke-width", 1);

  evG
    .on("mousemove", function(ev, d) {
      // Highlight hover ring
      d3.select(this).select(".ev-hover-ring")
        .attr("stroke", d.color).attr("stroke-width", 1.5).attr("opacity", 0.4);
      const fmt = d.date?.toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      }) ?? "—";
      _cb.onTooltipShow(
        `<div class="tip-title">${d.activity}</div>
         <div class="tip-row">ID: <b>${d.id}</b></div>
         <div class="tip-row">Date: <b>${fmt}</b></div>
         <div class="tip-row">POItem: <b>${d.poitem_id}</b></div>
         ${d.org_resource ? `<div class="tip-row">Resource: <b>${d.org_resource}</b></div>` : ""}`,
        ev.offsetX, ev.offsetY
      );
    })
    .on("mouseleave", function() {
      d3.select(this).select(".ev-hover-ring")
        .attr("stroke", "transparent");
      _cb.onTooltipHide();
    });

  // Date labels below first and last event nodes
  [timelineNodes[0], timelineNodes.at(-1)].forEach((n, i) => {
    if (!n) return;
    const anchor = i === 0 ? "start" : "end";
    lLabels.append("text")
      .attr("x", n.x).attr("y", midY + EVENT_R + 13)
      .attr("text-anchor", anchor)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px").attr("fill", "var(--text-dim)")
      .text(n.date?.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) ?? "");
  });

  // Event count label at the right end of the timeline
  lLabels.append("text")
    .attr("x", lastX + EVENT_R + 10).attr("y", midY + 4)
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9px").attr("fill", color).attr("opacity", 0.5)
    .text(`${timelineNodes.length} ev`);
}

// ── Visibility ────────────────────────────────────────────────────────────────

function _applyVisibility() {
  if (!gRoot) return;
  gRoot.selectAll(".edge-dfpo")
    .attr("display", vis.dfPo  ? null : "none").attr("opacity", opa.dfPo);
  gRoot.selectAll(".edge-dfitem")
    .attr("display", vis.dfItem ? null : "none").attr("opacity", opa.dfItem);
  gRoot.selectAll(".edge-corr")
    .attr("display", vis.corr  ? null : "none").attr("opacity", opa.corr);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _svgW() { return svg?.node()?.clientWidth ?? 900; }

function _wheelDelta(event) {
  return -event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002);
}

function _contentBounds(totalHeight) {
  if (!gRoot?.node() || !svg?.node()) return null;
  try {
    const bbox = gRoot.node().getBBox();
    if (bbox.width > 0 && bbox.height > 0) {
      _lastContentBounds = bbox;
      return bbox;
    }
  } catch {
    // Ignore and fall back below.
  }

  const w = svg.node().clientWidth ?? 900;
  const h = totalHeight ?? svg.node().clientHeight ?? 600;
  const fallback = { x: 0, y: 0, width: Math.max(w - 24, 1), height: Math.max(h, 1) };
  _lastContentBounds = fallback;
  return fallback;
}

function _computeFitTransform(totalHeight) {
  const bounds = _contentBounds(totalHeight);
  if (!bounds || !svg?.node()) return null;

  const viewportW = svg.node().clientWidth;
  const viewportH = svg.node().clientHeight;
  const innerW = Math.max(viewportW - FIT_PAD_X * 2, 1);
  const innerH = Math.max(viewportH - FIT_PAD_Y * 2, 1);
  const fitScale = Math.min(
    FIT_MAX_SCALE,
    innerW / Math.max(bounds.width, 1),
    innerH / Math.max(bounds.height, 1),
  );
  const scale = fitScale < FIT_READABLE_MIN_SCALE && bounds.height > viewportH
    ? Math.min(FIT_READABLE_MIN_SCALE, innerW / Math.max(bounds.width, 1))
    : fitScale;

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const scaledHeight = bounds.height * scale;
  const tx = viewportW / 2 - centerX * scale;
  const ty = scaledHeight > innerH
    ? FIT_PAD_Y - bounds.y * scale
    : viewportH / 2 - centerY * scale;

  return d3.zoomIdentity
    .translate(tx, ty)
    .scale(scale);
}

function _applyTransform(transform, animate) {
  if (!svg || !zoom) return;
  if (animate) {
    svg.transition()
      .duration(CAMERA_EASE_MS)
      .ease(d3.easeCubicOut)
      .call(zoom.transform, transform);
    return;
  }
  svg.call(zoom.transform, transform);
}

function _updateTranslateExtent(totalHeight) {
  const bounds = _contentBounds(totalHeight);
  if (!bounds || !svg?.node() || !zoom) return;

  const padX = Math.max(bounds.width * 0.2, 120);
  const padY = Math.max(bounds.height * 0.2, 100);
  zoom.translateExtent([
    [bounds.x - padX, bounds.y - padY],
    [bounds.x + bounds.width + padX, bounds.y + bounds.height + padY],
  ]);
}

function _refreshMinimap() {
  if (!miniSvg || !miniRoot || !miniViewport || !gRoot?.node()) return;

  const bounds = _contentBounds(_lastTotalHeight);
  if (!bounds) return;

  const pad = MINIMAP_PAD;
  miniSvg.attr(
    "viewBox",
    `${bounds.x - pad} ${bounds.y - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`,
  );

  miniRoot.selectAll("*").remove();
  const clone = gRoot.node().cloneNode(true);
  clone.removeAttribute("transform");
  while (clone.firstChild) {
    miniRoot.node().appendChild(clone.firstChild);
  }

  _updateMinimapViewport();
}

function _updateMinimapViewport() {
  if (!miniViewport || !svg?.node() || !_lastContentBounds) return;

  const viewportW = svg.node().clientWidth;
  const viewportH = svg.node().clientHeight;
  const k = _currentTransform.k || 1;
  const x = -_currentTransform.x / k;
  const y = -_currentTransform.y / k;
  const w = viewportW / k;
  const h = viewportH / k;

  miniViewport
    .attr("x", x)
    .attr("y", y)
    .attr("width", w)
    .attr("height", h);
}

function _onMinimapClick(event) {
  if (!miniSvg?.node() || !svg?.node()) return;
  const viewBox = _getMinimapViewBox();
  if (!viewBox) return;

  const rect = miniSvg.node().getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const [px, py] = d3.pointer(event, miniSvg.node());
  const graphX = viewBox.x + (px / rect.width) * viewBox.width;
  const graphY = viewBox.y + (py / rect.height) * viewBox.height;
  _centerOn(graphX, graphY, { animate: true });
}

function _centerOn(graphX, graphY, options = {}) {
  if (!svg?.node()) return;
  const k = options.scale ?? _currentTransform.k ?? 1;
  const viewportW = svg.node().clientWidth;
  const viewportH = svg.node().clientHeight;
  const transform = d3.zoomIdentity
    .translate(viewportW / 2 - graphX * k, viewportH / 2 - graphY * k)
    .scale(k);
  _applyTransform(transform, options.animate ?? true);
}

function _getMinimapViewBox() {
  if (!miniSvg) return null;
  const raw = miniSvg.attr("viewBox");
  if (!raw) return null;
  const [x, y, width, height] = raw.split(/[\s,]+/).map(Number);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function _suffix(itemId) {
  const m = itemId.match(/_0*(\d+)$/);
  return m ? parseInt(m[1], 10) : itemId;
}

function _addMarkers(defs) {
  function mk(id, color, size = 5) {
    defs.append("marker")
      .attr("id", id).attr("viewBox", "0 -3 6 6")
      .attr("refX", size + 1).attr("refY", 0)
      .attr("markerWidth", size).attr("markerHeight", size)
      .attr("orient", "auto")
      .append("path").attr("d", "M0,-3L6,0L0,3").attr("fill", color);
  }
  mk("arr-dfitem", "rgba(34,48,71,0.42)");
  mk("arr-dfpo",   PO_COLOR);
  mk("arr-corr",   "rgba(34,48,71,0.22)", 4);
}
