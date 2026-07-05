/**
 * Script for the "D3 Network Data (Relationships)" Transform data resource
 * (table: sys_ux_data_broker_transform, "Mutates server data" = false).
 *
 * Paste this into the data resource's Script field. `input` is an object whose
 * keys are the data resource's Properties (see d3-network-data-rel.properties.json).
 * The returned value is the data resource output, bound in UI Builder via
 *   @data.<data_resource_name>.output
 * to the component's "Data · Graph data" property.
 *
 * Builds a { nodes, links } graph from an EDGE/relationship table (each record is
 * a relationship with a source reference and a target reference, e.g.
 * cmdb_rel_ci). Logic lives in the global D3GraphData Script Include.
 */
function transform(input) {
	return new global.D3GraphData().fromRelationship(input);
}
