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
let _selection = null;

const vis = { dfItem: true, dfPo: false, corr: false, resources: false, attributes: false, sync: true, bottleneck: true };
const opa = { dfItem: 0.7, dfPo: 0.2, corr: 0.2 };
const FIT_PAD_X = 52;
const FIT_PAD_Y = 44;
const FIT_MAX_SCALE = 1.65;
const FIT_READABLE_MIN_SCALE = 0.28;
const ZOOM_MIN_SCALE = 0.05;
const ZOOM_MAX_SCALE = 6;
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

export function init(svgId, onTooltipShow, onTooltipHide, onItemExpand, onPoSelect, onVariantSelect) {
  svg   = d3.select(`#${svgId}`);
  gRoot = svg.append("g").attr("class", "root");
  _currentTransform = d3.zoomIdentity;
  _addMarkers(svg.append("defs"));
  zoom = d3.zoom()
    .scaleExtent([ZOOM_MIN_SCALE, ZOOM_MAX_SCALE])
    .wheelDelta(_wheelDelta)
    .on("zoom", e => {
      _currentTransform = e.transform;
      gRoot.attr("transform", _currentTransform);
    });
  svg.call(zoom);
  svg.on("dblclick.zoom", null);
  svg.on("click.selection-clear", event => {
    if (event.target === svg.node()) _clearSelection();
  });

  _cb = { onTooltipShow, onTooltipHide, onItemExpand, onPoSelect, onVariantSelect };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function draw(graphs, expanded, options = {}) {
  if (!svg) throw new Error("Call init() first.");
  _graphs   = graphs;
  _expanded = expanded;

  const w      = svg.node().clientWidth;
  const isVariantOverview = graphs.length === 1 && graphs[0]?.isVariantOverview;
  const layout = computeLayout(
    graphs,
    expanded,
    w,
    isVariantOverview
      ? {
          ...(options.layoutFilters ?? {}),
          activityColorByName: options.activityColorByName,
          viewportHeight: svg.node().clientHeight,
        }
      : (options.layoutFilters ?? {}),
  );

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

  if (layout.isVariantOverview) {
    _drawVariantOverview(
      layout.variantOverview.variantLayout,
      layout.variantOverview.dfLayout,
      layout.variantOverview.variantData,
      lBg,
      lNodes,
      lLabels,
    );
  } else {
    layout.poBlocks.forEach(block =>
      _drawBlock(block, lBg, lDfPo, lCorr, lRes, lDfItem, lNodes, lLabels)
    );
  }

  _lastTotalHeight = layout.totalHeight;
  _applyVisibility();
  _applySelectionState();
  _updateTranslateExtent(layout.totalHeight);
  if (options.fit ?? true) {
    fitToView(layout.totalHeight, {
      animate: options.animate ?? true,
      minScale: options.minScale,
      ...(options.fitOptions ?? {}),
    });
  } else {
    gRoot.attr("transform", _currentTransform ?? d3.zoomIdentity);
  }
  return layout;
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
  const transform = _computeFitTransform(totalHeight, options);
  if (!transform) return;
  _setZoomScaleExtent(options.lockMinScale ? transform.k : ZOOM_MIN_SCALE);
  _applyTransform(transform, options.animate ?? true);
}

export function resetZoom(options = {}) {
  if (!svg || !zoom) return;
  _applyTransform(d3.zoomIdentity, options.animate ?? true);
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

function _drawVariantOverview(variantLayout, dfLayout, variantData, lBg, lNodes, lLabels) {
  const rows = variantLayout?.rows ?? [];
  const summaryX = variantLayout?.summaryX ?? ((variantLayout?.rowX ?? 56) + (variantLayout?.rowWidth ?? 320));

  lLabels.append("text")
    .attr("x", variantLayout?.headerX ?? 56)
    .attr("y", (variantLayout?.headerY ?? 40) + 6)
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "10px")
    .attr("font-weight", "700")
    .attr("letter-spacing", "0.12em")
    .attr("fill", "var(--text-dim)")
    .text("PROCESS VARIANTS");

  lLabels.append("text")
    .attr("x", variantLayout?.headerX ?? 56)
    .attr("y", (variantLayout?.headerY ?? 40) + 24)
    .attr("font-family", "Syne, sans-serif")
    .attr("font-size", "18px")
    .attr("font-weight", "500")
    .attr("fill", "var(--text)")
    .text("Process Variants");

  lLabels.append("text")
    .attr("x", summaryX)
    .attr("y", (variantLayout?.headerY ?? 40) + 24)
    .attr("text-anchor", "end")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "10px")
    .attr("fill", "var(--text-dim)")
    .text(`${variantData?.totalInstances ?? 0} instances  •  ${variantData?.variantCount ?? 0} variants`);

  if (!rows.length) {
    lLabels.append("text")
      .attr("x", variantLayout?.rowX ?? 56)
      .attr("y", (variantLayout?.totalHeight ?? 88) - 8)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "10px")
      .attr("fill", "var(--text-dim)")
      .text("No variants match the current activity filter.");
  } else {
    rows.forEach((row, index) => {
      const bgRect = lBg.append("rect")
        .attr("x", row.x)
        .attr("y", row.y)
        .attr("width", row.w)
        .attr("height", row.h)
        .attr("rx", 12)
        .attr("fill", row.variant?.isdominant ? "rgba(79,142,247,0.10)" : "rgba(255,255,255,0.02)")
        .attr("stroke", row.variant?.isdominant ? "rgba(79,142,247,0.28)" : "rgba(79,142,247,0.08)")
        .attr("stroke-width", row.variant?.isdominant ? 1.2 : 1)
        .style("cursor", "pointer");

      const connectorStroke = row.variant?.isdominant ? "rgba(79,142,247,0.30)" : "rgba(79,142,247,0.18)";
      row.chips.slice(0, -1).forEach((chip, chipIndex) => {
        const nextChip = row.chips[chipIndex + 1];
        lBg.append("line")
          .attr("x1", chip.x + chip.w)
          .attr("y1", chip.y + chip.h / 2)
          .attr("x2", nextChip.x)
          .attr("y2", nextChip.y + nextChip.h / 2)
          .attr("stroke", connectorStroke)
          .attr("stroke-width", row.variant?.isdominant ? 1.5 : 1)
          .attr("stroke-linecap", "round");
      });

      const rowG = lNodes.append("g")
        .attr("class", "variant-row")
        .style("cursor", "pointer");

      const setHover = active => {
        bgRect
          .attr("fill", active
            ? (row.variant?.isdominant ? "rgba(79,142,247,0.13)" : "rgba(79,142,247,0.06)")
            : (row.variant?.isdominant ? "rgba(79,142,247,0.10)" : "rgba(255,255,255,0.02)"))
          .attr("stroke", active
            ? "rgba(79,142,247,0.36)"
            : (row.variant?.isdominant ? "rgba(79,142,247,0.28)" : "rgba(79,142,247,0.08)"));
      };
      const clickVariant = () => _cb.onVariantSelect?.(row.variant?.instanceIds ?? []);
      const moveVariant = ev => {
        const sequencePreview = (row.variant?.sequence ?? []).join(" → ");
        _cb.onTooltipShow(
          `<div class="tip-title">Variant ${index + 1}</div>
           <div class="tip-row">Instances: <b>${row.variant?.count ?? 0}</b></div>
           <div class="tip-row">Share: <b>${_formatPercent(row.variant?.frequency ?? 0)}</b></div>
           <div class="tip-row">Sequence: <b>${sequencePreview || "n/a"}</b></div>
           <div class="tip-row" style="margin-top:5px;color:var(--col-po);font-size:10px">Click to focus instances of this variant</div>`,
          ev.offsetX, ev.offsetY
        );
      };

      [bgRect, rowG].forEach(target => {
        target
          .on("mouseenter", () => setHover(true))
          .on("mouseleave", () => {
            setHover(false);
            _cb.onTooltipHide();
          })
          .on("mousemove", moveVariant)
          .on("click", clickVariant);
      });

      rowG.append("rect")
        .attr("x", row.badgeRectX)
        .attr("y", row.badgeRectY)
        .attr("width", row.badgeW)
        .attr("height", row.badgeH)
        .attr("rx", row.badgeH / 2)
        .attr("fill", row.variant?.isdominant ? "rgba(79,142,247,0.18)" : "rgba(255,255,255,0.05)")
        .attr("stroke", row.variant?.isdominant ? "rgba(79,142,247,0.34)" : "rgba(79,142,247,0.12)")
        .attr("stroke-width", 1);

      rowG.append("text")
        .attr("x", row.badgeX)
        .attr("y", row.badgeY + 4)
        .attr("text-anchor", "middle")
        .attr("font-family", "JetBrains Mono, monospace")
        .attr("font-size", "11px")
        .attr("font-weight", "700")
        .attr("fill", "var(--text)")
        .text(row.variant?.count ?? 0);

      if (row.variant?.isdominant) {
        rowG.append("text")
          .attr("x", Math.max(row.x + 6, row.badgeRectX - 12))
          .attr("y", row.badgeY + 4)
          .attr("font-family", "JetBrains Mono, monospace")
          .attr("font-size", "13px")
          .attr("fill", "#d4a73c")
          .text("★");
      }

      const chipG = rowG.selectAll(null).data(row.chips).join("g")
        .attr("transform", d => `translate(${d.x},${d.y})`);

      chipG.append("rect")
        .attr("width", d => d.w)
        .attr("height", d => d.h)
        .attr("rx", d => d.h / 2)
        .attr("fill", d => _rgba(d.color, row.variant?.isdominant ? 0.28 : 0.2))
        .attr("stroke", d => _rgba(d.color, row.variant?.isdominant ? 0.72 : 0.44))
        .attr("stroke-width", 1.1);

      chipG.append("text")
        .attr("x", d => d.w / 2)
        .attr("y", d => d.h / 2 + 3)
        .attr("text-anchor", "middle")
        .attr("font-family", "JetBrains Mono, monospace")
        .attr("font-size", d => Math.max(8, Math.min(10, d.h * 0.36)))
        .attr("font-weight", "600")
        .attr("fill", "var(--text)")
        .text(d => _ellipsis(d.activity, Math.max(10, Math.floor((d.w - 18) / 6.4))));

      rowG.append("text")
        .attr("x", row.percentX)
        .attr("y", row.percentY + 4)
        .attr("text-anchor", "end")
        .attr("font-family", "JetBrains Mono, monospace")
        .attr("font-size", "10px")
        .attr("fill", row.variant?.isdominant ? "var(--col-po)" : "var(--text-dim)")
        .text(_formatPercent(row.variant?.frequency ?? 0));
    });
  }

  lLabels.append("text")
    .attr("x", dfLayout?.x ?? 56)
    .attr("y", (dfLayout?.y ?? ((variantLayout?.totalHeight ?? 0) + 34)) - 10)
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "10px")
    .attr("font-weight", "700")
    .attr("letter-spacing", "0.12em")
    .attr("fill", "var(--text-dim)")
    .text("ACTIVITY FLOW");

  lBg.append("rect")
    .attr("x", dfLayout?.x ?? 56)
    .attr("y", dfLayout?.y ?? ((variantLayout?.totalHeight ?? 0) + 34))
    .attr("width", dfLayout?.width ?? 240)
    .attr("height", dfLayout?.height ?? 200)
    .attr("rx", 16)
    .attr("fill", "rgba(14,17,24,0.72)")
    .attr("stroke", "rgba(79,142,247,0.10)")
    .attr("stroke-width", 1);

  const maxEdgeCount = Math.max(...(dfLayout?.edges ?? []).map(edge => edge.count), 1);
  lBg.selectAll(null).data(dfLayout?.edges ?? []).join("path")
    .attr("class", "variant-dfg-edge")
    .attr("d", d => `M${d.x1},${d.y1} Q${d.cx},${d.cy} ${d.x2},${d.y2}`)
    .attr("fill", "none")
    .attr("stroke", "rgba(79,142,247,0.28)")
    .attr("stroke-width", d => 1 + (d.count / maxEdgeCount) * 4)
    .attr("stroke-linecap", "round")
    .on("mousemove", (ev, d) => _cb.onTooltipShow(
      `<div class="tip-title">Activity Flow</div>
       <div class="tip-row">Transition: <b>${d.source} → ${d.target}</b></div>
       <div class="tip-row">Count: <b>${d.count}</b></div>`,
      ev.offsetX, ev.offsetY
    ))
    .on("mouseleave", _cb.onTooltipHide);

  const maxNodeCount = Math.max(...(dfLayout?.nodes ?? []).map(node => node.count), 1);
  const nodeG = lNodes.selectAll(null).data(dfLayout?.nodes ?? []).join("g")
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "default")
    .on("mousemove", (ev, d) => _cb.onTooltipShow(
      `<div class="tip-title">${d.label}</div>
       <div class="tip-row">Occurrences: <b>${d.count}</b></div>`,
      ev.offsetX, ev.offsetY
    ))
    .on("mouseleave", _cb.onTooltipHide);

  nodeG.append("circle")
    .attr("r", d => 8 + (d.count / maxNodeCount) * 10)
    .attr("fill", "rgba(79,142,247,0.18)")
    .attr("stroke", "rgba(79,142,247,0.48)")
    .attr("stroke-width", 1.4);

  nodeG.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.34em")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "8px")
    .attr("font-weight", "700")
    .attr("fill", "var(--text)")
    .text(d => Math.round(d.count));

  lLabels.selectAll(null).data(dfLayout?.nodes ?? []).join("text")
    .attr("x", d => d.x)
    .attr("y", d => d.y + 24)
    .attr("text-anchor", "middle")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "8px")
    .attr("fill", "var(--text-dim)")
    .text(d => _ellipsis(d.label, 16));
}

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
          itemAttrs, evCount, dateRange, laneX2, followsDominant, syncEventCount, showSyncOnly } = row;
  const laneFill = followsDominant
    ? (isExp ? `${color}12` : "transparent")
    : (isExp ? "rgba(217,119,6,0.10)" : "rgba(217,119,6,0.04)");
  const laneStroke = followsDominant
    ? (isExp ? `${color}40` : "transparent")
    : (isExp ? "rgba(217,119,6,0.24)" : "rgba(217,119,6,0.16)");
  const laneHoverFill = followsDominant ? `${color}08` : "rgba(217,119,6,0.08)";
  const laneHoverStroke = followsDominant ? `${color}30` : "rgba(217,119,6,0.22)";
  const laneLabel = `Item ${_suffix(item)}${followsDominant ? "" : " ⚠"}`;

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
    .attr("fill", laneFill)
    .attr("stroke", laneStroke)
    .attr("stroke-width", 0.8).attr("rx", 8)
    .attr("class", followsDominant ? "item-lane" : "item-lane item-lane-deviant")
    .attr("data-entity-id", item)
    .style("cursor", "pointer")
    .on("click",     () => _cb.onItemExpand(item))
    .on("mouseover", function() { if (!isExp) d3.select(this).attr("fill", laneHoverFill).attr("stroke", laneHoverStroke); })
    .on("mouseout",  function() { if (!isExp) d3.select(this).attr("fill", laneFill).attr("stroke", laneStroke); });

  // POItem node
  const itemG = lNodes.append("g")
    .attr("transform", `translate(${ITEM_X},${midY})`)
    .style("cursor", "pointer")
    .on("click",      () => _cb.onItemExpand(item))
    .on("mousemove",  ev => _cb.onTooltipShow(
      `<div class="tip-title">${item}</div>
       <div class="tip-row">Type: <b>POItem</b></div>
       <div class="tip-row">Events: <b>${evCount}</b></div>
       <div class="tip-row">Sync events: <b>${syncEventCount ?? 0}</b></div>
       <div class="tip-row">Range: <b>${dateRange}</b></div>
       <div class="tip-row">Dominant pattern: <b>${followsDominant ? "Yes" : "No"}</b></div>
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
      .text(laneLabel);
    lLabels.append("text")
      .attr("x", ITEM_X + ITEM_R + 12).attr("y", midY + 9)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "9px").attr("fill", "var(--text-dim)")
      .text(syncEventCount ? `${evCount} events · ${syncEventCount} sync · ${dateRange}` : `${evCount} events · ${dateRange}`);
  } else {
    // Expanded: keep the annotation band compact and away from the timeline.
    lLabels.append("text")
      .attr("x", ITEM_X).attr("y", rowY + 13)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px").attr("fill", color).attr("opacity", 0.65)
      .text(laneLabel);
    lLabels.append("text")
      .attr("x", ITEM_X + ITEM_R + 14).attr("y", rowY + 18)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "9px").attr("fill", "var(--text-dim)")
      .text(showSyncOnly
        ? `${syncEventCount ?? 0} sync • ${dateRange}`
        : (syncEventCount ? `${evCount} ev • ${syncEventCount} sync • ${dateRange}` : `${evCount} ev • ${dateRange}`));
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
  const bottleneckEdges = dfItemEdges.filter(d => d.isBottleneck);

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

  if (bottleneckEdges.length) {
    const bottleneckOverlay = lBg.append("g").attr("class", "bottleneck-overlay-group");
    bottleneckOverlay.selectAll(null).data(bottleneckEdges).join("rect")
      .attr("class", "bottleneck-overlay")
      .attr("x", d => _bottleneckBandX(d))
      .attr("y", midY - 13)
      .attr("width", d => _bottleneckBandWidth(d))
      .attr("height", 26)
      .attr("rx", 13)
      .attr("fill", "rgba(217,119,6,0.10)")
      .attr("stroke", "rgba(217,119,6,0.26)")
      .attr("stroke-width", 1.1)
      .attr("pointer-events", "none");
  }

  // DF item edges
  lDfItem.selectAll(null).data(dfItemEdges).join("path")
    .attr("class", d => d.isBottleneck ? "edge-dfitem edge-dfitem-bottleneck" : "edge-dfitem")
    .attr("data-edge-id", d => d.id)
    .attr("data-entity-id", d => d.entityId)
    .attr("data-source-id", d => d.sourceId)
    .attr("data-target-id", d => d.targetId)
    .attr("d", d => {
      if (d.type === "arc") {
        const r = 16;
        return `M${d.x1},${d.y1} C${d.x1+r},${d.y1-r} ${d.x2+r},${d.y2-r} ${d.x2},${d.y2}`;
      }
      return `M${d.x1},${d.y1} L${d.x2},${d.y2}`;
    })
    .attr("fill", "none")
    .attr("stroke", d => d.isBottleneck ? "#d97706" : d.color)
    .attr("stroke-width", d => d.isBottleneck ? 2.6 : 1.5)
    .attr("stroke-dasharray", d => d.isBottleneck ? "6 4" : null)
    .attr("marker-end", d => d.isBottleneck ? "url(#arr-dfitem-bottleneck)" : "url(#arr-dfitem)")
    .style("cursor", "pointer")
    .on("mousemove", (ev, d) => _cb.onTooltipShow(_edgeTooltipHtml(d), ev.offsetX, ev.offsetY))
    .on("click", (ev, d) => {
      ev.stopPropagation();
      _toggleSelection({ kind: "edge", edgeId: d.id, entityId: d.entityId, sourceId: d.sourceId, targetId: d.targetId });
    })
    .on("mouseleave", _cb.onTooltipHide);

  if (bottleneckEdges.length) {
    const bottleneckBadge = lLabels.append("g").attr("class", "bottleneck-badge-group");
    const badgeG = bottleneckBadge.selectAll(null).data(bottleneckEdges).join("g")
      .attr("class", "bottleneck-badge")
      .attr("transform", d => `translate(${_bottleneckMidX(d)},${midY - 22})`)
      .attr("pointer-events", "none");

    badgeG.append("rect")
      .attr("x", d => -_bottleneckBadgeHalfWidth(d))
      .attr("y", -8)
      .attr("width", d => _bottleneckBadgeHalfWidth(d) * 2)
      .attr("height", 16)
      .attr("rx", 8)
      .attr("fill", "rgba(255,247,237,0.96)")
      .attr("stroke", "rgba(217,119,6,0.55)")
      .attr("stroke-width", 1);

    badgeG.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.34em")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px")
      .attr("font-weight", "700")
      .attr("fill", "#b45309")
      .text(d => _compactGapLabel(d.gapHours));
  }

  _drawResourceOverlay(lRes, row);

  // Event nodes
  const evG = lNodes.selectAll(null).data(timelineNodes).join("g")
    .attr("class", d => d.isSyncEvent ? "event-node event-sync-group" : "event-node")
    .attr("data-event-id", d => d.id)
    .attr("data-entity-id", d => d.poitem_id)
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer");

  // Outer hover ring (invisible until hover — CSS handles this via filter)
  evG.append("circle")
    .attr("r", EVENT_R + 4)
    .attr("fill", "transparent").attr("stroke", "transparent")
    .attr("class", "ev-hover-ring");

  evG.filter(d => d.isSyncEvent)
    .append("circle")
    .attr("r", d => _eventRadius(d) + 5)
    .attr("fill", "none")
    .attr("stroke", "rgba(255,255,255,0.96)")
    .attr("stroke-width", 2.2)
    .attr("class", "sync-outer-ring");

  evG.filter(d => d.isSyncEvent)
    .append("circle")
    .attr("r", d => _eventRadius(d) + 7)
    .attr("fill", "none")
    .attr("stroke", "rgba(37,99,235,0.30)")
    .attr("stroke-width", 1.6)
    .attr("class", "sync-pulse-ring");

  evG.append("circle")
    .attr("r", d => _eventRadius(d))
    .attr("fill", d => d.activityColor ?? d.color).attr("fill-opacity", 0.9)
    .attr("stroke", d => d.resourceColor ?? "#f8fbff")
    .attr("stroke-width", d => d.isSyncEvent ? 2 : 1.6)
    .attr("class", d => d.isSyncEvent ? "event-circle event-circle-sync" : "event-circle");

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
         ${d.isSyncEvent ? `<div class="tip-row">Sync degree: <b>${d.syncDegree}</b></div>` : ""}
         ${d.isSyncEvent && d.sharedEntityIds?.length ? `<div class="tip-row">Shared by: <b>${d.sharedEntityIds.join(", ")}</b></div>` : ""}
         ${_hasResourceValue(d.org_resource) ? `<div class="tip-row">Resource: <b>${d.org_resource}</b></div>` : ""}
         ${d.lifecycle_transition ? `<div class="tip-row">Lifecycle: <b>${d.lifecycle_transition}</b></div>` : ""}
         ${_tooltipRows(d, ["Document_Type", "Source", "Vendor", "Company"])}
         ${d.isSyncEvent ? _syncContextRows(d.syncContexts ?? []) : ""}`,
        ev.offsetX, ev.offsetY
      );
    })
    .on("click", function(ev, d) {
      ev.stopPropagation();
      _toggleSelection({
        kind: "event",
        eventId: d.id,
        entityId: d.poitem_id,
        relatedEntityIds: d.sharedEntityIds ?? [d.poitem_id],
      });
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
      .attr("x", n.x).attr("y", midY + _eventRadius(n) + 13)
      .attr("text-anchor", anchor)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "8px").attr("fill", "var(--text-dim)")
      .text(n.date?.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) ?? "");
  });

  // Event count label at the right end of the timeline
  lLabels.append("text")
    .attr("x", lastX + _eventRadius(timelineNodes.at(-1)) + 10).attr("y", midY + 4)
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
  gRoot.selectAll(".edge-dfitem-bottleneck")
    .attr("display", vis.dfItem ? null : "none")
    .attr("opacity", vis.dfItem ? opa.dfItem * (vis.bottleneck ? 1 : 0.22) : 0);
  gRoot.selectAll(".bottleneck-overlay")
    .attr("display", vis.dfItem ? null : "none")
    .attr("opacity", vis.dfItem ? (vis.bottleneck ? 1 : 0.18) : 0);
  gRoot.selectAll(".bottleneck-badge")
    .attr("display", vis.dfItem ? null : "none")
    .attr("opacity", vis.dfItem ? (vis.bottleneck ? 1 : 0.22) : 0);
  gRoot.selectAll(".edge-corr")
    .attr("display", vis.corr  ? null : "none").attr("opacity", opa.corr);
  gRoot.selectAll(".event-sync-group")
    .attr("opacity", vis.sync ? 1 : 0.22);
  gRoot.selectAll(".resource-overlay")
    .attr("display", vis.resources ? null : "none");
  gRoot.selectAll(".resource-satellite")
    .attr("display", vis.resources ? null : "none");
  gRoot.selectAll(".attribute-satellite")
    .attr("display", vis.attributes ? null : "none");
}

