/**
 * D3GraphData — Script Include (global, accessible from all application scopes,
 * Client callable = false)
 * ---------------------------------------------------------------------------
 * Reusable transform that turns platform data into the GRAPH shape expected by
 * the x-2114311-network-chart-uic component's "Data · Graph data" property:
 *
 *   {
 *     nodes: [ { id, label?, group?, value?, color? }, ... ],
 *     links: [ { source, target, value? }, ... ]   // source/target ref node id
 *   }
 *
 * This is the UNDIRECTED, node-and-link sibling of the Sankey's D3SankeyData:
 * the Sankey emits directed flow ribbons between staged nodes, while a network is
 * a set of related entities laid out by a force simulation. Three entry points:
 *   - fromRelationship(cfg) : an EDGE table — each record is a relationship with a
 *                             source reference and a target reference (e.g.
 *                             cmdb_rel_ci parent/child). Nodes are derived from the
 *                             distinct endpoints.
 *   - fromAggregate(cfg)    : group ONE table by two fields -> links between the
 *                             two category values, weighted by count/metric.
 *   - fromRows(rows, cfg)   : reshape an array of already-fetched edge objects.
 *
 * Node `value` defaults to the node's total incident link weight (a useful size
 * signal for the component's "size by value" option). Self-loops (source==target)
 * are dropped — the force layout can't draw them cleanly.
 *
 * Written in ES5 for broad scoped/global compatibility (no let/const, arrow
 * functions, or template literals).
 */
