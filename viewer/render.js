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
let _cb    = {};
let _graphs   = [];
let _expanded = new Set();
let _currentTransform = null;
let _lastTotalHeight = 0;
let _lastContentBounds = null;

const vis = { dfItem: true, dfPo: false, corr: false, resources: false, attributes: false };
const opa = { dfItem: 0.7, dfPo: 0.2, corr: 0.2 };
const FIT_PAD_X = 52;
const FIT_PAD_Y = 44;
const FIT_MAX_SCALE = 1.65;
const FIT_READABLE_MIN_SCALE = 0.28;
const CAMERA_EASE_MS = 420;
const COMMUNITY_PALETTE = [
  [37, 99, 235],
  [14, 116, 144],
  [5, 150, 105],
  [217, 119, 6],
  [220, 38, 38],
  [124, 58, 237],
  [8, 145, 178],
  [22, 163, 74],
];

// ── Init ──────────────────────────────────────────────────────────────────────

export function init(svgId, onTooltipShow, onTooltipHide, onItemExpand, onPoSelect, onCommunitySelect) {
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
    });
  svg.call(zoom);
  svg.on("dblclick.zoom", null);

  _cb = { onTooltipShow, onTooltipHide, onItemExpand, onPoSelect, onCommunitySelect };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function draw(graphs, expanded, options = {}) {
  if (!svg) throw new Error("Call init() first.");
  _graphs   = graphs;
  _expanded = expanded;

  const w      = svg.node().clientWidth;
  const layout = computeLayout(graphs, expanded, w);

  gRoot.selectAll("*").remove();

  // Painter layers: back → front
  const lBg     = gRoot.append("g").attr("class", "l-bg");
  const lMeta   = gRoot.append("g").attr("class", "l-meta");
  const lDfPo   = gRoot.append("g").attr("class", "l-dfpo");
  const lCorr   = gRoot.append("g").attr("class", "l-corr");
  const lRes    = gRoot.append("g").attr("class", "l-resources");
  const lDfItem = gRoot.append("g").attr("class", "l-dfitem");
  const lNodes  = gRoot.append("g").attr("class", "l-nodes");
  const lLabels = gRoot.append("g").attr("class", "l-labels");

  if (layout.overviewNetwork) {
    _drawOverviewNetwork(layout.network, lBg, lMeta, lNodes, lLabels);
  } else {
    layout.poBlocks.forEach(block =>
      _drawBlock(block, lBg, lDfPo, lCorr, lRes, lDfItem, lNodes, lLabels)
    );
  }

  _lastTotalHeight = layout.totalHeight;
  _applyVisibility();
  _updateTranslateExtent(layout.totalHeight);
  if (options.fit ?? true) {
    fitToView(layout.totalHeight, {
      animate: options.animate ?? true,
      minScale: options.minScale,
    });
  } else {
    gRoot.attr("transform", _currentTransform ?? d3.zoomIdentity);
  }
}

export function setVisibility(key, val) {
  vis[key] = val;
  _applyVisibility();
}

export function setOpacity(key, val) {
  opa[key] = val;
  _applyVisibility();
}

