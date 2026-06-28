/*
 * Dev-harness controls — DEV ONLY. Never deployed.
 *
 * A UI-Builder-style "controls" panel around the component so you can exercise
 * every property locally (and watch dispatched events fire) without an instance.
 *
 * WHY IT IS SAFE TO KEEP IN THE REPO: `snc ui-component develop` uses
 * example/element.js as the webpack dev-server entry, and that file is the only
 * thing that imports this module. The deployable component is defined by
 * now-ui.json (scopeName + components -> src/<tag>), which does NOT reference
 * example/, so nothing under example/ is ever packaged by generate-update-set /
 * deploy.
 *
 * DROP-IN: this file is component-agnostic. It reads the component tag, the
 * property list, and the action list from ../now-ui.json, and seeds each control
 * from the element's own runtime defaults. Copy it into any snc UI-component
 * project's example/ folder unchanged — no edits required. Add a property to
 * now-ui.json and a matching control appears here automatically.
 *
 * STYLING NOTE: the snc webpack pipeline only injects the COMPONENT's .scss (via
 * `import styles from './styles.scss'` -> createCustomElement). A plain
 * `import './x.css'` is NOT given a style-loader and never reaches the DOM, so
 * the harness CSS is injected here as a <style> tag (see DH_STYLES) instead.
 */

import nowUi from '../now-ui.json';

/* The component under test = the first component declared in the manifest. */
const TAG = Object.keys((nowUi && nowUi.components) || {})[0];
const componentDef = (nowUi.components && nowUi.components[TAG]) || {};
const PROP_DEFS = componentDef.properties || [];
const ACTION_DEFS = componentDef.actions || [];

/* Tiny DOM helper: h('div', { class: 'x' }, [childNodes | strings]). */
const h = (tag, attrs = {}, kids = []) => {
	const el = document.createElement(tag);
	Object.entries(attrs).forEach(([k, v]) => {
		if (v == null) return;
		if (k === 'class') el.className = v;
		else if (k === 'text') el.textContent = v;
		else el.setAttribute(k, v);
	});
	(Array.isArray(kids) ? kids : [kids]).forEach((kid) => {
		if (kid == null) return;
		el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	});
	return el;
};

/* "Layout · Orientation" -> { group: 'Layout', label: 'Orientation' }. */
const splitLabel = (label, name) => {
	const raw = label || name;
	const idx = raw.indexOf('·');
	if (idx === -1) return { group: 'General', label: raw.trim() };
	return { group: raw.slice(0, idx).trim(), label: raw.slice(idx + 1).trim() };
};

const isColorProp = (def) =>
	/colou?r/i.test(def.name) && def.fieldType === 'string';

const looksLikeHex = (v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '').trim());

