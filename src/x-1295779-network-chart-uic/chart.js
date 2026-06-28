/**
 * D3 force-directed network graph renderer.
 *
 * `drawChart` fully (re)renders the chart into `container` on every call. It owns
 * the SVG subtree imperatively while the Seismic/snabbdom view only provides the
 * stable host container. Re-rendering on each property change keeps the
 * look-and-feel fully driven by the UI Builder property panel.
 *
 * We import the specific d3 functions we use as NAMED imports (rather than
 * `import * as d3`): the ServiceNow production build tree-shakes a namespace
 * object that's passed around, which would strip methods like `select`.
 *
 * No `d3-transition` -- it gets tree-shaken out of the prod bundle. The layout is
 * settled synchronously by ticking the simulation in a loop (so a static graph
 * renders even headless), then optionally animated live via requestAnimationFrame.
 *
 * dispatch(actionName, payload) emits the custom actions declared in now-ui.json
 * (CHART_CLICKED / NODE_CLICKED / NODE_HOVERED) so page authors can hook them as
 * event handlers in UI Builder.
 *
 * DATA SHAPE (differs from the line/column chart's `series`): an OBJECT
 *   { nodes: [ { id, label?, group?, value?, color? } ],
 *     links: [ { source, target, value? } ] }
 * where each link's source/target reference a node `id` (or node index).
 */
import { select } from 'd3-selection';
import { scaleOrdinal, scaleSqrt, scaleLinear } from 'd3-scale';
import {
	schemeCategory10, schemeTableau10, schemeSet2, schemeSet3,
	schemePaired, schemeDark2, schemePastel1, schemeAccent
} from 'd3-scale-chromatic';
import {
	forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY
} from 'd3-force';
import { drag } from 'd3-drag';
import { color as d3color } from 'd3-color';
import {
	easeLinear, easeCubicOut, easeCubicInOut, easeQuadOut,
	easeExpOut, easeBackOut, easeBounceOut, easeElasticOut
} from 'd3-ease';

// Named categorical color schemes selectable via the `colorScheme` property.
const SCHEMES = {
	category10: schemeCategory10,
	tableau10: schemeTableau10,
	set2: schemeSet2,
	set3: schemeSet3,
	paired: schemePaired,
	dark2: schemeDark2,
	pastel1: schemePastel1,
	accent: schemeAccent
};

// Easing curves selectable via the `animationEasing` property.
const EASINGS = {
	linear: easeLinear,
	cubicOut: easeCubicOut,
	cubicInOut: easeCubicInOut,
	quadOut: easeQuadOut,
	expOut: easeExpOut,
	backOut: easeBackOut,
	bounceOut: easeBounceOut,
	elasticOut: easeElasticOut
};

const num = (v, fallback) => {
	const n = typeof v === 'string' ? parseFloat(v) : v;
	return Number.isFinite(n) ? n : fallback;
};