var D3GraphData = Class.create();
D3GraphData.prototype = {
	initialize: function () {},

	/**
	 * Build a graph from an EDGE/relationship table.
	 * cfg: {
	 *   table, filter,
	 *   sourceField, targetField,   // reference fields; sys_id => node id, display => label
	 *   sourceGroupField?, targetGroupField?,  // (dot-walked) group/type per endpoint
	 *   linkValueField?,            // numeric field weighting the link (default 1)
	 *   useDisplayValue (default true),
	 *   recordLimit (default 5000)
	 * }
	 */
	fromRelationship: function (cfg) {
		cfg = cfg || {};
		var table = this._str(cfg.table);
		var sourceField = this._str(cfg.sourceField);
		var targetField = this._str(cfg.targetField);
		if (!table || !sourceField || !targetField) {
			return { nodes: [], links: [] };
		}
		var sGroupField = this._str(cfg.sourceGroupField);
		var tGroupField = this._str(cfg.targetGroupField);
		var linkValueField = this._str(cfg.linkValueField);
		var recordLimit = parseInt(cfg.recordLimit, 10);
		if (isNaN(recordLimit) || recordLimit <= 0) {
			recordLimit = 5000;
		}

		var gr = new GlideRecord(table);
		if (this._str(cfg.filter)) {
			gr.addEncodedQuery(cfg.filter);
		}
		gr.addNotNullQuery(sourceField);
		gr.addNotNullQuery(targetField);
		gr.setLimit(recordLimit);
		gr.query();

		var rows = [];
		while (gr.next()) {
			var sId = gr.getValue(sourceField);
			var tId = gr.getValue(targetField);
			if (!sId || !tId) {
				continue;
			}
			var v = linkValueField ? parseFloat(gr.getValue(linkValueField)) : 1;
			rows.push({
				source: "" + sId,
				sourceLabel: gr.getDisplayValue(sourceField),
				sourceGroup: sGroupField ? gr.getDisplayValue(sGroupField) : "",
				target: "" + tId,
				targetLabel: gr.getDisplayValue(targetField),
				targetGroup: tGroupField ? gr.getDisplayValue(tGroupField) : "",
				value: isNaN(v) ? 1 : v,
			});
		}
		return this._build(rows, cfg, "sum");
	},

	/**
	 * Build a graph by grouping ONE table on two fields (undirected co-occurrence).
	 * cfg: {
	 *   table, filter, sourceField, targetField,
	 *   metric (count|sum|avg|min|max), valueField (required if metric!=count),
	 *   useDisplayValue (default true)
	 * }
	 */
	fromAggregate: function (cfg) {
		cfg = cfg || {};
		var table = this._str(cfg.table);
		var sourceField = this._str(cfg.sourceField);
		var targetField = this._str(cfg.targetField);
		if (!table || !sourceField || !targetField) {
			return { nodes: [], links: [] };
		}
		var metric = (this._str(cfg.metric) || "count").toLowerCase();
		var valueField = this._str(cfg.valueField);
		if (metric !== "count" && !valueField) {
			return { nodes: [], links: [] };
		}
		var useDisplay =
			cfg.useDisplayValue !== false && cfg.useDisplayValue !== "false";

		var ga = new GlideAggregate(table);
		if (this._str(cfg.filter)) {
			ga.addEncodedQuery(cfg.filter);
		}
		ga.groupBy(sourceField);
		ga.groupBy(targetField);
		if (metric === "count") {
			ga.addAggregate("COUNT");
		} else {
			ga.addAggregate(metric.toUpperCase(), valueField);
		}
		ga.query();

		var rows = [];
		while (ga.next()) {
			var s = useDisplay
				? ga.getDisplayValue(sourceField)
				: ga.getValue(sourceField);
			var t = useDisplay
				? ga.getDisplayValue(targetField)
				: ga.getValue(targetField);
			var value;
			if (metric === "count") {
				value = parseInt(ga.getAggregate("COUNT"), 10);
			} else {
				value = parseFloat(ga.getAggregate(metric.toUpperCase(), valueField));
			}
			s = this._blank(s);
			t = this._blank(t);
			rows.push({
				source: s,
				sourceLabel: s,
				sourceGroup: "",
				target: t,
				targetLabel: t,
				targetGroup: "",
				value: isNaN(value) ? 0 : value,
			});
		}
		return this._build(rows, cfg, "sum");
	},

	/**
	 * Reshape already-fetched edge objects into a graph.
	 * cfg: { sourceField, targetField, valueField?, sourceLabelField?,
	 *        targetLabelField?, sourceGroupField?, targetGroupField?,
	 *        metric? (combine dup links; default sum) }
	 */
	fromRows: function (rows, cfg) {
		cfg = cfg || {};
		rows = rows || [];
		var sourceField = this._str(cfg.sourceField) || "source";
		var targetField = this._str(cfg.targetField) || "target";
		var valueField = this._str(cfg.valueField);
		var sLabelField = this._str(cfg.sourceLabelField);
		var tLabelField = this._str(cfg.targetLabelField);
		var sGroupField = this._str(cfg.sourceGroupField);
		var tGroupField = this._str(cfg.targetGroupField);

		var collected = [];
		for (var i = 0; i < rows.length; i++) {
			var r = rows[i] || {};
			var s = this._blank(this._readField(r, sourceField));
			var t = this._blank(this._readField(r, targetField));
			var v = valueField ? parseFloat(this._readField(r, valueField)) : 1;
			collected.push({
				source: s,
				sourceLabel: sLabelField ? "" + this._readField(r, sLabelField) : s,
				sourceGroup: sGroupField ? "" + this._readField(r, sGroupField) : "",
				target: t,
				targetLabel: tLabelField ? "" + this._readField(r, tLabelField) : t,
				targetGroup: tGroupField ? "" + this._readField(r, tGroupField) : "",
				value: isNaN(v) ? 1 : v,
			});
		}
		return this._build(
			collected,
			cfg,
			(this._str(cfg.metric) || "sum").toLowerCase(),
		);
	},

	// ----- internals -------------------------------------------------------

	/** Build { nodes, links } from flat edge rows; dedupe nodes, combine links. */
	_build: function (rows, cfg, dupMetric) {
		var metric = dupMetric || "sum";
		var nodeOrder = [];
		var nodeSeen = {};
		var nodeLabel = {};
		var nodeGroup = {};
		var nodeWeight = {};

		var addNode = function (id, label, group) {
			if (id === "(empty)" || id === "" || id === null || id === undefined) {
				return false;
			}
			if (!nodeSeen[id]) {
				nodeSeen[id] = true;
				nodeOrder.push(id);
				nodeLabel[id] = label && label !== "(empty)" ? "" + label : "" + id;
				nodeGroup[id] = group && group !== "(empty)" ? "" + group : "";
				nodeWeight[id] = 0;
			} else {
				if (
					(!nodeGroup[id] || nodeGroup[id] === "") &&
					group &&
					group !== "(empty)"
				) {
					nodeGroup[id] = "" + group;
				}
			}
			return true;
		};

		var linkKeys = [];
		var linkMap = {};
		var linkCnt = {};
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			if (row.source === row.target) {
				continue; // drop self-loops
			}
			var okS = addNode(row.source, row.sourceLabel, row.sourceGroup);
			var okT = addNode(row.target, row.targetLabel, row.targetGroup);
			if (!okS || !okT) {
				continue;
			}
			var key = row.source + "" + row.target;
			if (linkMap[key] === undefined) {
				linkMap[key] = row.value;
				linkCnt[key] = 1;
				linkKeys.push({ key: key, source: row.source, target: row.target });
			} else {
				if (metric === "min") {
					linkMap[key] = Math.min(linkMap[key], row.value);
				} else if (metric === "max") {
					linkMap[key] = Math.max(linkMap[key], row.value);
				} else {
					linkMap[key] += row.value;
				}
				linkCnt[key]++;
			}
		}
		if (metric === "avg") {
			for (var k in linkMap) {
				if (linkMap.hasOwnProperty(k)) {
					linkMap[k] = linkMap[k] / linkCnt[k];
				}
			}
		}

		var links = [];
		for (var j = 0; j < linkKeys.length; j++) {
			var lk = linkKeys[j];
			var val = linkMap[lk.key];
			if (val === undefined || val === null) {
				val = 0;
			}
			var link = { source: lk.source, target: lk.target };
			if (val) {
				link.value = val;
				nodeWeight[lk.source] += Math.abs(val);
				nodeWeight[lk.target] += Math.abs(val);
			} else {
				nodeWeight[lk.source] += 1;
				nodeWeight[lk.target] += 1;
			}
			links.push(link);
		}

		var parsedColors = this._parseColors(cfg.colors);
		var nodes = [];
		for (var n = 0; n < nodeOrder.length; n++) {
			var id = nodeOrder[n];
			var entry = { id: "" + id, label: nodeLabel[id] };
			if (nodeGroup[id]) {
				entry.group = nodeGroup[id];
			}
			if (nodeWeight[id]) {
				entry.value = nodeWeight[id];
			}
			var color = this._colorFor(parsedColors, nodeGroup[id] || id, n);
			if (color) {
				entry.color = color;
			}
			nodes.push(entry);
		}
		return { nodes: nodes, links: links };
	},

	_parseColors: function (colors) {
		if (!colors) {
			return null;
		}
		if (typeof colors === "string") {
			var s = colors.replace(/^\s+|\s+$/g, "");
			if (!s) {
				return null;
			}
			try {
				colors = JSON.parse(s);
			} catch (e) {
				colors = s.split(",");
				for (var i = 0; i < colors.length; i++) {
					colors[i] = colors[i].replace(/^\s+|\s+$/g, "");
				}
			}
		}
		if (Object.prototype.toString.call(colors) === "[object Array]") {
			return { type: "array", value: colors };
		}
		if (typeof colors === "object") {
			return { type: "map", value: colors };
		}
		return null;
	},

	_colorFor: function (parsed, label, index) {
		if (!parsed) {
			return null;
		}
		if (parsed.type === "array") {
			if (!parsed.value.length) {
				return null;
			}
			return parsed.value[index % parsed.value.length];
		}
		if (parsed.type === "map") {
			return parsed.value[label] || null;
		}
		return null;
	},

	_readField: function (obj, field) {
		if (!field) {
			return "";
		}
		var v = obj[field];
		if (v && typeof v === "object") {
			if (typeof v.getDisplayValue === "function") {
				return v.getDisplayValue();
			}
			if (v.displayValue !== undefined) {
				return v.displayValue;
			}
			if (v.value !== undefined) {
				return v.value;
			}
		}
		return v === undefined || v === null ? "" : v;
	},

	_str: function (v) {
		return v === undefined || v === null
			? ""
			: ("" + v).replace(/^\s+|\s+$/g, "");
	},

	_blank: function (v) {
		var s = v === undefined || v === null ? "" : "" + v;
		return s === "" ? "(empty)" : s;
	},

	type: "D3GraphData",
};
