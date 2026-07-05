# server/

Platform-side sources for binding real data to the **D3 Network Graph** component.
Create these as records on the instance — they are NOT shipped by
`snc ui-component deploy`; the `server/` files are the version-controlled source.

The component's `data` property is a GRAPH object
`{ nodes: [ { id, label?, group?, value?, color? } ], links: [ { source, target,
value? } ] }` (link `source`/`target` reference a node `id`). This is the
UNDIRECTED, force-laid-out sibling of the Sankey: `D3SankeyData` emits directed
flow ribbons between staged nodes, while **`D3GraphData`** emits a node/link set
for a force simulation.

| File | What it is |
|---|---|
| `D3GraphData.js` | Script Include — `fromRelationship()`, `fromAggregate()`, `fromRows()` |
| `d3-network-data-rel.transform.js` | Relationship/edge-table data resource script |
| `d3-network-data-rel.properties.json` | Relationship inputs (bare array) |
| `d3-network-data-pairs.transform.js` | Field-pair aggregate data resource script |
| `d3-network-data-pairs.properties.json` | Field-pair inputs (bare array) |
| `sanity-test.background.js` | Logs the { nodes, links } JSON to verify the shape |

## Two data brokers — why

A graph can be sourced two ways:

- **`d3-network-data-rel`** (relationship table): each record of an edge table is
  a relationship with a **source reference** and a **target reference** (e.g.
  `cmdb_rel_ci` parent/child). Nodes are derived from the distinct endpoints; each
  node's `group` comes from a (dot-walked) type field and its `value` from the
  total weight of its links.
- **`d3-network-data-pairs`** (field-pair aggregate): group ONE table by two
  fields and connect their values, weighted by count/metric — co-occurrence (e.g.
  assignment group ↔ category).

Both produce the same `{ nodes, links }`. Self-loops (source == target) are
dropped because the force layout can't draw them cleanly. Create whichever you
need (or both); each broker needs its **own** execute ACL.

## Setup (one time)

1. **Create the Script Include.** *System Definition → Script Includes → New*.
   Name it `D3GraphData`, **Accessible from = All application scopes**,
   **Client callable = false**, paste `D3GraphData.js`. Save.
2. **Create the Transform data resource(s).** In UI Builder: **Add data resource →
   Transform**, **Mutates server data** unchecked. Paste the matching
   `*.transform.js` into **Script** and the matching **bare JSON array**
   (`*.properties.json`) into **Properties** (must be just the `[ … ]` array).
3. **Create the execute ACL** (required — else "ACL failed for databroker"):
   broker **sys_id** from `sys_ux_data_broker_transform.list`; elevate to
   **security_admin**; **System Security → Access Control (ACL) → New**: Type =
   `ux_data_broker`, Operation = `execute`, Name = the broker sys_id (padlock →
   free text), Active = true, one permissive criterion (e.g. `UserIsAuthenticated`).

## Bind it

In UI Builder, set the component's **Data · Graph data** property to
`@data.<resource_name>.output` (e.g. `@data.d3_network_data_rel.output`). The
component colours nodes by `group` automatically.

## Entry-point inputs

- `fromRelationship(cfg)`: `table`, `filter`, `sourceField`, `targetField`,
  `sourceGroupField?`, `targetGroupField?`, `linkValueField?`, `useDisplayValue`,
  `recordLimit`.
- `fromAggregate(cfg)`: `table`, `filter`, `sourceField`, `targetField`, `metric`
  (count/sum/avg/min/max), `valueField`, `useDisplayValue`.
- `fromRows(rows, cfg)`: `sourceField`, `targetField`, `valueField?`,
  `sourceLabelField?`, `targetLabelField?`, `sourceGroupField?`,
  `targetGroupField?`, `metric` (combine dup links; default sum).

## Verify

Run `sanity-test.background.js` in *Scripts - Background* (Global scope) to log
the `{ nodes, links }` JSON before wiring it into a page.

> These are **platform records** (Script Include / data resources / ACLs), not
> part of the component bundle. The `server/` files are the version-controlled
> source.
