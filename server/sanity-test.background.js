/**
 * Sanity test for the D3GraphData Script Include.
 * Run in System Definition → Scripts - Background (Global scope) AFTER creating
 * the D3GraphData Script Include. Logs the { nodes, links } JSON so you can
 * confirm the shape before wiring it in. Adjust cfg to your data.
 */
(function () {
	var api = new global.D3GraphData();

	gs.info("--- fromRelationship: CMDB dependency map (cmdb_rel_ci) ---");
	gs.info(
		JSON.stringify(
			api.fromRelationship({
				table: "cmdb_rel_ci",
				sourceField: "parent",
				targetField: "child",
				sourceGroupField: "parent.sys_class_name",
				targetGroupField: "child.sys_class_name",
				recordLimit: 200,
			}),
			null,
			2,
		),
	);

	gs.info("--- fromAggregate: assignment_group <-> category co-occurrence ---");
	gs.info(
		JSON.stringify(
			api.fromAggregate({
				table: "incident",
				sourceField: "assignment_group",
				targetField: "category",
				metric: "count",
			}),
			null,
			2,
		),
	);

	gs.info("--- fromRows: reshape plain edge objects ---");
	var rows = [
		{ from: "web", to: "app", n: 7 },
		{ from: "app", to: "db", n: 8 },
		{ from: "web", to: "app", n: 2 },
	];
	gs.info(
		JSON.stringify(
			api.fromRows(rows, { sourceField: "from", targetField: "to", valueField: "n" }),
			null,
			2,
		),
	);
})();
