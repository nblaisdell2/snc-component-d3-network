# D3 Network Graph — UI Builder custom component

A configurable D3 chart for ServiceNow UI Builder.

- **Component tag:** `x-1295779-network-chart-uic`
- **Scope:** `x_1295779_network_0`
- **Renderer:** Seismic (`@servicenow/ui-renderer-snabbdom`) + D3 v7

## Develop & deploy
```bash
npm install
snc ui-component develop --open
snc ui-component deploy
```

Fill in the property list (`now-ui.json` + `index.js` defaults) and the D3 rendering
(`src/x-1295779-network-chart-uic/chart.js`), then document the properties and events here.