export function mountDevHarness(root = document.body) {
	injectStyles();
	root.innerHTML = '';

	if (!TAG) {
		root.appendChild(h('div', { class: 'dh-fatal', text: 'dev-harness: no component found in now-ui.json' }));
		return;
	}

	// Live values + the element instance every control writes to.
	const values = {};
	const el = document.createElement(TAG);

	const apply = (name, value) => {
		values[name] = value;
		el[name] = value; // ui-core property accessor -> re-render
	};

	/* Seed a control's starting value from the element's own runtime default
	 * (best effort — ui-core may expose it pre-connection), then the manifest
	 * defaultValue, then a type fallback. */
	const initialValue = (def) => {
		const live = el[def.name];
		if (live !== undefined && live !== null) return live;
		if (def.defaultValue !== undefined) return def.defaultValue;
		if (def.fieldType === 'boolean') return false;
		if (def.fieldType === 'number') return 0;
		if (def.fieldType === 'json') return [];
		return '';
	};

	/* ---- main stage: ONLY the component ---- */
	const stage = h('div', { class: 'dh-stage dh-bg-light' }, [el]);

	/* ---- background switcher (in the drawer, drives the stage) ---- */
	const bgSeg = h('div', { class: 'dh-seg' });
	[
		['light', 'Light'],
		['dark', 'Dark'],
		['grid', 'Grid']
	].forEach(([key, lbl], i) => {
		const b = h('button', { text: lbl, type: 'button' });
		if (i === 0) b.classList.add('dh-on');
		b.addEventListener('click', () => {
			stage.className = `dh-stage dh-bg-${key}`;
			bgSeg.querySelectorAll('button').forEach((x) => x.classList.remove('dh-on'));
			b.classList.add('dh-on');
		});
		bgSeg.appendChild(b);
	});

	/* ---- event log ---- */
	const logList = h('div', { class: 'dh-log-list' }, [
		h('div', { class: 'dh-log-empty', text: 'No events yet — interact with the component.' })
	]);
	let logCount = 0;
	const pushLog = (name, detail) => {
		if (logCount === 0) logList.innerHTML = '';
		logCount += 1;
		const time = new Date().toLocaleTimeString();
		logList.prepend(
			h('div', { class: 'dh-log-row' }, [
				h('span', { class: 'dh-log-time', text: time }),
				h('span', { class: 'dh-log-name', text: name }),
				h('span', { text: safeJson(detail) })
			])
		);
	};
	const clearLog = () => {
		logCount = 0;
		logList.innerHTML = '';
		logList.appendChild(h('div', { class: 'dh-log-empty', text: 'No events yet — interact with the component.' }));
	};

	// Listen for every action declared in the manifest.
	ACTION_DEFS.forEach((a) => {
		el.addEventListener(a.name, (e) => pushLog(a.name, (e.detail && e.detail.payload) || e.detail));
	});

	const logSection = h('div', { class: 'dh-log' }, [
		h('div', { class: 'dh-log-head' }, [
			h('span', { text: `Events · ${ACTION_DEFS.map((a) => a.name).join(', ') || 'none'}` }),
			(() => {
				const b = h('button', { class: 'dh-btn dh-btn-sm', text: 'Clear', type: 'button' });
				b.addEventListener('click', clearLog);
				return b;
			})()
		]),
		logList
	]);

	// Build a control for one property def.
	const buildField = (def) => {
		const { label } = splitLabel(def.label, def.name);
		const field = h('div', { class: 'dh-field' });

		// boolean -> checkbox (label beside the box)
		if (def.fieldType === 'boolean') {
			const id = `dh-${def.name}`;
			const box = h('input', { type: 'checkbox', id });
			box.checked = values[def.name] === true;
			box.addEventListener('change', () => apply(def.name, box.checked));
			field.appendChild(h('div', { class: 'dh-bool' }, [box, h('label', { for: id, text: label })]));
			if (def.description) field.appendChild(h('p', { class: 'dh-desc', text: def.description }));
			return field;
		}

		field.appendChild(h('label', { class: 'dh-field-label', text: label }));
		if (def.description) field.appendChild(h('p', { class: 'dh-desc', text: def.description }));

		// choice -> select
		if (def.fieldType === 'choice') {
			const sel = h('select');
			const choices = (def.typeMetadata && def.typeMetadata.choices) || [];
			choices.forEach((c) => {
				const opt = h('option', { value: c.value, text: c.label });
				if (c.value === values[def.name]) opt.selected = true;
				sel.appendChild(opt);
			});
			sel.addEventListener('change', () => apply(def.name, sel.value));
			field.appendChild(sel);
			return field;
		}

		// number -> numeric input
		if (def.fieldType === 'number') {
			const input = h('input', { type: 'number', value: String(values[def.name] ?? '') });
			input.addEventListener('input', () => {
				const raw = input.value;
				apply(def.name, raw === '' ? undefined : Number(raw));
			});
			field.appendChild(input);
			return field;
		}

		// json -> textarea (parsed on input)
		if (def.fieldType === 'json') {
			const ta = h('textarea', { spellcheck: 'false' });
			ta.value = safeJson(values[def.name], 2);
			const err = h('div', { class: 'dh-err' });
			ta.addEventListener('input', () => {
				try {
					const parsed = JSON.parse(ta.value);
					ta.classList.remove('dh-invalid');
					err.textContent = '';
					apply(def.name, parsed);
				} catch (ex) {
					ta.classList.add('dh-invalid');
					err.textContent = `Invalid JSON: ${ex.message}`;
				}
			});
			field.appendChild(ta);
			field.appendChild(err);
			return field;
		}

		// string -> text input (+ color picker for *color props)
		const text = h('input', { type: 'text', value: values[def.name] || '' });
		if (isColorProp(def)) {
			const color = h('input', { type: 'color' });
			if (looksLikeHex(values[def.name])) color.value = values[def.name];
			color.addEventListener('input', () => {
				text.value = color.value;
				apply(def.name, color.value);
			});
			text.addEventListener('input', () => {
				if (looksLikeHex(text.value)) color.value = text.value.trim();
				apply(def.name, text.value);
			});
			field.appendChild(h('div', { class: 'dh-color' }, [color, text]));
			return field;
		}

		text.addEventListener('input', () => apply(def.name, text.value));
		field.appendChild(text);
		return field;
	};

	// Group fields by label prefix, preserving manifest order.
	const groups = [];
	const byGroup = Object.create(null);
	PROP_DEFS.forEach((def) => {
		values[def.name] = initialValue(def); // seed live value
		const { group } = splitLabel(def.label, def.name);
		if (!byGroup[group]) {
			byGroup[group] = h('div', { class: 'dh-fields' });
			groups.push({ group, body: byGroup[group] });
		}
		byGroup[group].appendChild(buildField(def));
	});

	const sectionEls = groups.map(({ group, body }, i) => {
		const details = h('details', { class: 'dh-section' });
		if (i < 3) details.setAttribute('open', '');
		details.appendChild(
			h('summary', {}, [
				h('span', { class: 'dh-section-title', text: group }),
				h('span', { class: 'dh-chevron', 'aria-hidden': 'true' })
			])
		);
		details.appendChild(body);
		return details;
	});

	/* ---- drawer (right, collapsible) ---- */
	const resetBtn = h('button', { class: 'dh-btn', text: 'Reset to defaults', type: 'button' });
	resetBtn.addEventListener('click', () => mountDevHarness(root));

	const collapseBtn = h('button', {
		class: 'dh-collapse',
		type: 'button',
		title: 'Collapse panel',
		'aria-label': 'Collapse panel',
		text: '⟩'
	});

	const drawer = h('aside', { class: 'dh-drawer' }, [
		h('div', { class: 'dh-drawer-head' }, [
			h('span', { class: 'dh-drawer-title', text: 'Properties' }),
			collapseBtn
		]),
		h('div', { class: 'dh-drawer-body' }, [
			h('div', { class: 'dh-tool' }, [h('span', { class: 'dh-tool-label', text: 'Stage background' }), bgSeg]),
			h('div', { class: 'dh-toolbar' }, [resetBtn]),
			...sectionEls,
			logSection
		])
	]);

	// Always-visible handle to reopen when collapsed.
	const handle = h('button', {
		class: 'dh-handle',
		type: 'button',
		title: 'Toggle properties panel',
		'aria-label': 'Toggle properties panel',
		text: 'Properties'
	});

	const wrap = h('div', { class: 'dh-wrap dh-open' }, [stage, drawer, handle]);
	const toggle = () => wrap.classList.toggle('dh-open');
	collapseBtn.addEventListener('click', toggle);
	handle.addEventListener('click', toggle);

	/* ---- assemble + push initial values ---- */
	root.appendChild(wrap);
	PROP_DEFS.forEach((def) => apply(def.name, values[def.name]));
}