export function fitToView(totalHeight, options = {}) {
  if (!svg) return;
  const transform = _computeFitTransform(totalHeight, options.minScale);
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

function _drawOverviewNetwork(network, lBg, lMeta, lNodes, lLabels) {
  const focusedCommunityId = network.meta?.focusCommunityId ?? null;
  const isFocused = Boolean(focusedCommunityId);
  const clusterById = Object.fromEntries(network.clusters.map(cluster => [cluster.id, cluster]));

  network.clusters.forEach(cluster => {
    const color = _clusterColor(cluster.id);
    const shellRadius = isFocused ? cluster.radius + 18 : cluster.outerRadius + 4;
    const bubble = lBg.append("circle")
      .attr("cx", cluster.x)
      .attr("cy", cluster.y)
      .attr("r", shellRadius)
      .attr("fill", _clusterColor(cluster.id, isFocused ? 0.16 : 0.1))
      .attr("stroke", _clusterColor(cluster.id, isFocused ? 0.42 : 0.34))
      .attr("stroke-width", isFocused ? 1.8 : 1.5)
      .style("cursor", "pointer")
      .on("click", () => _cb.onCommunitySelect?.(cluster.id))
      .on("mousemove", ev => _cb.onTooltipShow(
        `<div class="tip-title">${cluster.label}</div>
         ${cluster.code ? `<div class="tip-row">Group: <b>${cluster.code}</b></div>` : ""}
         <div class="tip-row">Cases: <b>${cluster.count}</b></div>
         ${cluster.resources?.length ? `<div class="tip-row">Resources: <b>${cluster.resources.slice(0, 3).map(d => d.label).join(", ")}</b></div>` : ""}
         ${cluster.attributes?.length ? `<div class="tip-row">Attributes: <b>${cluster.attributes.slice(0, 2).map(d => d.label).join(", ")}</b></div>` : ""}
         <div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">Click to focus this community</div>`,
        ev.offsetX, ev.offsetY
      ))
      .on("mouseleave", _cb.onTooltipHide);

    lBg.append("circle")
      .attr("cx", cluster.x)
      .attr("cy", cluster.y)
      .attr("r", cluster.radius + 10)
      .attr("fill", _clusterColor(cluster.id, 0.07))
      .attr("stroke", _clusterColor(cluster.id, 0.24))
      .attr("stroke-width", 1.1);

    const labelY = cluster.y - (isFocused ? cluster.radius + 96 : cluster.outerRadius + 18);
    lLabels.append("text")
      .attr("x", cluster.x)
      .attr("y", labelY)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "11px")
      .attr("font-weight", "700")
      .attr("fill", color)
      .text(_ellipsis(cluster.label, 28));

    lLabels.append("text")
      .attr("x", cluster.x)
      .attr("y", labelY + 14)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px")
      .attr("fill", "rgba(12,29,50,0.72)")
      .text(`${cluster.count} cases${cluster.hint ? ` • ${cluster.hint}` : ""}`);

    lNodes.append("circle")
      .attr("cx", cluster.x)
      .attr("cy", cluster.y)
      .attr("r", Math.min(24, 11 + cluster.count * 0.9))
      .attr("fill", _clusterColor(cluster.id, 0.18))
      .attr("stroke", color)
      .attr("stroke-width", isFocused ? 2 : 2.4)
      .style("cursor", "pointer")
      .on("click", () => _cb.onCommunitySelect?.(cluster.id));

    if (isFocused) {
      const satellites = (cluster.satellites ?? []).filter(d =>
        (d.type === "resource" && vis.resources) || (d.type === "attribute" && vis.attributes)
      );

      lMeta.selectAll(null).data(satellites).join("line")
        .attr("x1", cluster.x)
        .attr("y1", cluster.y)
        .attr("x2", d => d.x)
        .attr("y2", d => d.y)
        .attr("stroke", d => d.type === "resource" ? "rgba(15,118,110,0.22)" : "rgba(217,119,6,0.22)")
        .attr("stroke-width", 0.9)
        .attr("stroke-dasharray", "2 4")
        .attr("class", d => d.type === "resource" ? "resource-satellite" : "attribute-satellite");

      const satelliteG = lNodes.selectAll(null).data(satellites).join("g")
        .attr("transform", d => `translate(${d.x},${d.y})`)
        .attr("class", d => d.type === "resource" ? "resource-satellite" : "attribute-satellite")
        .on("mousemove", function(ev, d) {
          _cb.onTooltipShow(
            `<div class="tip-title">${d.type === "resource" ? "Resource" : "Attribute"}</div>
             <div class="tip-row"><b>${d.label}</b></div>
             <div class="tip-row">Appears in <b>${d.count}</b> cases of this community</div>`,
            ev.offsetX, ev.offsetY
          );
        })
        .on("mouseleave", _cb.onTooltipHide);

      satelliteG.filter(d => d.type === "resource")
        .append("ellipse")
        .attr("rx", d => d.w / 2)
        .attr("ry", d => d.h / 2)
        .attr("fill", "rgba(15,118,110,0.12)")
        .attr("stroke", "rgba(15,118,110,0.56)")
        .attr("stroke-width", 1.1);

      satelliteG.filter(d => d.type === "attribute")
        .append("rect")
        .attr("x", d => -d.w / 2)
        .attr("y", d => -d.h / 2)
        .attr("width", d => d.w)
        .attr("height", d => d.h)
        .attr("rx", 7)
        .attr("fill", "rgba(217,119,6,0.12)")
        .attr("stroke", "rgba(217,119,6,0.56)")
        .attr("stroke-width", 1.1);

      satelliteG.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.34em")
        .attr("font-family", "JetBrains Mono, monospace")
        .attr("font-size", "7px")
        .attr("font-weight", "600")
        .attr("fill", d => d.type === "resource" ? "#0f766e" : "#b45309")
        .text(d => d.shortLabel ?? _ellipsis(d.label, 16));
    }
  });

  if (!isFocused) {
    lMeta.selectAll(null).data(network.communityEdges ?? []).join("path")
      .attr("class", "edge-overview")
      .attr("d", d => {
        const source = clusterById[d.source];
        const target = clusterById[d.target];
        if (!source || !target) return "";
        const mx = (source.x + target.x) / 2;
        const my = (source.y + target.y) / 2;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const curve = Math.min(80, Math.hypot(dx, dy) * 0.12);
        return `M${source.x},${source.y} Q${mx - dy / Math.max(Math.hypot(dx, dy), 1) * curve},${my + dx / Math.max(Math.hypot(dx, dy), 1) * curve} ${target.x},${target.y}`;
      })
      .attr("fill", "none")
      .attr("stroke", d => _clusterColor(d.source, Math.min(0.22 + d.weight * 0.08, 0.52)))
      .attr("stroke-width", d => Math.min(1.4 + d.weight * 2.1, 4))
      .on("mousemove", function(ev, d) {
        _cb.onTooltipShow(
          `<div class="tip-title">Community similarity</div>
           <div class="tip-row">Strength: <b>${Math.round(d.weight * 100)}%</b></div>
           <div class="tip-row">Supporting case links: <b>${d.count}</b></div>`,
          ev.offsetX, ev.offsetY
        );
      })
      .on("mouseleave", _cb.onTooltipHide);
    return;
  }

  lMeta.selectAll(null).data(network.edges).join("path")
    .attr("class", "edge-overview")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", d => `rgba(30,64,175,${Math.min(0.26 + d.weight * 0.1, 0.6)})`)
    .attr("stroke-width", d => Math.min(1.4 + d.weight * 3.2, 4.2))
    .on("mousemove", function(ev, d) {
      _cb.onTooltipShow(
        `<div class="tip-title">Case similarity</div>
         <div class="tip-row">Strength: <b>${Math.round(d.weight * 100)}%</b></div>
         ${d.reasons?.map(reason => `<div class="tip-row">${reason}</div>`).join("") ?? ""}`,
        ev.offsetX, ev.offsetY
      );
    })
    .on("mouseleave", _cb.onTooltipHide);

  const poG = lNodes.selectAll(null).data(network.nodes).join("g")
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer")
    .on("click", (_, d) => _cb.onPoSelect?.(d.id))
    .on("mousemove", function(ev, d) {
      const dateRange = d.firstDate && d.lastDate
        ? `${d.firstDate.toLocaleDateString("en-GB")} -> ${d.lastDate.toLocaleDateString("en-GB")}`
        : "n/a";
      _cb.onTooltipShow(
        `<div class="tip-title">PO ${d.id}</div>
         <div class="tip-row">Community: <b>${d.clusterLabel}</b></div>
         ${d.clusterCode ? `<div class="tip-row">Group: <b>${d.clusterCode}</b></div>` : ""}
         <div class="tip-row">Events: <b>${d.filteredEvents} / ${d.totalEvents}</b></div>
         <div class="tip-row">Items: <b>${d.filteredItems} / ${d.totalItems}</b></div>
         <div class="tip-row">Linked POs: <b>${d.degree}</b></div>
         <div class="tip-row">Range: <b>${dateRange}</b></div>
         ${d.topActivities?.length ? `<div class="tip-row">Top activities: <b>${_activitySummary(d.topActivities)}</b></div>` : ""}
         ${d.topResources?.length ? `<div class="tip-row">Top resources: <b>${d.topResources.join(", ")}</b></div>` : ""}
         ${_tooltipRows(d.displayAttrs, d.attrKeys ?? [])}
         <div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">Click to open detailed layout</div>`,
        ev.offsetX, ev.offsetY
      );
    })
    .on("mouseleave", _cb.onTooltipHide);

  poG.append("circle")
    .attr("r", d => d.r + 4)
    .attr("fill", d => _clusterColor(d.clusterKey, 0.1))
    .attr("stroke", "none");

  poG.append("circle")
    .attr("r", d => d.r)
    .attr("fill", d => _clusterColor(d.clusterKey, 0.16))
    .attr("stroke", d => _clusterColor(d.clusterKey))
    .attr("stroke-width", d => d.degree > 0 ? 2.2 : 1.3);

  poG.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "-0.1em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "8px")
    .attr("font-weight", "700")
    .attr("fill", d => _clusterColor(d.clusterKey))
    .text(d => _poSuffix(d.id));

  poG.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "1.0em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "7px")
    .attr("fill", "var(--text-dim)")
    .text(d => `${d.filteredEvents}e`);
}

