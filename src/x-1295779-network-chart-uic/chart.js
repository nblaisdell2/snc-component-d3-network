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
import { zoom, zoomIdentity } from 'd3-zoom';
import { format as d3format } from 'd3-format';
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
	// allNodes/allLinks = the full graph; nodes/links (derived after props) are the
	// visible subset once legendInteractive has hidden some groups.
	const { nodes: allNodes, links: allLinks } = normalizeData(props.data);

	// degree (number of incident links) per node, for tooltips + sizing
	const degree = {};
	allNodes.forEach((n) => { degree[n.id] = 0; });
	allLinks.forEach((l) => {
		degree[l.source] = (degree[l.source] || 0) + 1;
		degree[l.target] = (degree[l.target] || 0) + 1;
	});
	allNodes.forEach((n) => { n.degree = degree[n.id] || 0; });

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

	const nodeStroke = props.nodeStroke || '';
	const nodeStrokeWidth = Math.max(0, num(props.nodeStrokeWidth, 0));

	const linkWidth = Math.max(0.1, num(props.linkWidth, 1.5));
	const linkWidthField = isBlank(props.linkWidthField) ? '' : String(props.linkWidthField);
	const linkColor = props.linkColor || '#cbd5e1';
	const linkOpacity = Math.max(0, Math.min(1, num(props.linkOpacity, 0.6)));
	const directed = props.directed === true;
	const linkColorMode = ['source', 'target', 'gradient', 'static'].includes(props.linkColorMode) ? props.linkColorMode : 'static';
	const linkCurvature = Math.max(0, Math.min(1, num(props.linkCurvature, 0)));
	const linkHoverOpacity = Math.max(0, Math.min(1, num(props.linkHoverOpacity, 0.75)));
	const linkHover = props.linkHover !== false;

	const showLabels = props.showLabels !== false;
	const showNodeLabels = props.showNodeLabels !== false;
	const labelField = isBlank(props.labelField) ? 'label' : String(props.labelField);
	const labelFontSize = num(props.labelFontSize, 11);
	const labelColor = props.labelColor || '#374151';
	const nodeLabelPosition = ['auto', 'outside', 'inside'].includes(props.nodeLabelPosition) ? props.nodeLabelPosition : 'auto';
	const nodeLabelFontSize = num(props.nodeLabelFontSize, 12);
	const nodeLabelColor = props.nodeLabelColor || '#374151';

	const showNodeValues = props.showNodeValues === true;
	const nodeValueField = isBlank(props.nodeValueField) ? 'value' : String(props.nodeValueField);
	const nodeValueFontSize = Math.max(4, num(props.nodeValueFontSize, 9));
	const nodeValueColor = props.nodeValueColor || '#ffffff';
	let valueFormatter = null;
	if (!isBlank(props.nodeValueFormat)) {
		try { valueFormatter = d3format(String(props.nodeValueFormat)); } catch (e) { valueFormatter = null; }
	}

	const enableZoom = props.enableZoom !== false;
	const minZoom = Math.max(0.05, num(props.minZoom, 0.25));
	const maxZoom = Math.max(minZoom, num(props.maxZoom, 4));
	const showZoomControls = enableZoom && props.showZoomControls !== false;

	const colorScheme = props.colorScheme || 'category10';
	const useSeriesColors = props.useSeriesColors !== false;
	const customPalette = Array.isArray(props.colorPalette) && props.colorPalette.length
		? props.colorPalette.map((c) => String(c))
		: ['#2E93fA', '#66DA26', '#546E7A', '#E91E63', '#FF9800', '#9C27B0'];

	const dropShadow = props.dropShadow !== false;
	const shadowColor = props.shadowColor || 'rgba(0,0,0,0.25)';
	const shadowBlur = Math.max(0, num(props.shadowBlur, 4));

	const animationDuration = Math.max(0, num(props.animationDuration, 800));
	const animate = props.animate !== false && animationDuration > 0;
	const animationStagger = Math.max(0, num(props.animationStagger, 0));
	const easeFn = EASINGS[props.animationEasing] || easeCubicOut;

	const hoverHighlight = props.hoverHighlight !== false;
	const hoverColor = props.hoverColor || '';
	const hoverDimOthers = props.hoverDimOthers === true;

	const legendInteractive = props.legendInteractive === true;
	const showLegend = props.showLegend !== false;
	const legendPosition = ['top', 'right', 'bottom'].includes(props.legendPosition) ? props.legendPosition : 'bottom';
	const legendFontSize = num(props.legendFontSize, 12);

	// ----- legend groups + interactive hiding -----
	// allGroups keeps the full category list (in first-seen order) so both the color
	// scale and the legend stay stable when a group is toggled off. legendInteractive
	// hides groups by name; the hidden set lives on the stable container node so it
	// survives the redraw a legend click triggers. nodes/links are the visible subset
	// that drives the simulation, so hiding a group re-lays-out the graph.
	const allGroups = [];
	const allGroupSeen = {};
	allNodes.forEach((n) => { if (!allGroupSeen[n.group]) { allGroupSeen[n.group] = true; allGroups.push(n.group); } });
	const hidden = legendInteractive
		? (container.__ncHidden instanceof Set ? container.__ncHidden : (container.__ncHidden = new Set()))
		: new Set();
	const nodes = allNodes.filter((n) => !hidden.has(n.group));
	const visibleIds = {};
	nodes.forEach((n) => { visibleIds[n.id] = true; });
	const links = allLinks.filter((l) => visibleIds[l.source] && visibleIds[l.target]);

	const showTooltip = props.showTooltip !== false;
	const tooltipTemplate = isBlank(props.tooltipTemplate)
		? '{swatch}<strong>{label}</strong><br/>{group}'
		: props.tooltipTemplate;
	const tooltipFollowCursor = props.tooltipFollowCursor !== false;
	const tooltipBackground = props.tooltipBackground || 'rgba(17,24,39,0.92)';
	const tooltipTextColor = props.tooltipTextColor || '#ffffff';
	const tooltipFontSize = num(props.tooltipFontSize, 12);

	// ----- color scale (by group; per-node color wins when useSeriesColors is on) -----
	const palette = colorScheme === 'custom' ? customPalette : (SCHEMES[colorScheme] || schemeCategory10);
	const colorScale = scaleOrdinal().domain(allGroups).range(palette.length ? palette : schemeCategory10);
	const colorFor = (n) => (useSeriesColors && n.color ? n.color : colorScale(n.group));
	const hoverFill = (base) => (hoverColor ? hoverColor : brighten(base));

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

	// ----- legend layout (reserve a band so nodes don't overlap it) -----
	const legendVisible = showLegend && allGroups.some((g) => g !== '');
	const legendRowH = legendFontSize + 12;
	const legendItemW = (name) => 18 + String(name).length * (legendFontSize * 0.62) + 16;
	const legendOnRight = legendVisible && legendPosition === 'right';
	const legendOnTop = legendVisible && legendPosition === 'top';
	const legendOnBottom = legendVisible && legendPosition === 'bottom';
	const legendRightW = legendOnRight
		? Math.min(200, Math.max.apply(null, allGroups.map((g) => legendItemW(g || 'None'))) + 8)
		: 0;
	const legendTopH = legendOnTop ? legendRowH + 6 : 0;
	const legendBottomH = legendOnBottom ? legendRowH + 6 : 0;

	// ----- plot area (below the title, inside the legend band) -----
	const plotTop = titleBand + legendTopH;
	const plotBottom = height - legendBottomH;
	const plotRight = width - legendRightW;
	const plotH = Math.max(40, plotBottom - plotTop);
	const plotW = Math.max(40, plotRight);
	const cx = plotW / 2;
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
			.attr('fill', linkColorMode === 'static' ? linkColor : '#94a3b8');
	}

	// drop-shadow filter for node circles (copied from the column donor's construction)
	if (dropShadow) {
		const sdefs = svg.append('defs');
		const filter = sdefs.append('filter')
			.attr('id', 'nc-shadow')
			.attr('x', '-30%').attr('y', '-30%')
			.attr('width', '160%').attr('height', '160%');
		filter.append('feDropShadow')
			.attr('dx', 0).attr('dy', 1)
			.attr('stdDeviation', shadowBlur)
			.attr('flood-color', shadowColor);
	}

	// clip the plot to the chart area so zoomed/panned content crops at the
	// border instead of spilling over the page. The clip lives on a static
	// wrapper group — putting it on nc-plot itself would make the clip region
	// pan/zoom along with the content.
	svg.append('clipPath').attr('id', 'nc-clip')
		.append('rect')
		.attr('x', 0).attr('y', plotTop)
		.attr('width', plotW).attr('height', Math.max(0, plotBottom - plotTop));
	const viewport = svg.append('g')
		.attr('class', 'nc-viewport')
		.attr('clip-path', 'url(#nc-clip)');
	const plot = viewport.append('g').attr('class', 'nc-plot');

	// ----- build simulation -----
	// seed deterministic-ish starting positions so headless layout is stable
	nodes.forEach((n, i) => {
		if (!Number.isFinite(n.x)) n.x = cx + Math.cos((i / nodes.length) * 2 * Math.PI) * Math.min(plotW, plotH) * 0.3;
		if (!Number.isFinite(n.y)) n.y = cy + Math.sin((i / nodes.length) * 2 * Math.PI) * Math.min(plotW, plotH) * 0.3;
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
			n.x = Math.max(r + 1, Math.min(plotW - r - 1, n.x));
			n.y = Math.max(plotTop + r + 1, Math.min(plotBottom - r - 1, n.y));
		});
	};
	clampNodes();

	// ----- link color mode -----
	// endColor resolves a link end's node color; source/target/gradient use them, static
	// uses linkColor. Gradient needs a per-link <linearGradient> updated as the graph moves.
	const endColor = (ref) => {
		const node = (ref && typeof ref === 'object') ? ref : null;
		return node ? colorFor(node) : linkColor;
	};
	let linkGradDefs = null;
	if (linkColorMode === 'gradient') {
		linkGradDefs = svg.append('defs');
		links.forEach((l, i) => {
			l._gradId = `nc-grad-${i}`;
			const g = linkGradDefs.append('linearGradient')
				.attr('id', l._gradId)
				.attr('gradientUnits', 'userSpaceOnUse');
			g.append('stop').attr('class', 'nc-grad-s').attr('offset', '0%').attr('stop-color', endColor(l.source));
			g.append('stop').attr('class', 'nc-grad-t').attr('offset', '100%').attr('stop-color', endColor(l.target));
		});
	}
	const linkStroke = (l) => {
		if (linkColorMode === 'source') return endColor(l.source);
		if (linkColorMode === 'target') return endColor(l.target);
		if (linkColorMode === 'gradient') return `url(#${l._gradId})`;
		return linkColor;
	};

	// ----- draw links (curved paths; curvature 0 = straight) -----
	const linkSel = plot.append('g').attr('class', 'nc-links')
		.attr('fill', 'none')
		.attr('stroke-opacity', linkOpacity)
		.selectAll('path').data(links).join('path')
		.attr('class', 'nc-link')
		.attr('stroke', (d) => linkStroke(d))
		.attr('stroke-width', (d) => linkWidthOf(d))
		.attr('marker-end', directed ? 'url(#nc-arrow)' : null);

	// ----- draw nodes -----
	const nodeStrokeOn = nodeStroke && nodeStrokeWidth > 0;
	const nodeSel = plot.append('g').attr('class', 'nc-nodes')
		.attr('filter', dropShadow ? 'url(#nc-shadow)' : null)
		.selectAll('circle').data(nodes).join('circle')
		.attr('class', 'nc-node')
		.attr('r', (d) => radiusOf(d))
		.attr('fill', (d) => colorFor(d))
		.attr('stroke', nodeStrokeOn ? nodeStroke : '#ffffff')
		.attr('stroke-width', nodeStrokeOn ? nodeStrokeWidth : 1.2)
		.style('cursor', 'pointer');

	// ----- node labels -----
	// Both toggles must be on to draw labels. The Labels-section style props
	// (nodeLabelFontSize/nodeLabelColor) drive the effective typography; the older
	// labelFontSize/labelColor stay as the fallback when the newer ones aren't set.
	const labelsOn = showLabels && showNodeLabels;
	const effLabelFontSize = num(props.nodeLabelFontSize, labelFontSize);
	const effLabelColor = props.nodeLabelColor || labelColor;
	const labelInside = nodeLabelPosition === 'inside';
	const labelSel = labelsOn
		? plot.append('g').attr('class', 'nc-labels').style('pointer-events', 'none')
			.selectAll('text').data(nodes).join('text')
			.attr('class', 'nc-label')
			.attr('text-anchor', 'middle')
			.attr('dominant-baseline', labelInside ? 'central' : 'auto')
			.attr('fill', effLabelColor)
			.style('font-size', `${effLabelFontSize}px`)
			.style('font-family', fontFamily)
			.text((d) => {
				const v = d.raw && d.raw[labelField] !== undefined && d.raw[labelField] !== null && d.raw[labelField] !== ''
					? d.raw[labelField]
					: (labelField === 'id' ? d.id : d.label);
				return v;
			})
		: null;

	// ----- in-node value text -----
	const valueTextOf = (d) => {
		const rawV = nodeValueField === 'value' ? d.value : (d.raw ? d.raw[nodeValueField] : undefined);
		if (rawV === undefined || rawV === null || rawV === ''
			|| (typeof rawV === 'number' && !Number.isFinite(rawV))) return '';
		const numV = num(rawV, NaN);
		const text = (valueFormatter && Number.isFinite(numV))
			? valueFormatter(numV)
			: String(Number.isFinite(numV) ? numV : rawV);
		// crude width estimate (~0.6em per char) so text never overflows the circle
		return (text.length * nodeValueFontSize * 0.6 > radiusOf(d) * 2 - 4) ? '' : text;
	};
	const valueSel = showNodeValues
		? plot.append('g').attr('class', 'nc-values').style('pointer-events', 'none')
			.selectAll('text').data(nodes).join('text')
			.attr('class', 'nc-value')
			.attr('text-anchor', 'middle')
			.attr('dominant-baseline', 'central')
			.attr('fill', nodeValueColor)
			.style('font-size', `${nodeValueFontSize}px`)
			.style('font-family', fontFamily)
			.style('font-weight', '600')
			.text(valueTextOf)
		: null;

	// straight line, or a quadratic arc bowed perpendicular to the link by an amount
	// proportional to linkCurvature (0 = straight). Matches sankey's 0..1 range/default.
	const linkPath = (l) => {
		const x1 = l.source.x;
		const y1 = l.source.y;
		const x2 = l.target.x;
		const y2 = l.target.y;
		if (linkCurvature <= 0) return `M${x1},${y1}L${x2},${y2}`;
		const mx = (x1 + x2) / 2;
		const my = (y1 + y2) / 2;
		const dx = x2 - x1;
		const dy = y2 - y1;
		const dist = Math.sqrt(dx * dx + dy * dy) || 1;
		// perpendicular offset, scaled by curvature
		const off = linkCurvature * dist * 0.3;
		const px = mx - (dy / dist) * off;
		const py = my + (dx / dist) * off;
		return `M${x1},${y1}Q${px},${py} ${x2},${y2}`;
	};

	// position all marks from current node positions
	const positionMarks = () => {
		linkSel.attr('d', (d) => linkPath(d));
		if (linkGradDefs) {
			links.forEach((l) => {
				const g = linkGradDefs.select(`#${l._gradId}`);
				g.attr('x1', l.source.x).attr('y1', l.source.y).attr('x2', l.target.x).attr('y2', l.target.y);
			});
		}
		nodeSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
		if (labelSel) labelSel.attr('x', (d) => d.x).attr('y', (d) => (labelInside ? d.y : d.y - radiusOf(d) - 3));
		if (valueSel) valueSel.attr('x', (d) => d.x).attr('y', (d) => d.y);
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

	// anchored-tooltip coordinates: sim-space positions must pass through the
	// current zoom transform to land on the node as drawn
	const anchorX = (d) => {
		const zt = container.__ncZoom;
		return zt ? zt.applyX(d.x) : d.x;
	};
	const anchorY = (d) => {
		const zt = container.__ncZoom;
		const y = d.y - radiusOf(d);
		return zt ? zt.applyY(y) : y;
	};

	// ----- hover interaction (highlight node + connected links/neighbors) -----
	const linkEndId = (ref) => (ref && typeof ref === 'object' ? ref.id : ref);
	const applyHover = (d) => {
		if (!hoverHighlight && !hoverDimOthers) return;
		const adj = neighbors[d.id] || {};
		nodeSel
			.attr('fill', (n) => {
				if (n.id === d.id && hoverHighlight) return hoverFill(colorFor(n));
				return colorFor(n);
			})
			.style('opacity', (n) => (hoverDimOthers ? (adj[n.id] ? 1 : 0.15) : 1));
		linkSel.style('stroke-opacity', (l) => {
			const s = linkEndId(l.source);
			const t = linkEndId(l.target);
			const connected = s === d.id || t === d.id;
			if (hoverDimOthers) return connected ? linkHoverOpacity : 0.08;
			return connected && hoverHighlight ? linkHoverOpacity : linkOpacity;
		});
		if (labelSel) labelSel.style('opacity', (n) => (hoverDimOthers ? (adj[n.id] ? 1 : 0.2) : 1));
		if (valueSel) valueSel.style('opacity', (n) => (hoverDimOthers ? (adj[n.id] ? 1 : 0.2) : 1));
	};
	const clearHover = () => {
		nodeSel.attr('fill', (n) => colorFor(n)).style('opacity', 1);
		linkSel.style('stroke-opacity', linkOpacity).attr('stroke', (l) => linkStroke(l));
		if (labelSel) labelSel.style('opacity', 1);
		if (valueSel) valueSel.style('opacity', 1);
	};

	nodeSel
		.on('mouseenter', function (event, d) {
			applyHover(d);
			if (tooltipEl) {
				tooltipEl.html(renderTemplate(d)).style('display', 'block').style('opacity', 1);
				placeTooltip(event.clientX, event.clientY, anchorX(d), anchorY(d));
			}
			dispatch('NODE_HOVERED', { id: d.id, label: d.label, group: d.group, value: Number.isFinite(d.value) ? d.value : null });
		})
		.on('mousemove', function (event, d) {
			if (tooltipEl) placeTooltip(event.clientX, event.clientY, anchorX(d), anchorY(d));
		})
		.on('mouseleave', function () {
			clearHover();
			if (tooltipEl) tooltipEl.style('opacity', 0).style('display', 'none');
		})
		.on('click', function (event, d) {
			event.stopPropagation();
			dispatch('NODE_CLICKED', { id: d.id, label: d.label, group: d.group, value: Number.isFinite(d.value) ? d.value : null, degree: d.degree });
		});

	// ----- link hover interaction (brighten the hovered link + its endpoints) -----
	if (linkHover) {
		linkSel.style('cursor', 'pointer')
			.on('mouseenter', function (event, l) {
				const s = linkEndId(l.source);
				const t = linkEndId(l.target);
				if (hoverDimOthers) {
					nodeSel.style('opacity', (n) => (n.id === s || n.id === t ? 1 : 0.15));
					linkSel.style('stroke-opacity', (ll) => (ll === l ? linkHoverOpacity : 0.08));
					if (labelSel) labelSel.style('opacity', (n) => (n.id === s || n.id === t ? 1 : 0.2));
					if (valueSel) valueSel.style('opacity', (n) => (n.id === s || n.id === t ? 1 : 0.2));
				} else {
					select(this).style('stroke-opacity', linkHoverOpacity);
				}
				nodeSel.attr('fill', (n) => (n.id === s || n.id === t ? hoverFill(colorFor(n)) : colorFor(n)));
			})
			.on('mouseleave', function () { clearHover(); });
	}

	// ----- live animated settling + drag (only when rAF exists) -----
	const liveCapable = animate && typeof requestAnimationFrame === 'function';

	if (liveCapable) {
		// re-run a gentle live settle so the graph visibly drifts into place
		const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
		sim.alpha(0.6).alphaDecay(1 - Math.pow(0.001, 1 / Math.max(1, Math.round(animationDuration / 16))));
		const t0 = now();
		// animationStagger: fade each node/label in on a per-element delay (i*stagger) so
		// the graph cascades into view. 0 = everything appears at once with the settle.
		const staggered = animationStagger > 0;
		const maxDelay = staggered ? animationStagger * Math.max(0, nodes.length - 1) : 0;
		if (staggered) {
			nodeSel.style('opacity', 0);
			if (labelSel) labelSel.style('opacity', 0);
			if (valueSel) valueSel.style('opacity', 0);
		}
		sim.on('tick', () => {
			clampNodes();
			positionMarks();
			if (staggered) {
				const elapsed = now() - t0;
				const kAt = (i) => Math.max(0, Math.min(1, (elapsed - animationStagger * i) / Math.max(1, animationDuration)));
				nodeSel.style('opacity', (d, i) => easeFn(kAt(i)));
				if (labelSel) labelSel.style('opacity', (d, i) => easeFn(kAt(i)));
				if (valueSel) valueSel.style('opacity', (d, i) => easeFn(kAt(i)));
			}
		});
		sim.restart();
		const stopWatch = () => {
			if (now() - t0 >= animationDuration + maxDelay) {
				sim.stop();
				sim.on('tick', null);
				if (staggered) {
					nodeSel.style('opacity', 1);
					if (labelSel) labelSel.style('opacity', 1);
					if (valueSel) valueSel.style('opacity', 1);
				}
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
				// the settle watcher nulls the tick handler when the intro animation
				// ends, so re-attach it or the restarted sim moves data without marks
				if (liveCapable) {
					sim.on('tick', () => { clampNodes(); positionMarks(); });
					sim.alphaTarget(0.25).restart();
				}
				d.fx = d.x; d.fy = d.y;
			})
			.on('drag', function (event, d) {
				d.fx = event.x; d.fy = event.y;
				// move x/y directly too: marks position from x/y, and the sim only
				// copies fx into x while its timer is running (rAF-driven)
				d.x = event.x; d.y = event.y;
				clampNodes(); positionMarks();
			})
			.on('end', function (event, d) {
				if (liveCapable) sim.alphaTarget(0);
				d.fx = null; d.fy = null;
			});
		nodeSel.call(dragBehavior);
	}

	// ----- zoom & pan (wheel/pinch/dblclick + optional overlay buttons) -----
	if (enableZoom) {
		try {
			const zoomBehavior = zoom()
				.scaleExtent([minZoom, maxZoom])
				// dblclick zoom with duration > 0 uses selection.transition(),
				// which throws in prod where d3-transition is tree-shaken
				.duration(0)
				.on('zoom', (event) => {
					container.__ncZoom = event.transform;
					plot.attr('transform', event.transform);
				});
			svg.call(zoomBehavior);

			// restore the view across redraws (property changes wipe the SVG)
			const prev = container.__ncZoom;
			if (prev && Number.isFinite(prev.k)) {
				const k = Math.max(minZoom, Math.min(maxZoom, prev.k));
				svg.call(zoomBehavior.transform, zoomIdentity.translate(prev.x, prev.y).scale(k));
			}

			if (showZoomControls) {
				const controls = root.append('div').attr('class', 'nc-zoom-controls');
				const addBtn = (txt, aria, fn) => controls.append('button')
					.attr('type', 'button').attr('class', 'nc-zoom-btn').attr('aria-label', aria)
					.text(txt)
					.on('click', (event) => { event.stopPropagation(); fn(); });
				addBtn('+', 'Zoom in', () => svg.call(zoomBehavior.scaleBy, 1.4));
				addBtn('−', 'Zoom out', () => svg.call(zoomBehavior.scaleBy, 1 / 1.4));
				addBtn('⟲', 'Reset zoom', () => svg.call(zoomBehavior.transform, zoomIdentity));
			}
		} catch (e) { /* zoom is progressive enhancement; keeps headless environments safe */ }
	} else {
		container.__ncZoom = null;
	}

	// ----- legend (categorical node groups; drawn on the svg so zoom/clip don't touch it) -----
	// Binds to allGroups so hidden groups still show (dimmed/struck-through) to toggle back
	// on. When legendInteractive, clicking a group hides/shows its nodes and the chart
	// redraws with the simulation recomputed for the remaining nodes.
	if (legendVisible) {
		const legendGroups = allGroups.filter((g) => g !== '');
		const isHidden = (g) => hidden.has(g);
		const legend = svg.append('g').attr('class', 'nc-legend');
		const items = legend.selectAll('g').data(legendGroups).join('g')
			.style('cursor', legendInteractive ? 'pointer' : 'default')
			.style('opacity', (g) => (isHidden(g) ? 0.4 : 1));
		items.append('rect')
			.attr('width', 12).attr('height', 12).attr('rx', 2)
			.attr('y', -legendFontSize + 2)
			.attr('fill', (g) => colorScale(g));
		items.append('text')
			.attr('x', 18).attr('y', 0)
			.attr('dominant-baseline', 'middle')
			.attr('fill', '#374151')
			.style('font-size', `${legendFontSize}px`)
			.style('text-decoration', (g) => (isHidden(g) ? 'line-through' : 'none'))
			.text((g) => g);

		if (legendInteractive) {
			items.on('click', function (event, g) {
				event.stopPropagation();
				if (hidden.has(g)) {
					hidden.delete(g);
				} else if (legendGroups.length - hidden.size > 1) {
					hidden.add(g);
				} else {
					return;
				}
				drawChart(container, Object.assign({}, props, { animate: false }), dispatch);
			});
		}

		if (legendOnRight) {
			const totalH = legendGroups.length * legendRowH;
			let yy = plotTop + Math.max(0, (plotH - totalH) / 2);
			items.attr('transform', () => {
				const tr = `translate(${plotRight + 12},${yy + legendFontSize})`;
				yy += legendRowH;
				return tr;
			});
		} else {
			const widths = legendGroups.map(legendItemW);
			const totalW = widths.reduce((a, b) => a + b, 0);
			let xx = Math.max(8, plotW / 2 - totalW / 2);
			const yPos = legendOnTop ? titleBand + legendFontSize + 4 : plotBottom + legendFontSize + 4;
			items.attr('transform', (g, i) => {
				const tr = `translate(${xx},${yPos})`;
				xx += widths[i];
				return tr;
			});
		}
	}
}
