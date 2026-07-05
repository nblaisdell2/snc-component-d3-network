import "../src/x-2114311-network-chart-uic";
import { mountDevHarness } from "./dev-harness";

// Local dev-server entry — DEV ONLY, never deployed. Mounts the UI-Builder-style
// controls harness (collapsible right drawer of property controls + event log)
// around the component. To preview the bare component instead, comment out the
// mountDevHarness() call and uncomment the plain-element block below.
mountDevHarness(document.body);

// const el = document.createElement('DIV');
// document.body.appendChild(el);
// el.innerHTML = `<x-2114311-network-chart-uic></x-2114311-network-chart-uic>`;