function _drawBlock(block, lBg, lDfPo, lCorr, lRes, lDfItem, lNodes, lLabels) {
  const { po, poMidY, startY, totalHeight, itemRows, dfPoEdges, poAttrs, isOverview, contentMaxX } = block;
  const W = _svgW();
  const blockRightX = Math.max(W - 12, (contentMaxX ?? 0) + 24);

  // Block background card
  const blockCard = lBg.append("rect")
    .attr("x", 12).attr("y", startY + 4)
    .attr("width", blockRightX - 12).attr("height", totalHeight - 8)
    .attr("fill", "rgba(37,99,235,0.04)")
    .attr("stroke", "rgba(37,99,235,0.14)")
    .attr("stroke-width", 1).attr("rx", 10);

  if (isOverview) {
    blockCard
      .style("cursor", "pointer")
      .on("click", () => _cb.onPoSelect?.(po));
  } else {
    // Vertical guide line from PO down through all item rows
    lBg.append("line")
      .attr("x1", ITEM_X).attr("y1", startY + 24)
      .attr("x2", ITEM_X).attr("y2", startY + totalHeight - 16)
      .attr("stroke", "rgba(34,48,71,0.12)")
      .attr("stroke-width", 1);
  }

  // PO node
  const poG = lNodes.append("g")
    .attr("transform", `translate(${PO_X},${poMidY})`)
    .style("cursor", "pointer");

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
       <div class="tip-row">Items: <b>${block.meta?.totalItems ?? block.items.length}</b></div>
       <div class="tip-row">Total events: <b>${block.meta?.totalEvents ?? "—"}</b></div>
       ${isOverview ? `<div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">Click to focus this PO</div>` : ""}
       ${_tooltipRows(poAttrs, ["Vendor", "Company", "Document_Type", "Source"])}`,
      ev.offsetX, ev.offsetY
    )
  ).on("mouseleave", _cb.onTooltipHide)
    .on("click", () => _cb.onPoSelect?.(po));

  if (isOverview) {
    _drawOverviewBlock(block, lBg, lCorr, lNodes, lLabels);
    return;
  }

  // PO-level DF arcs
  lDfPo.selectAll(null).data(dfPoEdges).join("path")
    .attr("class", "edge-dfpo")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none").attr("stroke", PO_COLOR)
    .attr("stroke-width", 1.2).attr("stroke-dasharray", "5 3")
    .attr("marker-end", "url(#arr-dfpo)");

  // Draw each item row
  itemRows.forEach(row => _drawItemRow(row, lBg, lCorr, lRes, lDfItem, lNodes, lLabels));
}

// ── Draw one POItem row ───────────────────────────────────────────────────────

function _drawOverviewBlock(block, lBg, lCorr, lNodes, lLabels) {
  const { po, poMidY, overview } = block;
  const {
    corrEdge,
    summaryNode,
    timeline,
    firstDate,
    lastDate,
    dateRange,
    previewItems,
    hiddenItemCount,
    shownItems,
    totalItems,
    filteredEvents,
    totalEvents,
  } = overview;

  lCorr.append("line").attr("class", "edge-corr")
    .attr("x1", corrEdge.x1).attr("y1", corrEdge.y1)
    .attr("x2", corrEdge.x2).attr("y2", corrEdge.y2)
    .attr("stroke", PO_COLOR).attr("stroke-width", 1)
    .attr("stroke-dasharray", "3 4").attr("opacity", 0.22);

  lNodes.append("rect")
    .attr("x", ITEM_X - ITEM_R - 8).attr("y", poMidY - 24)
    .attr("width", _svgW() - ITEM_X + ITEM_R - 12)
    .attr("height", 48)
    .attr("fill", "rgba(37,99,235,0.03)")
    .attr("stroke", "rgba(37,99,235,0.10)")
    .attr("stroke-width", 0.8).attr("rx", 12)
    .style("cursor", "pointer")
    .on("click", () => _cb.onPoSelect?.(po));

  const summaryG = lNodes.append("g")
    .attr("transform", `translate(${summaryNode.x},${summaryNode.y})`)
    .style("cursor", "pointer")
    .on("click", () => _cb.onPoSelect?.(po))
    .on("mousemove", ev =>
      _cb.onTooltipShow(
        `<div class="tip-title">Overview cluster</div>
         <div class="tip-row">Visible items: <b>${shownItems}</b></div>
         <div class="tip-row">Total items: <b>${totalItems}</b></div>
         <div class="tip-row">Visible events: <b>${filteredEvents}</b></div>
         <div class="tip-row">Date span: <b>${dateRange}</b></div>
         <div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">Click to open detailed layout</div>`,
        ev.offsetX, ev.offsetY
      )
    )
    .on("mouseleave", _cb.onTooltipHide);

  summaryG.append("circle")
    .attr("r", summaryNode.r + 5)
    .attr("fill", "rgba(37,99,235,0.08)")
    .attr("stroke", "none");

  summaryG.append("circle")
    .attr("r", summaryNode.r)
    .attr("fill", "rgba(37,99,235,0.12)")
    .attr("stroke", PO_COLOR)
    .attr("stroke-width", 1.6);

  summaryG.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "12px")
    .attr("font-weight", "700")
    .attr("fill", PO_COLOR)
    .text("S");

  lBg.append("rect")
    .attr("x", timeline.x1 - 18).attr("y", timeline.y - 16)
    .attr("width", Math.max(timeline.x2 - timeline.x1 + 36, 56))
    .attr("height", 32)
    .attr("rx", 16)
    .attr("fill", "rgba(255,255,255,0.50)")
    .attr("stroke", "rgba(37,99,235,0.10)")
    .attr("stroke-width", 0.8);

  lNodes.append("line")
    .attr("x1", summaryNode.x + summaryNode.r + 12).attr("y1", timeline.y)
    .attr("x2", timeline.x2).attr("y2", timeline.y)
    .attr("stroke", PO_COLOR).attr("stroke-width", 1.1).attr("opacity", 0.16);

  lLabels.append("text")
    .attr("x", ITEM_X + ITEM_R + 14).attr("y", poMidY - 7)
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "11px").attr("font-weight", "600")
    .attr("fill", PO_COLOR)
    .text(`${shownItems} / ${totalItems} items`);

  lLabels.append("text")
    .attr("x", ITEM_X + ITEM_R + 14).attr("y", poMidY + 10)
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9px").attr("fill", "var(--text-dim)")
    .text(`${filteredEvents} / ${totalEvents} ev · ${dateRange}`);

  const previewChips = previewItems.slice(0, 4).map(label => ({
    label: "Item",
    value: label.replace(/^Item\s+/, ""),
    maxChars: 8,
    fill: "rgba(37,99,235,0.08)",
    stroke: "rgba(37,99,235,0.14)",
    textColor: "#243449",
  }));
  if (hiddenItemCount > 0) {
    previewChips.push({
      label: "+",
      value: `${hiddenItemCount} more`,
      maxChars: 12,
      fill: "rgba(21,154,103,0.10)",
      stroke: "rgba(21,154,103,0.20)",
      textColor: "#0f766e",
    });
  }
  _drawChipList(lLabels, previewChips, ITEM_X + ITEM_R + 14, poMidY + 16);

  [firstDate, lastDate].forEach((d, i) => {
    if (!d) return;
    const x = i === 0 ? timeline.x1 : timeline.x2;
    const anchor = i === 0 ? "start" : "end";
    lLabels.append("text")
      .attr("x", x).attr("y", timeline.y + 18)
      .attr("text-anchor", anchor)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px").attr("fill", "var(--text-dim)")
      .text(d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
  });
}