const isBlank = (v) => v === undefined || v === null || v === '';

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const swatchHtml = (cssColor) => {
	const safe = String(cssColor).replace(/[^a-zA-Z0-9#(),.%\s-]/g, '');
	return `<span class="nc-tt-swatch" style="background:${safe}"></span>`;
};

/** Slightly brighten a color for hover emphasis. */
const brighten = (cssColor) => {
	const c = d3color(cssColor);
	return c ? c.brighter(0.5).formatHex() : cssColor;
};

/**
 * Normalize the `data` property into { nodes, links }.
 * - accepts { nodes, links } (also tolerates a bare array of nodes)
 * - coerces ids to string, dedupes nodes by id
 * - drops links referencing a missing node
 * - resolves numeric link source/target as node indices
 */
const normalizeData = (raw) => {
	let rawNodes = [];
	let rawLinks = [];
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		if (Array.isArray(raw.nodes)) rawNodes = raw.nodes;
		if (Array.isArray(raw.links)) rawLinks = raw.links;
		else if (Array.isArray(raw.edges)) rawLinks = raw.edges;
	} else if (Array.isArray(raw)) {
		rawNodes = raw;
	}

	const nodes = [];
	const byId = {};
	for (let i = 0; i < rawNodes.length; i += 1) {
		const n = rawNodes[i];
		if (!n || n.id === undefined || n.id === null) continue;
		const id = String(n.id);
		if (byId[id]) continue; // dedupe by id (first wins)
		const node = {
			id,
			label: isBlank(n.label) ? id : String(n.label),
			group: isBlank(n.group) ? '' : String(n.group),
			value: num(n.value, NaN),
			color: isBlank(n.color) ? '' : String(n.color),
			raw: n
		};
		byId[id] = node;
		nodes.push(node);
	}

	// allow links to reference a node id OR a node index into the nodes array
	const resolveRef = (ref) => {
		if (ref && typeof ref === 'object' && ref.id !== undefined) {
			return byId[String(ref.id)] ? String(ref.id) : null;
		}
		const asId = String(ref);
		if (byId[asId]) return asId;
		// numeric index fallback
		const idx = typeof ref === 'number' ? ref : parseInt(ref, 10);
		if (Number.isInteger(idx) && idx >= 0 && idx < nodes.length) return nodes[idx].id;
		return null;
	};

	const links = [];
	for (let i = 0; i < rawLinks.length; i += 1) {
		const l = rawLinks[i];
		if (!l || l.source === undefined || l.target === undefined) continue;
		const s = resolveRef(l.source);
		const t = resolveRef(l.target);
		if (s === null || t === null) continue; // drop links to missing nodes
		links.push({ source: s, target: t, value: num(l.value, NaN), raw: l });
	}

	return { nodes, links };
};

export function drawChart(container, props, dispatch) {
	// ----- normalize data -----
	const { nodes, links } = normalizeData(props.data);

	// degree (number of incident links) per node, for tooltips + sizing
	const degree = {};
	nodes.forEach((n) => { degree[n.id] = 0; });
	links.forEach((l) => {
		degree[l.source] = (degree[l.source] || 0) + 1;
		degree[l.target] = (degree[l.target] || 0) + 1;
	});
	nodes.forEach((n) => { n.degree = degree[n.id] || 0; });

	// ----- normalize look-and-feel props -----
	const backgroundColor = props.backgroundColor || 'transparent';
	const fontFamily = props.fontFamily || 'inherit';
	const chartTitle = props.chartTitle || '';
	const titleColor = props.titleColor || '#374151';
	const titleFontSize = num(props.titleFontSize, 18);

	const chargeStrength = num(props.chargeStrength, -180);
	const linkDistance = Math.max(1, num(props.linkDistance, 60));
	const collidePadding = Math.max(0, num(props.collidePadding, 4));
	const nodeRadius = Math.max(1, num(props.nodeRadius, 8));
	const nodeRadiusField = isBlank(props.nodeRadiusField) ? '' : String(props.nodeRadiusField);
	const nodeMinRadius = Math.max(1, num(props.nodeMinRadius, 4));
	const nodeMaxRadius = Math.max(nodeMinRadius, num(props.nodeMaxRadius, 22));
	const simulationTicks = Math.max(1, Math.round(num(props.simulationTicks, 200)));

	const linkWidth = Math.max(0.1, num(props.linkWidth, 1.5));
	const linkWidthField = isBlank(props.linkWidthField) ? '' : String(props.linkWidthField);
	const linkColor = props.linkColor || '#cbd5e1';
	const linkOpacity = Math.max(0, Math.min(1, num(props.linkOpacity, 0.6)));
	const directed = props.directed === true;

	const showLabels = props.showLabels !== false;
	const labelField = isBlank(props.labelField) ? 'label' : String(props.labelField);
	const labelFontSize = num(props.labelFontSize, 11);
	const labelColor = props.labelColor || '#374151';

	const colorScheme = props.colorScheme || 'category10';
	const customPalette = Array.isArray(props.colorPalette) && props.colorPalette.length
		? props.colorPalette.map((c) => String(c))
		: ['#2E93fA', '#66DA26', '#546E7A', '#E91E63', '#FF9800', '#9C27B0'];

	const animationDuration = Math.max(0, num(props.animationDuration, 800));
	const animate = props.animate !== false && animationDuration > 0;
	const easeFn = EASINGS[props.animationEasing] || easeCubicOut;

	const hoverHighlight = props.hoverHighlight !== false;
	const hoverDimOthers = props.hoverDimOthers === true;

	const showTooltip = props.showTooltip !== false;
	const tooltipTemplate = isBlank(props.tooltipTemplate)
		? '{swatch}<strong>{label}</strong><br/>{group}'
		: props.tooltipTemplate;
	const tooltipFollowCursor = props.tooltipFollowCursor !== false;
	const tooltipBackground = props.tooltipBackground || 'rgba(17,24,39,0.92)';
	const tooltipTextColor = props.tooltipTextColor || '#ffffff';
	const tooltipFontSize = num(props.tooltipFontSize, 12);

	// ----- color scale (by group; explicit node.color always wins) -----
	const palette = colorScheme === 'custom' ? customPalette : (SCHEMES[colorScheme] || schemeCategory10);
	const groups = [];
	const groupSeen = {};
	nodes.forEach((n) => { if (!groupSeen[n.group]) { groupSeen[n.group] = true; groups.push(n.group); } });
	const colorScale = scaleOrdinal().domain(groups).range(palette.length ? palette : schemeCategory10);
	const colorFor = (n) => (n.color ? n.color : colorScale(n.group));

	// ----- node radius scale (sqrt by value when sizing by a field / values present) -----
	const radiusValues = nodes
		.map((n) => (nodeRadiusField ? num(n.raw ? n.raw[nodeRadiusField] : undefined, NaN) : n.value))
		.filter((v) => Number.isFinite(v));
	const sizeByValue = (nodeRadiusField !== '' && radiusValues.length > 0)
		|| (nodeRadiusField === '' && radiusValues.length === nodes.length && nodes.length > 0
			&& radiusValues.some((v, i) => i > 0 && v !== radiusValues[0]));
	let radiusScale = null;
	if (sizeByValue) {
		const rMin = Math.min.apply(null, radiusValues);
		let rMax = Math.max.apply(null, radiusValues);
		if (rMax === rMin) rMax = rMin + 1;
		radiusScale = scaleSqrt().domain([rMin, rMax]).range([nodeMinRadius, nodeMaxRadius]);
	}
	const radiusOf = (n) => {
		if (!radiusScale) return nodeRadius;
		const v = nodeRadiusField ? num(n.raw ? n.raw[nodeRadiusField] : undefined, NaN) : n.value;
		return Number.isFinite(v) ? radiusScale(v) : nodeRadius;
	};

	// ----- link width scale (by value when a field is named / values present) -----
	const linkVals = links.map((l) => l.value).filter((v) => Number.isFinite(v));
	const sizeLinkByValue = linkWidthField !== '' && linkVals.length > 0;
	let linkWidthScale = null;
	if (sizeLinkByValue) {
		let lMin = Math.min.apply(null, linkVals);
		let lMax = Math.max.apply(null, linkVals);
		if (lMax === lMin) { lMin = 0; if (lMax === 0) lMax = 1; }
		linkWidthScale = scaleLinear().domain([lMin, lMax]).range([Math.max(0.5, linkWidth * 0.6), linkWidth * 2.5]);
	}
	const linkWidthOf = (l) => {
		if (!linkWidthScale) return linkWidth;
		const v = linkWidthField === 'value' ? l.value : num(l.raw ? l.raw[linkWidthField] : undefined, l.value);
		return Number.isFinite(v) ? linkWidthScale(v) : linkWidth;
	};

	// ----- clear previous render -----
	const root = select(container);
	root.selectAll('*').remove();

	// ----- dimensions -----
	const rect = container.getBoundingClientRect();
	const measuredW = Math.floor(rect.width) || container.clientWidth || 0;
	const width = Math.max(220, measuredW || 600);
	const height = Math.max(120, num(props.chartHeight, 420));

	// ----- root svg + background click target -----
	const svg = root
		.append('svg')
		.attr('class', 'nc-svg')
		.attr('width', width).attr('height', height)
		.attr('viewBox', `0 0 ${width} ${height}`)
		.style('font-family', fontFamily)
		.style('display', 'block')
		.on('click', () => {
			dispatch('CHART_CLICKED', { nodeCount: nodes.length, linkCount: links.length });
		});

	svg.append('rect').attr('class', 'nc-bg')
		.attr('width', width).attr('height', height).attr('fill', backgroundColor);

	// ----- title -----
	const titleBand = chartTitle ? titleFontSize + 18 : 0;
	if (chartTitle) {
		svg.append('text').attr('class', 'nc-title')
			.attr('x', width / 2).attr('y', titleFontSize + 2)
			.attr('text-anchor', 'middle').attr('fill', titleColor)
			.style('font-size', `${titleFontSize}px`).style('font-weight', '600')
			.text(chartTitle);
	}

	// ----- empty state -----
	if (!nodes.length) {
		svg.append('text')
			.attr('x', width / 2).attr('y', (height + titleBand) / 2)
			.attr('text-anchor', 'middle').attr('fill', '#6b7280')
			.style('font-size', '13px').text('No data to display');
		return;
	}

	// ----- plot area (below the title) -----
	const plotTop = titleBand;
	const plotH = Math.max(40, height - plotTop);
	const cx = width / 2;
	const cy = plotTop + plotH / 2;

	// arrowhead marker for directed graphs
	if (directed) {
		const defs = svg.append('defs');
		const marker = defs.append('marker')
			.attr('id', 'nc-arrow')
			.attr('viewBox', '0 -5 10 10')
			.attr('refX', 10).attr('refY', 0)
			.attr('markerWidth', 6).attr('markerHeight', 6)
			.attr('orient', 'auto');
		marker.append('path')
			.attr('d', 'M0,-5L10,0L0,5')
			.attr('fill', linkColor);
	}

	const plot = svg.append('g').attr('class', 'nc-plot');

	// ----- build simulation -----
	// seed deterministic-ish starting positions so headless layout is stable
	nodes.forEach((n, i) => {
		if (!Number.isFinite(n.x)) n.x = cx + Math.cos((i / nodes.length) * 2 * Math.PI) * Math.min(width, plotH) * 0.3;
		if (!Number.isFinite(n.y)) n.y = cy + Math.sin((i / nodes.length) * 2 * Math.PI) * Math.min(width, plotH) * 0.3;
	});

	const sim = forceSimulation(nodes)
		.force('charge', forceManyBody().strength(chargeStrength))
		.force('link', forceLink(links).id((d) => d.id).distance(linkDistance))
		.force('center', forceCenter(cx, cy))
		.force('collide', forceCollide().radius((d) => radiusOf(d) + collidePadding))
		.force('x', forceX(cx).strength(0.04))
		.force('y', forceY(cy).strength(0.04));

	// settle the layout SYNCHRONOUSLY so a static graph renders even headless
	sim.stop();
	for (let i = 0; i < simulationTicks; i += 1) sim.tick();

	// clamp final positions within the plot bounds
	const clampNodes = () => {
		nodes.forEach((n) => {
			const r = radiusOf(n);
			n.x = Math.max(r + 1, Math.min(width - r - 1, n.x));
			n.y = Math.max(plotTop + r + 1, Math.min(height - r - 1, n.y));
		});
	};
	clampNodes();

	// ----- draw links -----
	const linkSel = plot.append('g').attr('class', 'nc-links')
		.attr('stroke', linkColor)
		.attr('stroke-opacity', linkOpacity)
		.selectAll('line').data(links).join('line')
		.attr('class', 'nc-link')
		.attr('stroke-width', (d) => linkWidthOf(d))
		.attr('marker-end', directed ? 'url(#nc-arrow)' : null);

	// ----- draw nodes -----
	const nodeSel = plot.append('g').attr('class', 'nc-nodes')
		.selectAll('circle').data(nodes).join('circle')
		.attr('class', 'nc-node')
		.attr('r', (d) => radiusOf(d))
		.attr('fill', (d) => colorFor(d))
		.attr('stroke', '#ffffff')
		.attr('stroke-width', 1.2)
		.style('cursor', 'pointer');

	// ----- node labels -----
	const labelSel = showLabels
		? plot.append('g').attr('class', 'nc-labels').style('pointer-events', 'none')
			.selectAll('text').data(nodes).join('text')
			.attr('class', 'nc-label')
			.attr('text-anchor', 'middle')
			.attr('fill', labelColor)
			.style('font-size', `${labelFontSize}px`)
			.style('font-family', fontFamily)
			.text((d) => {
				const v = d.raw && d.raw[labelField] !== undefined && d.raw[labelField] !== null && d.raw[labelField] !== ''
					? d.raw[labelField]
					: (labelField === 'id' ? d.id : d.label);
				return v;
			})
		: null;

	// position all marks from current node positions
	const positionMarks = () => {
		linkSel
			.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
			.attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
		nodeSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
		if (labelSel) labelSel.attr('x', (d) => d.x).attr('y', (d) => d.y - radiusOf(d) - 3);
	};
	positionMarks();

	// ----- neighbor lookup for hover highlight -----
	const neighbors = {};
	nodes.forEach((n) => { neighbors[n.id] = {}; neighbors[n.id][n.id] = true; });
	links.forEach((l) => {
		const s = l.source.id || l.source;
		const t = l.target.id || l.target;
		if (!neighbors[s]) neighbors[s] = {};
		if (!neighbors[t]) neighbors[t] = {};
		neighbors[s][t] = true;
		neighbors[t][s] = true;
	});

	// ----- tooltip -----
	const tooltipEl = showTooltip
		? root.append('div').attr('class', 'nc-tooltip')
			.style('background', tooltipBackground).style('color', tooltipTextColor)
			.style('font-size', `${tooltipFontSize}px`).style('font-family', fontFamily)
			.style('opacity', 0).style('display', 'none')
		: null;

	const renderTemplate = (d) => {
		const fill = colorFor(d);
		const ctx = Object.assign({}, d.raw || {}, {
			id: d.id, label: d.label, group: d.group,
			value: Number.isFinite(d.value) ? d.value : '',
			degree: d.degree, color: fill
		});
		return tooltipTemplate.replace(/\{(\w+)\}/g, (m, key) => {
			if (key === 'swatch') return swatchHtml(fill);
			const v = ctx[key];
			return (v === undefined || v === null) ? '' : escapeHtml(v);
		});
	};

	const placeTooltip = (clientX, clientY, anchorX, anchorY) => {
		if (!tooltipEl) return;
		const cr = container.getBoundingClientRect();
		const node = tooltipEl.node();
		const tw = node.offsetWidth;
		const th = node.offsetHeight;
		let xPos;
		let yPos;
		if (tooltipFollowCursor) {
			xPos = clientX - cr.left + 14;
			yPos = clientY - cr.top + 14;
			if (yPos + th > cr.height) yPos = clientY - cr.top - th - 14;
		} else {
			xPos = anchorX - tw / 2;
			yPos = anchorY - th - 12;
			if (yPos < 0) yPos = anchorY + 14;
		}
		if (xPos + tw > cr.width) xPos = cr.width - tw - 4;
		if (xPos < 0) xPos = 4;
		if (yPos < 0) yPos = 4;
		tooltipEl.style('left', `${xPos}px`).style('top', `${yPos}px`);
	};

	// ----- hover interaction (highlight node + connected links/neighbors) -----
	const applyHover = (d) => {
		if (!hoverHighlight && !hoverDimOthers) return;
		const adj = neighbors[d.id] || {};
		nodeSel
			.attr('fill', (n) => {
				if (n.id === d.id && hoverHighlight) return brighten(colorFor(n));
				return colorFor(n);
			})
			.style('opacity', (n) => (hoverDimOthers ? (adj[n.id] ? 1 : 0.15) : 1));
		linkSel.style('opacity', (l) => {
			const s = l.source.id || l.source;
			const t = l.target.id || l.target;
			const connected = s === d.id || t === d.id;
			if (hoverDimOthers) return connected ? 1 : 0.08;
			return connected && hoverHighlight ? 1 : linkOpacity;
		}).attr('stroke', (l) => {
			const s = l.source.id || l.source;
			const t = l.target.id || l.target;
			return (hoverHighlight && (s === d.id || t === d.id)) ? brighten(linkColor) : linkColor;
		});
		if (labelSel) labelSel.style('opacity', (n) => (hoverDimOthers ? (adj[n.id] ? 1 : 0.2) : 1));
	};
	const clearHover = () => {
		nodeSel.attr('fill', (n) => colorFor(n)).style('opacity', 1);
		linkSel.style('opacity', linkOpacity).attr('stroke', linkColor);
		if (labelSel) labelSel.style('opacity', 1);
	};

	nodeSel
		.on('mouseenter', function (event, d) {
			applyHover(d);
			if (tooltipEl) {
				tooltipEl.html(renderTemplate(d)).style('display', 'block').style('opacity', 1);
				placeTooltip(event.clientX, event.clientY, d.x, d.y - radiusOf(d));
			}
			dispatch('NODE_HOVERED', { id: d.id, label: d.label, group: d.group, value: Number.isFinite(d.value) ? d.value : null });
		})
		.on('mousemove', function (event, d) {
			if (tooltipEl) placeTooltip(event.clientX, event.clientY, d.x, d.y - radiusOf(d));
		})
		.on('mouseleave', function () {
			clearHover();
			if (tooltipEl) tooltipEl.style('opacity', 0).style('display', 'none');
		})
		.on('click', function (event, d) {
			event.stopPropagation();
			dispatch('NODE_CLICKED', { id: d.id, label: d.label, group: d.group, value: Number.isFinite(d.value) ? d.value : null, degree: d.degree });
		});

	// ----- live animated settling + drag (only when rAF exists) -----
	const liveCapable = animate && typeof requestAnimationFrame === 'function';

	if (liveCapable) {
		// re-run a gentle live settle so the graph visibly drifts into place
		const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
		sim.alpha(0.6).alphaDecay(1 - Math.pow(0.001, 1 / Math.max(1, Math.round(animationDuration / 16))));
		const t0 = now();
		sim.on('tick', () => {
			clampNodes();
			positionMarks();
		});
		sim.restart();
		const stopWatch = () => {
			if (now() - t0 >= animationDuration) {
				sim.stop();
				sim.on('tick', null);
			} else {
				requestAnimationFrame(stopWatch);
			}
		};
		requestAnimationFrame(stopWatch);
	}

	// ----- node drag (no-op headless; guarded for active live sim) -----
	if (typeof drag === 'function') {
		const dragBehavior = drag()
			.on('start', function (event, d) {
				if (liveCapable) sim.alphaTarget(0.25).restart();
				d.fx = d.x; d.fy = d.y;
			})
			.on('drag', function (event, d) {
				d.fx = event.x; d.fy = event.y;
				if (!liveCapable) { clampNodes(); positionMarks(); }
			})
			.on('end', function (event, d) {
				if (liveCapable) sim.alphaTarget(0);
				d.fx = null; d.fy = null;
			});
		nodeSel.call(dragBehavior);
	}
}