/* JSON.stringify that never throws (handles cyclic / odd values gracefully). */
function safeJson(v, indent) {
	try {
		return JSON.stringify(v, null, indent || 0);
	} catch (e) {
		return String(v);
	}
}

/* Inject the harness stylesheet once (plain CSS imports are not loaded here). */
function injectStyles() {
	if (document.getElementById('dh-styles')) return;
	const style = document.createElement('style');
	style.id = 'dh-styles';
	style.textContent = DH_STYLES;
	document.head.appendChild(style);
}

/* ---------------------------------------------------------------------------
 * Harness stylesheet (injected as a <style> tag — see injectStyles()).
 * All selectors are `dh-`-prefixed so they can never collide with a component's
 * own classes.
 * ------------------------------------------------------------------------- */
const DH_STYLES = `
:root {
	--dh-border: #e2e8f0;
	--dh-bg: #f1f5f9;
	--dh-panel: #ffffff;
	--dh-panel-2: #f8fafc;
	--dh-text: #0f172a;
	--dh-muted: #64748b;
	--dh-accent: #2563eb;
	--dh-accent-soft: #eff6ff;
	--dh-danger: #dc2626;
	--dh-radius: 8px;
	--dh-shadow: 0 0 24px rgba(15, 23, 42, 0.12);
	--dh-drawer-w: 372px;
}

html, body {
	margin: 0;
	/* The off-screen collapsed drawer (translateX) and any wide popups the
	   component renders would otherwise extend the page's scroll width and add a
	   phantom horizontal scrollbar / gray gutter. Clip horizontally only. */
	overflow-x: clip;
}
body {
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	color: var(--dh-text);
	background: var(--dh-bg);
}
.dh-wrap, .dh-wrap * { box-sizing: border-box; }

.dh-fatal { padding: 24px; color: var(--dh-danger); font-family: monospace; }

/* ---- Layout wrapper ---- */
.dh-wrap { position: relative; min-height: 100vh; }

/* ---- Stage (component only) ---- */
.dh-stage {
	min-height: 100vh;
	padding: 0;
	/* Reserve room for the open drawer with margin (not padding) so the component
	   stays flush to the top/left page edges; full width when collapsed. */
	margin-right: var(--dh-drawer-w);
	transition: margin-right 0.25s ease;
}
.dh-wrap:not(.dh-open) .dh-stage { margin-right: 0; }

.dh-stage.dh-bg-light { background: #ffffff; }
.dh-stage.dh-bg-dark { background: #0f172a; }
.dh-stage.dh-bg-grid {
	background-color: #fff;
	background-image:
		linear-gradient(45deg, #eef2f7 25%, transparent 25%),
		linear-gradient(-45deg, #eef2f7 25%, transparent 25%),
		linear-gradient(45deg, transparent 75%, #eef2f7 75%),
		linear-gradient(-45deg, transparent 75%, #eef2f7 75%);
	background-size: 20px 20px;
	background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}

/* ---- Drawer ---- */
.dh-drawer {
	position: fixed;
	top: 0;
	right: 0;
	width: var(--dh-drawer-w);
	height: 100vh;
	display: flex;
	flex-direction: column;
	background: var(--dh-panel);
	border-left: 1px solid var(--dh-border);
	box-shadow: var(--dh-shadow);
	transform: translateX(0);
	transition: transform 0.25s ease;
	z-index: 20;
}
.dh-wrap:not(.dh-open) .dh-drawer { transform: translateX(100%); }

.dh-drawer-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 14px 16px;
	border-bottom: 1px solid var(--dh-border);
	background: var(--dh-panel-2);
}
.dh-drawer-title {
	font-size: 13px;
	font-weight: 700;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--dh-muted);
}
.dh-collapse {
	font-size: 16px;
	line-height: 1;
	width: 30px;
	height: 30px;
	border: 1px solid var(--dh-border);
	background: #fff;
	border-radius: 6px;
	cursor: pointer;
	color: var(--dh-muted);
}
.dh-collapse:hover { border-color: var(--dh-accent); color: var(--dh-accent); }

.dh-drawer-body { flex: 1; overflow-y: auto; padding: 16px; }

/* ---- Reopen handle (visible when collapsed) ---- */
.dh-handle {
	position: fixed;
	top: 50%;
	right: 0;
	transform: translateY(-50%);
	writing-mode: vertical-rl;
	rotate: 180deg;
	padding: 14px 8px;
	font-size: 12px;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: #fff;
	background: var(--dh-accent);
	border: 0;
	border-radius: 8px 0 0 8px;
	box-shadow: var(--dh-shadow);
	cursor: pointer;
	z-index: 10;
	opacity: 0;
	pointer-events: none;
	transition: opacity 0.2s ease;
}
.dh-wrap:not(.dh-open) .dh-handle { opacity: 1; pointer-events: auto; }

/* ---- Buttons ---- */
.dh-btn {
	font: inherit;
	font-size: 13px;
	font-weight: 500;
	padding: 8px 12px;
	border: 1px solid var(--dh-border);
	background: var(--dh-panel);
	border-radius: 6px;
	cursor: pointer;
	transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.dh-btn:hover { border-color: var(--dh-accent); color: var(--dh-accent); background: var(--dh-accent-soft); }
.dh-btn-sm { font-size: 11px; padding: 4px 8px; }
.dh-toolbar { margin-bottom: 16px; }
.dh-toolbar .dh-btn { width: 100%; }

/* ---- Stage-background tool row ---- */
.dh-tool {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 10px 12px;
	margin-bottom: 12px;
	background: var(--dh-panel-2);
	border: 1px solid var(--dh-border);
	border-radius: var(--dh-radius);
}
.dh-tool-label { font-size: 12px; font-weight: 600; color: var(--dh-muted); }

.dh-seg {
	display: inline-flex;
	border: 1px solid var(--dh-border);
	border-radius: 6px;
	overflow: hidden;
	background: #fff;
}
.dh-seg button {
	font: inherit;
	font-size: 12px;
	padding: 5px 11px;
	border: 0;
	background: #fff;
	cursor: pointer;
	border-left: 1px solid var(--dh-border);
	color: var(--dh-text);
}
.dh-seg button:first-child { border-left: 0; }
.dh-seg button.dh-on { background: var(--dh-accent); color: #fff; }

/* ---- Sections (collapsible groups) ---- */
.dh-section {
	border: 1px solid var(--dh-border);
	border-radius: var(--dh-radius);
	margin-bottom: 10px;
	overflow: hidden;
	background: var(--dh-panel);
}
.dh-section > summary {
	display: flex;
	align-items: center;
	justify-content: space-between;
	cursor: pointer;
	padding: 11px 14px;
	background: var(--dh-panel-2);
	list-style: none;
	user-select: none;
}
.dh-section > summary::-webkit-details-marker { display: none; }
.dh-section-title {
	font-size: 12px;
	font-weight: 700;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--dh-muted);
}
.dh-chevron {
	width: 8px;
	height: 8px;
	border-right: 2px solid var(--dh-muted);
	border-bottom: 2px solid var(--dh-muted);
	transform: rotate(45deg);
	transition: transform 0.2s ease;
}
.dh-section[open] > summary { border-bottom: 1px solid var(--dh-border); }
.dh-section[open] > summary .dh-chevron { transform: rotate(-135deg); }
.dh-fields { padding: 14px; }

/* ---- Fields ---- */
.dh-field {
	padding-bottom: 14px;
	margin-bottom: 14px;
	border-bottom: 1px dashed var(--dh-border);
}
.dh-field:last-child { padding-bottom: 0; margin-bottom: 0; border-bottom: 0; }
.dh-field-label {
	display: block;
	font-size: 13px;
	font-weight: 600;
	color: var(--dh-text);
	margin-bottom: 4px;
}
.dh-desc { font-size: 11px; color: var(--dh-muted); margin: 0 0 7px; line-height: 1.4; }

.dh-field input[type='text'],
.dh-field input[type='number'],
.dh-field select,
.dh-field textarea {
	width: 100%;
	font: inherit;
	font-size: 13px;
	padding: 8px 10px;
	border: 1px solid var(--dh-border);
	border-radius: 6px;
	background: #fff;
	color: var(--dh-text);
	transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.dh-field input[type='text']:focus,
.dh-field input[type='number']:focus,
.dh-field select:focus,
.dh-field textarea:focus {
	outline: none;
	border-color: var(--dh-accent);
	box-shadow: 0 0 0 3px var(--dh-accent-soft);
}
.dh-field select {
	appearance: none;
	-webkit-appearance: none;
	background-image: linear-gradient(45deg, transparent 50%, var(--dh-muted) 50%),
		linear-gradient(135deg, var(--dh-muted) 50%, transparent 50%);
	background-position: calc(100% - 16px) 14px, calc(100% - 11px) 14px;
	background-size: 5px 5px, 5px 5px;
	background-repeat: no-repeat;
	padding-right: 30px;
	cursor: pointer;
}
.dh-field textarea {
	font-family: 'SF Mono', Menlo, Consolas, monospace;
	font-size: 12px;
	line-height: 1.5;
	min-height: 180px;
	resize: vertical;
	white-space: pre;
}
.dh-field textarea.dh-invalid { border-color: var(--dh-danger); background: #fef2f2; }
.dh-err { color: var(--dh-danger); font-size: 11px; margin-top: 5px; min-height: 14px; }

/* Boolean toggle row */
.dh-bool { display: flex; align-items: center; gap: 9px; }
.dh-bool input { width: 16px; height: 16px; accent-color: var(--dh-accent); cursor: pointer; }
.dh-bool > label { margin: 0; font-size: 13px; font-weight: 600; cursor: pointer; }

/* Color picker + text combo */
.dh-color { display: flex; gap: 8px; align-items: center; }
.dh-color input[type='color'] {
	width: 38px;
	height: 36px;
	padding: 0;
	border: 1px solid var(--dh-border);
	border-radius: 6px;
	background: #fff;
	cursor: pointer;
	flex: 0 0 auto;
}
.dh-color input[type='text'] { flex: 1; }

/* ---- Event log ---- */
.dh-log { margin-top: 16px; border: 1px solid var(--dh-border); border-radius: var(--dh-radius); overflow: hidden; }
.dh-log-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 9px 12px;
	font-size: 12px;
	font-weight: 700;
	letter-spacing: 0.03em;
	text-transform: uppercase;
	color: var(--dh-muted);
	background: var(--dh-panel-2);
	border-bottom: 1px solid var(--dh-border);
}
.dh-log-list {
	max-height: 220px;
	overflow: auto;
	margin: 0;
	padding: 8px 12px;
	font-family: 'SF Mono', Menlo, Consolas, monospace;
	font-size: 12px;
	background: #fff;
}
.dh-log-empty { color: var(--dh-muted); font-style: italic; }
.dh-log-row { padding: 4px 0; border-bottom: 1px dotted var(--dh-border); word-break: break-all; }
.dh-log-row:last-child { border-bottom: 0; }
.dh-log-time { color: var(--dh-muted); margin-right: 8px; }
.dh-log-name { color: var(--dh-accent); font-weight: 700; margin-right: 8px; }
`;