function _drawItemRow(row, lBg, lCorr, lRes, lDfItem, lNodes, lLabels) {
  const { item, midY, rowY, h, color, isExp, corrEdge,
          timelineNodes, dfItemEdges, resourceNodes, resourceLinks,
          itemAttrs, evCount, dateRange, laneX2 } = row;

  // CORR dash: POItem → PO node
  lCorr.append("line").attr("class", "edge-corr")
    .attr("x1", corrEdge.x1).attr("y1", corrEdge.y1)
    .attr("x2", corrEdge.x2).attr("y2", corrEdge.y2)
    .attr("stroke", color).attr("stroke-width", 1)
    .attr("stroke-dasharray", "3 4").attr("opacity", 0.3);

  // Row hover / expand background
  const laneX1 = ITEM_X - ITEM_R - 8;
  const laneRightX = Math.max(_svgW() - 12, (laneX2 ?? ITEM_X + ITEM_R + 180) + 18);
  lNodes.append("rect")
    .attr("x", laneX1).attr("y", rowY + 6)
    .attr("width", laneRightX - laneX1)
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
       ${_tooltipRows(itemAttrs, ["Item_Type", "Item_Category", "Goods_Receipt", "GR_Based_Inv_Verif"])}
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
    // Expanded: keep the annotation band compact and away from the timeline.
    lLabels.append("text")
      .attr("x", ITEM_X).attr("y", rowY + 13)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px").attr("fill", color).attr("opacity", 0.65)
      .text(`Item ${_suffix(item)}`);
    lLabels.append("text")
      .attr("x", ITEM_X + ITEM_R + 14).attr("y", rowY + 18)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "9px").attr("fill", "var(--text-dim)")
      .text(`${evCount} ev • ${dateRange}`);
    _drawChipList(
      lLabels,
      _buildChips(itemAttrs, [
        ["Item_Type", "Type"],
        ["Goods_Receipt", "GR"],
      ]),
      ITEM_X + ITEM_R + 14,
      rowY + 24,
    );
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

  lBg.append("rect")
    .attr("x", firstX - 20).attr("y", midY - 18)
    .attr("width", Math.max(lastX - firstX + 40, 56))
    .attr("height", 36)
    .attr("rx", 18)
    .attr("fill", "rgba(255,255,255,0.52)")
    .attr("stroke", `${color}18`)
    .attr("stroke-width", 0.8);

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

  _drawResourceOverlay(lRes, row);

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
    .attr("fill", d => d.activityColor ?? d.color).attr("fill-opacity", 0.9)
    .attr("stroke", d => d.resourceColor ?? "#f8fbff").attr("stroke-width", 1.6);

  evG
    .on("mousemove", function(ev, d) {
      // Highlight hover ring
      d3.select(this).select(".ev-hover-ring")
        .attr("stroke", d.activityColor ?? d.color).attr("stroke-width", 1.5).attr("opacity", 0.45);
      const fmt = d.date?.toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      }) ?? "—";
      _cb.onTooltipShow(
        `<div class="tip-title">${d.activity}</div>
         <div class="tip-row">ID: <b>${d.id}</b></div>
         <div class="tip-row">Date: <b>${fmt}</b></div>
         <div class="tip-row">POItem: <b>${d.poitem_id}</b></div>
         ${_hasResourceValue(d.org_resource) ? `<div class="tip-row">Resource: <b>${d.org_resource}</b></div>` : ""}
         ${d.lifecycle_transition ? `<div class="tip-row">Lifecycle: <b>${d.lifecycle_transition}</b></div>` : ""}
         ${_tooltipRows(d, ["Document_Type", "Source", "Vendor", "Company"])}`,
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

function _drawResourceOverlay(layer, row) {
  const { resourceNodes, resourceLinks } = row;
  if (!resourceNodes?.length) return;

  const g = layer.append("g").attr("class", "resource-overlay");

  g.selectAll(null).data(resourceLinks).join("line")
    .attr("class", "resource-link")
    .attr("x1", d => d.x1).attr("y1", d => d.y1)
    .attr("x2", d => d.x2).attr("y2", d => d.y2)
    .attr("stroke", d => d.color)
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "2 3")
    .attr("opacity", 0.28);

  const nodes = g.selectAll(null).data(resourceNodes).join("g")
    .attr("class", "resource-node")
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer");

  nodes.append("circle")
    .attr("r", 8)
    .attr("fill", "#ffffff")
    .attr("stroke", d => d.color)
    .attr("stroke-width", 1.5);

  nodes.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.34em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "7px")
    .attr("font-weight", "700")
    .attr("fill", d => d.color)
    .text(d => d.count);

  nodes
    .on("mousemove", function(ev, d) {
      _cb.onTooltipShow(
        `<div class="tip-title">${d.label}</div>
         <div class="tip-row">Resource-linked events: <b>${d.count}</b></div>`,
        ev.offsetX, ev.offsetY
      );
    })
    .on("mouseleave", _cb.onTooltipHide);
}

