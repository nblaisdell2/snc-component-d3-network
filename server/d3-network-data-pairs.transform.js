/**
 * Script for the "D3 Network Data (Field pairs)" Transform data resource
 * (table: sys_ux_data_broker_transform, "Mutates server data" = false).
 *
 * Paste this into the data resource's Script field. `input` is an object whose
 * keys are the data resource's Properties (see d3-network-data-pairs.properties.json).
 * Bind the output via @data.<data_resource_name>.output to "Data · Graph data".
 *
 * Builds a { nodes, links } graph by grouping ONE table on two fields — links
 * connect the two category values, weighted by count/metric (the undirected
 * sibling of the Sankey's aggregate). Logic lives in the global D3GraphData
 * Script Include.
 */
function transform(input) {
	return new global.D3GraphData().fromAggregate(input);
}
