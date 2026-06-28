/**
 * Built-in sample data so the component renders something meaningful the moment
 * it is dropped onto a page, before the author binds the `data` property to a
 * real data resource. Mirrors the `data` default in index.js / now-ui.json.
 *
 * Shape: an OBJECT { nodes: [...], links: [...] } where:
 *   - nodes: [ { id, label?, group?, value?, color? } ]
 *       id    = unique identifier referenced by links
 *       label = display name (falls back to id)
 *       group = category used for the categorical color scale
 *       value = numeric weight (drives node radius when sizing by value)
 *   - links: [ { source, target, value? } ]
 *       source/target reference a node `id` (or a node index)
 *       value = numeric weight (drives link width when sizing by value)
 *
 * This is fundamentally different from the line/column chart's `series` array.
 * Here the graph is a set of related entities (a force-directed network), not a
 * set of categorical points.
 *
 * The sample below is a small ITSM / CMDB dependency map: a customer-facing web
 * application and the configuration items (CIs) it depends on -- load balancer,
 * application servers, a database cluster, caching, message queue, and the
 * underlying network -- grouped by CI type.
 */
const nodes = [
	{ id: 'web-portal', label: 'Customer Web Portal', group: 'Application', value: 95 },
	{ id: 'mobile-api', label: 'Mobile API Gateway', group: 'Application', value: 70 },
	{ id: 'lb-01', label: 'Load Balancer 01', group: 'Network', value: 60 },
	{ id: 'app-01', label: 'App Server 01', group: 'Server', value: 50 },
	{ id: 'app-02', label: 'App Server 02', group: 'Server', value: 50 },
	{ id: 'app-03', label: 'App Server 03', group: 'Server', value: 45 },
	{ id: 'cache-01', label: 'Redis Cache', group: 'Server', value: 35 },
	{ id: 'mq-01', label: 'Message Queue', group: 'Server', value: 30 },
	{ id: 'db-primary', label: 'DB Primary', group: 'Database', value: 80 },
	{ id: 'db-replica', label: 'DB Replica', group: 'Database', value: 55 },
	{ id: 'auth-svc', label: 'Auth Service', group: 'Application', value: 65 },
	{ id: 'core-switch', label: 'Core Switch', group: 'Network', value: 75 },
	{ id: 'firewall', label: 'Edge Firewall', group: 'Network', value: 68 }
];

const links = [
	{ source: 'firewall', target: 'lb-01', value: 8 },
	{ source: 'lb-01', target: 'web-portal', value: 9 },
	{ source: 'lb-01', target: 'mobile-api', value: 6 },
	{ source: 'web-portal', target: 'app-01', value: 7 },
	{ source: 'web-portal', target: 'app-02', value: 7 },
	{ source: 'mobile-api', target: 'app-02', value: 5 },
	{ source: 'mobile-api', target: 'app-03', value: 5 },
	{ source: 'web-portal', target: 'auth-svc', value: 6 },
	{ source: 'mobile-api', target: 'auth-svc', value: 6 },
	{ source: 'auth-svc', target: 'db-primary', value: 4 },
	{ source: 'app-01', target: 'cache-01', value: 4 },
	{ source: 'app-02', target: 'cache-01', value: 4 },
	{ source: 'app-01', target: 'mq-01', value: 3 },
	{ source: 'app-03', target: 'mq-01', value: 3 },
	{ source: 'app-01', target: 'db-primary', value: 8 },
	{ source: 'app-02', target: 'db-primary', value: 8 },
	{ source: 'app-03', target: 'db-primary', value: 6 },
	{ source: 'db-primary', target: 'db-replica', value: 9 },
	{ source: 'app-01', target: 'core-switch', value: 5 },
	{ source: 'app-02', target: 'core-switch', value: 5 },
	{ source: 'app-03', target: 'core-switch', value: 5 },
	{ source: 'db-primary', target: 'core-switch', value: 7 },
	{ source: 'core-switch', target: 'firewall', value: 6 }
];

export const SAMPLE_DATA = { nodes, links };