function _applyVisibility() {
  if (!gRoot) return;
  gRoot.selectAll(".edge-dfpo")
    .attr("display", vis.dfPo  ? null : "none").attr("opacity", opa.dfPo);
  gRoot.selectAll(".edge-dfitem")
    .attr("display", vis.dfItem ? null : "none").attr("opacity", opa.dfItem);
  gRoot.selectAll(".edge-corr")
    .attr("display", vis.corr  ? null : "none").attr("opacity", opa.corr);
  gRoot.selectAll(".resource-overlay")
    .attr("display", vis.resources ? null : "none");
  gRoot.selectAll(".resource-satellite")
    .attr("display", vis.resources ? null : "none");
  gRoot.selectAll(".attribute-satellite")
    .attr("display", vis.attributes ? null : "none");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _drawChipList(layer, chips, x, y) {
  if (!chips?.length) return;
  const g = layer.append("g").attr("transform", `translate(${x},${y})`);
  let cursor = 0;

  chips.forEach(chip => {
    const text = `${chip.label}: ${_ellipsis(chip.value, chip.maxChars ?? 18)}`;
    const chipG = g.append("g").attr("transform", `translate(${cursor},0)`);
    const textEl = chipG.append("text")
      .attr("x", 8).attr("y", 10)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px")
      .attr("fill", chip.textColor ?? "#243449")
      .text(text);
    const width = Math.ceil(textEl.node()?.getComputedTextLength?.() ?? (text.length * 5.2)) + 16;

    chipG.insert("rect", "text")
      .attr("width", width).attr("height", 14)
      .attr("rx", 7)
      .attr("fill", chip.fill ?? "rgba(37,99,235,0.08)")
      .attr("stroke", chip.stroke ?? "rgba(37,99,235,0.14)");

    cursor += width + 6;
  });
}

function _buildChips(attrs, pairs) {
  return pairs
    .filter(([key]) => attrs?.[key] !== undefined && attrs[key] !== "")
    .map(([key, label]) => {
      const value = _formatAttrValue(key, attrs[key]);
      const isBool = value === "Yes" || value === "No";
      return {
        label,
        value,
        maxChars: key === "Item_Category" ? 22 : 16,
        fill: isBool ? (value === "Yes" ? "rgba(21,154,103,0.12)" : "rgba(220,38,38,0.10)") : "rgba(37,99,235,0.08)",
        stroke: isBool ? (value === "Yes" ? "rgba(21,154,103,0.24)" : "rgba(220,38,38,0.18)") : "rgba(37,99,235,0.14)",
        textColor: isBool ? (value === "Yes" ? "#0f766e" : "#b91c1c") : "#243449",
      };
    });
}

function _tooltipRows(obj, keys) {
  return keys
    .filter(key => obj?.[key] !== undefined && obj[key] !== null && obj[key] !== "")
    .map(key => `<div class="tip-row">${_labelize(key)}: <b>${_formatAttrValue(key, obj[key])}</b></div>`)
    .join("");
}

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

function _computeFitTransform(totalHeight, minScale = FIT_READABLE_MIN_SCALE) {
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
  const scale = fitScale < minScale && bounds.height > viewportH
    ? Math.min(minScale, innerW / Math.max(bounds.width, 1))
    : fitScale;

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const tx = viewportW / 2 - centerX * scale;
  const ty = viewportH / 2 - centerY * scale;

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

  const viewportW = svg.node().clientWidth;
  const viewportH = svg.node().clientHeight;
  const padX = Math.max(bounds.width * 0.9, viewportW * 1.1, 640);
  const padY = Math.max(bounds.height * 0.9, viewportH * 1.1, 520);
  zoom.translateExtent([
    [bounds.x - padX, bounds.y - padY],
    [bounds.x + bounds.width + padX, bounds.y + bounds.height + padY],
  ]);
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

function _suffix(itemId) {
  const m = itemId.match(/_0*(\d+)$/);
  return m ? parseInt(m[1], 10) : itemId;
}

function _poSuffix(poId) {
  return String(poId ?? "").slice(-4);
}

function _activitySummary(entries) {
  return (entries ?? [])
    .map(entry => `${_ellipsis(entry.activity, 16)} (${entry.count})`)
    .join(", ");
}

function _hasResourceValue(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim();
  return normalized !== "" && normalized.toUpperCase() !== "NONE";
}

function _clusterColor(value, alpha = 1) {
  let hash = 0;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  const [r, g, b] = COMMUNITY_PALETTE[Math.abs(hash) % COMMUNITY_PALETTE.length];
  return `rgba(${r},${g},${b},${alpha})`;
}

function _ellipsis(value, maxChars) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function _labelize(key) {
  return key.replaceAll("_", " ");
}

function _formatAttrValue(key, value) {
  if (value === "True") return "Yes";
  if (value === "False") return "No";
  return key === "Document_Type" ? _ellipsis(value, 20) : value;
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