function _toggleSelection(selection) {
  if (_selection && JSON.stringify(_selection) === JSON.stringify(selection)) {
    _selection = null;
  } else {
    _selection = selection;
  }
  _applySelectionState();
}

function _clearSelection() {
  _selection = null;
  _applySelectionState();
}

function _applySelectionState() {
  if (!gRoot) return;

  const eventCircles = gRoot.selectAll(".event-circle");
  const edges = gRoot.selectAll(".edge-dfitem");
  const lanes = gRoot.selectAll(".item-lane");

  eventCircles.classed("highlighted", false).classed("dimmed", false);
  edges.classed("edge-highlighted", false).classed("edge-dimmed", false);
  lanes.classed("item-highlighted", false).classed("item-dimmed", false);

  if (!_selection) return;

  if (_selection.kind === "event") {
    const eventExists = gRoot.selectAll(`.event-node[data-event-id="${_selection.eventId}"]`).size() > 0;
    if (!eventExists) {
      _selection = null;
      return;
    }
    const entitySet = new Set(_selection.relatedEntityIds?.length ? _selection.relatedEntityIds : [_selection.entityId]);
    eventCircles
      .classed("highlighted", function() {
        return d3.select(this.parentNode).attr("data-event-id") === _selection.eventId;
      })
      .classed("dimmed", function() {
        return d3.select(this.parentNode).attr("data-event-id") !== _selection.eventId;
      });

    edges
      .classed("edge-highlighted", function() {
        const edge = d3.select(this);
        return edge.attr("data-source-id") === _selection.eventId || edge.attr("data-target-id") === _selection.eventId;
      })
      .classed("edge-dimmed", function() {
        const edge = d3.select(this);
        return edge.attr("data-source-id") !== _selection.eventId && edge.attr("data-target-id") !== _selection.eventId;
      });

    lanes
      .classed("item-highlighted", function() {
        return entitySet.has(d3.select(this).attr("data-entity-id"));
      })
      .classed("item-dimmed", function() {
        return !entitySet.has(d3.select(this).attr("data-entity-id"));
      });
    return;
  }

  if (_selection.kind === "edge") {
    const edgeExists = gRoot.selectAll(`.edge-dfitem[data-edge-id="${_selection.edgeId}"]`).size() > 0;
    if (!edgeExists) {
      _selection = null;
      return;
    }
    const activeEvents = new Set([_selection.sourceId, _selection.targetId]);
    eventCircles
      .classed("highlighted", function() {
        return activeEvents.has(d3.select(this.parentNode).attr("data-event-id"));
      })
      .classed("dimmed", function() {
        return !activeEvents.has(d3.select(this.parentNode).attr("data-event-id"));
      });

    edges
      .classed("edge-highlighted", function() {
        return d3.select(this).attr("data-edge-id") === _selection.edgeId;
      })
      .classed("edge-dimmed", function() {
        return d3.select(this).attr("data-edge-id") !== _selection.edgeId;
      });

    lanes
      .classed("item-highlighted", function() {
        return d3.select(this).attr("data-entity-id") === _selection.entityId;
      })
      .classed("item-dimmed", function() {
        return d3.select(this).attr("data-entity-id") !== _selection.entityId;
      });
  }
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

function _computeFitTransform(totalHeight, options = {}) {
  const minScale = options.minScale ?? FIT_READABLE_MIN_SCALE;
  const bounds = _contentBounds(totalHeight);
  if (!bounds || !svg?.node()) return null;

  const viewportW = svg.node().clientWidth;
  const viewportH = svg.node().clientHeight;
  const padX = options.padX ?? FIT_PAD_X;
  const padY = options.padY ?? FIT_PAD_Y;
  const innerW = Math.max(viewportW - padX * 2, 1);
  const innerH = Math.max(viewportH - padY * 2, 1);
  const widthScale = innerW / Math.max(bounds.width, 1);
  const heightScale = innerH / Math.max(bounds.height, 1);
  const fitScale = Math.min(FIT_MAX_SCALE, widthScale, heightScale);
  const scale = options.preferWidth && bounds.height > viewportH
    ? Math.min(FIT_MAX_SCALE, widthScale)
    : (fitScale < minScale && bounds.height > viewportH
        ? Math.min(minScale, widthScale)
        : fitScale);

  const tx = options.alignLeft
    ? padX - bounds.x * scale
    : viewportW / 2 - (bounds.x + bounds.width / 2) * scale;
  const ty = options.alignTop
    ? padY - bounds.y * scale
    : viewportH / 2 - (bounds.y + bounds.height / 2) * scale;

  return d3.zoomIdentity
    .translate(tx, ty)
    .scale(scale);
}

function _applyTransform(transform, animate) {
  if (!svg || !zoom) return;
  const clampedTransform = _clampTransformScale(transform);
  if (animate) {
    svg.transition()
      .duration(CAMERA_EASE_MS)
      .ease(d3.easeCubicOut)
      .call(zoom.transform, clampedTransform);
    return;
  }
  svg.call(zoom.transform, clampedTransform);
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

function _setZoomScaleExtent(minScale = ZOOM_MIN_SCALE) {
  if (!zoom) return;
  const floor = Math.max(ZOOM_MIN_SCALE, Math.min(minScale, ZOOM_MAX_SCALE));
  zoom.scaleExtent([floor, ZOOM_MAX_SCALE]);
}

function _clampTransformScale(transform) {
  if (!zoom || !svg?.node()) return transform;
  const [minScale, maxScale] = zoom.scaleExtent();
  const nextScale = Math.max(minScale, Math.min(transform?.k ?? 1, maxScale));
  if (Math.abs(nextScale - (transform?.k ?? 1)) < 1e-6) return transform;

  const viewportW = svg.node().clientWidth;
  const viewportH = svg.node().clientHeight;
  const currentScale = Math.max(transform?.k ?? 1, 1e-6);
  const graphCenterX = (viewportW / 2 - (transform?.x ?? 0)) / currentScale;
  const graphCenterY = (viewportH / 2 - (transform?.y ?? 0)) / currentScale;

  return d3.zoomIdentity
    .translate(viewportW / 2 - graphCenterX * nextScale, viewportH / 2 - graphCenterY * nextScale)
    .scale(nextScale);
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

function _rgba(value, alpha = 1) {
  const color = d3.color(value);
  if (!color) return value;
  color.opacity = alpha;
  return color.formatRgb();
}

function _formatPercent(fraction) {
  const percent = Math.max(0, fraction ?? 0) * 100;
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

function _eventRadius(d) {
  return d?.isSyncEvent ? EVENT_R + Math.min(Math.max((d.syncDegree ?? 1) - 1, 1), 5) * 1.7 : EVENT_R;
}

function _syncContextRows(syncContexts) {
  if (!syncContexts?.length) return "";
  return `
    <div class="tip-divider"></div>
    <div class="tip-subtitle">Shared lifecycle context</div>
    ${syncContexts.map(context => `
      <div class="tip-row"><b>${context.entityId}</b></div>
      <div class="tip-row">Prev: <b>${_neighborSummary(context.predecessorActivities)}</b></div>
      <div class="tip-row">Next: <b>${_neighborSummary(context.successorActivities)}</b></div>
    `).join("")}
  `;
}

function _neighborSummary(activities) {
  return activities?.length ? activities.join(", ") : "—";
}


function _edgeTooltipHtml(d) {
  return `<div class="tip-title">DF edge</div>
    <div class="tip-row">From: <b>${d.sourceActivity}</b></div>
    <div class="tip-row">To: <b>${d.targetActivity}</b></div>
    <div class="tip-row">Gap: <b>${_formatGapHours(d.gapHours)}</b></div>
    <div class="tip-row">Bottleneck: <b>${d.isBottleneck ? "Yes" : "No"}</b></div>`;
}

function _formatGapHours(hours) {
  if (!Number.isFinite(hours)) return "n/a";
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainderHours = Math.round(hours - days * 24);
    return `${days}d ${remainderHours}h`;
  }
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function _compactGapLabel(hours) {
  if (!Number.isFinite(hours)) return "gap";
  if (hours >= 24) return `${Math.max(1, Math.round(hours / 24))}d`;
  return `${Math.max(1, Math.round(hours))}h`;
}

function _bottleneckMidX(edge) {
  return (edge.x1 + edge.x2) / 2;
}

function _bottleneckBandWidth(edge) {
  return Math.max(Math.abs(edge.x2 - edge.x1) + 16, 32);
}

function _bottleneckBandX(edge) {
  return Math.min(edge.x1, edge.x2) - 8;
}

function _bottleneckBadgeHalfWidth(edge) {
  const label = _compactGapLabel(edge.gapHours);
  return Math.max(14, 7 + label.length * 3.2);
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
  mk("arr-dfitem-bottleneck", "#d97706");
  mk("arr-dfpo",   PO_COLOR);
  mk("arr-corr",   "rgba(34,48,71,0.22)", 4);
}

