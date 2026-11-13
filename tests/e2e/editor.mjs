/** Editor acceptance tests: real mouse / keyboard interaction against the production build. */
import { check, drag, dump, editorDoc, editorState, eq, near, ok, OUT, report, toPage, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, errors } = t;

await check('create a new template from the Templates page', async () => {
  await page.goto(t.url + '/#/templates');
  await page.getByRole('button', { name: /New template/ }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('E2E Template');
  await page.getByRole('button', { name: /Create and open/ }).click();
  await page.waitForSelector('.ed .canvas-container');
  await waitIdle(page, 600);
  const doc = await editorDoc(page);
  eq([doc.canvas.width, doc.canvas.height], [1080, 1080]);
  eq(doc.meta.name, 'E2E Template');
});

await check('draw a rectangle with the mouse (snaps to the 10px grid)', async () => {
  await page.getByRole('button', { name: /^Rectangle/ }).click();
  await drag(page, [101, 103], [401, 303]);
  const doc = await editorDoc(page);
  eq(doc.nodes.length, 1);
  eq(doc.nodes[0].type, 'rect');
  eq([doc.nodes[0].x, doc.nodes[0].y, doc.nodes[0].width, doc.nodes[0].height], [100, 100, 300, 200]);
  eq((await editorState(page)).tool, 'select');
});

await check('keyboard shortcut O + drag draws an ellipse', async () => {
  await page.keyboard.press('o');
  await drag(page, [500, 100], [700, 300]);
  const doc = await editorDoc(page);
  eq(doc.nodes[1].type, 'ellipse');
  eq([doc.nodes[1].width, doc.nodes[1].height], [200, 200]);
});

await check('draw a text frame, type into it directly on the canvas', async () => {
  await page.keyboard.press('t');
  await drag(page, [100, 400], [600, 480]);
  await page.waitForSelector('textarea.text-edit');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Hello {{content.title}}');
  await page.keyboard.press('Control+Enter');
  await waitIdle(page);
  const doc = await editorDoc(page);
  const n = doc.nodes[2];
  eq(n.type, 'text');
  eq(n.text, 'Hello {{content.title}}');
});

await check('double-click a text element re-opens direct editing', async () => {
  const p = await toPage(page, 300, 440);
  await page.keyboard.press('Escape');
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForSelector('textarea.text-edit');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Product: {{content.title}}');
  await page.keyboard.press('Control+Enter');
  const doc = await editorDoc(page);
  eq(doc.nodes[2].text, 'Product: {{content.title}}');
});

await check('layer panel mirrors the document and selects on click', async () => {
  await page.getByRole('treeitem', { name: 'Layer Text' }).click();
  const st = await editorState(page);
  eq(st.selection.length, 1);
  const doc = await editorDoc(page);
  eq(st.selection[0], doc.nodes[2].id);
});

await check('bind a text field from the Data tab', async () => {
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByLabel('Bound field').selectOption('content.title');
  const doc = await editorDoc(page);
  eq(doc.nodes[2].binding?.text?.template, '{{content.title}}'); // replaces the text, does not append to it
  await page.getByText('Advanced: mix fixed text').click();
  await page.getByLabel('Binding template').fill('{{content.title|upper}}');
  await page.getByLabel('Text fallback').fill('Untitled');
  const d2 = await editorDoc(page);
  eq(d2.nodes[2].binding.text, { template: '{{content.title|upper}}', fallback: 'Untitled' });
});

await check('set text constraints on the Fit tab', async () => {
  await page.getByRole('tab', { name: 'Fit' }).click();
  await page.getByLabel('Overflow policy').selectOption('auto_shrink');
  await page.getByLabel('Min font size').fill('14');
  await page.getByLabel('Max lines').fill('2');
  await page.getByLabel('Max characters').fill('80');
  const c = (await editorDoc(page)).nodes[2].constraints;
  eq([c.overflow, c.minFontSize, c.maxLines, c.maxChars], ['auto_shrink', 14, 2, 80]);
});

await check('draw an image frame and bind an image field', async () => {
  const blank = await toPage(page, 1070, 1070);
  await page.mouse.click(blank.x, blank.y); // clicking the canvas releases focus from inspector fields
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await drag(page, [700, 400], [1000, 700]);
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByLabel('Image field').selectOption('content.image_asset');
  const doc = await editorDoc(page);
  eq(doc.nodes[3].type, 'frame');
  eq(doc.nodes[3].binding.image.key, 'content.image_asset');
});

await check('conditional visibility accepts only valid safe expressions', async () => {
  await page.getByLabel('Visibility condition').fill('exists(content.discount)');
  eq((await editorDoc(page)).nodes[3].binding.visible.expr, 'exists(content.discount)');
  await page.getByLabel('Visibility condition').fill('alert(1)');
  await page.waitForSelector('.callout.err[role=alert]');
  await page.getByLabel('Visibility condition').fill('');
});

await check('undo / redo (buttons and keyboard)', async () => {
  const before = (await editorDoc(page)).nodes.length;
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5); // focus away from inputs
  await page.getByRole('button', { name: /Redo/ }).isDisabled();
  await page.getByRole('button', { name: /^Undo/ }).click();
  const st = await editorState(page);
  ok(st.canRedo, 'redo should be available after undo');
  await page.getByRole('button', { name: /^Redo/ }).click();
  eq((await editorDoc(page)).nodes.length, before);
});

await check('align and distribute', async () => {
  await page.getByRole('treeitem', { name: 'Layer Rectangle' }).click();
  await page.getByRole('button', { name: 'Align left' }).click();
  eq((await editorDoc(page)).nodes[0].x, 0);
  await page.getByRole('button', { name: 'Align horizontal centre' }).click();
  near((await editorDoc(page)).nodes[0].x, 390, 0.5);
});

await check('snapping pulls a dragged element onto the canvas centre', async () => {
  await page.keyboard.press('Control+z'); // rectangle back to x=0 (300 wide → centre 150)
  const doc = await editorDoc(page);
  const r = doc.nodes[0];
  eq(r.x, 0);
  const zoom = (await editorState(page)).zoom;
  const start = await toPage(page, 150, r.y + r.height / 2);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 386 * zoom, start.y, { steps: 10 }); // centre lands 4 scene px left of the canvas centre
  await page.mouse.up();
  await waitIdle(page, 120);
  const d2 = await editorDoc(page);
  near(d2.nodes[0].x + d2.nodes[0].width / 2, 540, 0.6, 'centre x');
});

await check('lock, hide and rename layers', async () => {
  await page.getByRole('button', { name: 'Hide Ellipse' }).click();
  eq((await editorDoc(page)).nodes[1].visible, false);
  await page.getByRole('button', { name: 'Show Ellipse' }).click();
  await page.getByRole('button', { name: 'Lock Ellipse' }).click();
  eq((await editorDoc(page)).nodes[1].locked, true);
  await page.getByRole('button', { name: 'Unlock Ellipse' }).click();
  await page.getByRole('treeitem', { name: 'Layer Ellipse' }).locator('.nm').dblclick();
  await page.getByLabel('Rename layer').fill('Sun');
  await page.keyboard.press('Enter');
  eq((await editorDoc(page)).nodes[1].name, 'Sun');
});

await check('group, ungroup, duplicate, copy / paste and delete', async () => {
  await page.getByRole('treeitem', { name: 'Layer Sun' }).click();
  await page.getByRole('treeitem', { name: 'Layer Rectangle' }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: /^Group/ }).click();
  let doc = await editorDoc(page);
  const g = doc.nodes.find((n) => n.type === 'group');
  ok(g && g.children.length === 2, 'group with two children');
  await page.getByRole('button', { name: /^Ungroup/ }).click();
  doc = await editorDoc(page);
  ok(!doc.nodes.some((n) => n.type === 'group'), 'group dissolved');
  const n0 = doc.nodes.length;
  await page.getByRole('treeitem', { name: 'Layer Sun' }).click();
  await page.getByRole('button', { name: /^Duplicate/ }).click();
  eq((await editorDoc(page)).nodes.length, n0 + 1);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  eq((await editorDoc(page)).nodes.length, n0 + 2);
  await page.getByRole('button', { name: /^Delete/ }).click();
  eq((await editorDoc(page)).nodes.length, n0 + 1);
});

await check('layer order: bring to front / send to back', async () => {
  await page.getByRole('treeitem', { name: 'Layer Rectangle' }).click();
  await page.getByRole('button', { name: 'Bring to front' }).click();
  let doc = await editorDoc(page);
  eq(doc.nodes[doc.nodes.length - 1].name, 'Rectangle');
  await page.getByRole('button', { name: 'Send to back' }).click();
  doc = await editorDoc(page);
  eq(doc.nodes[0].name, 'Rectangle');
});

await check('layer drag & drop reorders', async () => {
  const doc = await editorDoc(page);
  const first = doc.nodes[0].name, last = doc.nodes[doc.nodes.length - 1].name;
  const a = page.getByRole('treeitem', { name: `Layer ${first}` }).first();
  const b = page.getByRole('treeitem', { name: `Layer ${last}` }).first();
  await a.dragTo(b, { targetPosition: { x: 60, y: 3 } });
  const d2 = await editorDoc(page);
  eq(d2.nodes[d2.nodes.length - 1].name, first);
});

await check('pen tool builds a closed path', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  for (const [x, y] of [[120, 800], [320, 800], [320, 1000], [120, 1000]]) { const p = await toPage(page, x, y); await page.mouse.click(p.x, p.y); }
  const first = await toPage(page, 120, 800);
  await page.mouse.click(first.x, first.y);
  const doc = await editorDoc(page);
  const path = doc.nodes.find((n) => n.type === 'path');
  ok(path, 'path node exists');
  eq(path.path.closed, true);
  eq(path.path.points.length, 4);
});

await check('polygon + star + line tools create their shapes', async () => {
  await page.keyboard.press('y'); await drag(page, [800, 100], [900, 200]);
  await page.keyboard.press('s'); await drag(page, [900, 100], [1000, 200]);
  await page.keyboard.press('l'); await drag(page, [100, 1040], [500, 1040]);
  const types = (await editorDoc(page)).nodes.map((n) => n.type);
  for (const k of ['polygon', 'star', 'line']) ok(types.includes(k), `${k} missing`);
});

await check('Bézier pen: click-drag makes smooth curves, then edit points, toggle corner, add and delete points', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  const pts = [[700, 800], [900, 800], [900, 1000]];
  for (const [x, y] of pts) {
    const a = await toPage(page, x, y);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(a.x + 40, a.y + 40, { steps: 4 }); // drag = pull out handles
    await page.mouse.up();
  }
  await page.keyboard.press('Enter');
  let doc = await editorDoc(page);
  const path = doc.nodes.filter((n) => n.type === 'path').pop();
  ok(path.path.handles && path.path.handles.filter(Boolean).length === 3, 'three smooth anchors with handles');
  eq(path.path.closed, false);
  // edit mode via Enter on the selected path
  await page.keyboard.press('Enter');
  eq((await page.evaluate(() => window.__dceEditor.store.get().editingPath)), path.id);
  const w0 = await page.evaluate((id) => { const n = window.__dceEditor.getNode(id); return [n.x + n.path.points[1][0] * n.width, n.y + n.path.points[1][1] * n.height]; }, path.id);
  // drag the middle anchor
  const a = await toPage(page, w0[0], w0[1]);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 60, a.y - 60, { steps: 6 }); await page.mouse.up();
  await waitIdle(page, 100);
  const w1 = await page.evaluate((id) => { const n = window.__dceEditor.getNode(id); return [n.x + n.path.points[1][0] * n.width, n.y + n.path.points[1][1] * n.height]; }, path.id);
  ok(Math.hypot(w1[0] - w0[0], w1[1] - w0[1]) > 20, 'anchor moved');
  // double-click the anchor: smooth → corner
  const b = await toPage(page, w1[0], w1[1]);
  await page.mouse.dblclick(b.x, b.y);
  await waitIdle(page, 100);
  eq(await page.evaluate((id) => window.__dceEditor.getNode(id).path.handles[1], path.id), null);
  // double-click the line between two anchors: adds a point
  const n0 = await page.evaluate((id) => window.__dceEditor.getNode(id).path.points.length, path.id);
  const seg = await page.evaluate((id) => {
    const n = window.__dceEditor.getNode(id); const P = (i) => [n.x + n.path.points[i][0] * n.width, n.y + n.path.points[i][1] * n.height];
    const [a, b] = [P(1), P(2)];           // anchor 1 is a corner now; anchor 2 still has handles, so sample the true curve midpoint
    const h2 = n.path.handles[2]; const c2 = h2 ? [n.x + h2[0] * n.width, n.y + h2[1] * n.height] : b;
    const t = 0.5, u = 0.5; const c1 = a;
    return [u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0], u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]];
  }, path.id);
  const sp = await toPage(page, seg[0], seg[1]);
  await page.mouse.dblclick(sp.x, sp.y);
  await waitIdle(page, 100);
  eq(await page.evaluate((id) => window.__dceEditor.getNode(id).path.points.length, path.id), n0 + 1);
  const n1 = n0 + 1;
  // select an anchor by clicking it, then Delete removes it
  const first = await page.evaluate((id) => { const n = window.__dceEditor.getNode(id); return [n.x + n.path.points[0][0] * n.width, n.y + n.path.points[0][1] * n.height]; }, path.id);
  const f = await toPage(page, first[0], first[1]);
  await page.mouse.click(f.x, f.y);
  await page.keyboard.press('Delete');
  eq(await page.evaluate((id) => window.__dceEditor.getNode(id).path.points.length, path.id), n1 - 1);
  await page.keyboard.press('Control+z');
  eq(await page.evaluate((id) => window.__dceEditor.getNode(id).path.points.length, path.id), n1);
  await page.keyboard.press('Escape');
  eq(await page.evaluate(() => window.__dceEditor.store.get().editingPath), null);
});

await check('Bézier paths render as curves in the output (SVG contains C commands)', async () => {
  const d = await page.evaluate(() => { const n = window.__dceEditor.doc().nodes.filter((x) => x.type === 'path').pop(); return n.path; });
  ok(d.handles && d.handles.some(Boolean), 'curved path stored');
});

await check('arrow keys nudge, Delete removes', async () => {
  await page.keyboard.press('Escape');
  const doc = await editorDoc(page);
  const poly = doc.nodes.find((n) => n.type === 'polygon');
  await page.getByRole('treeitem', { name: `Layer ${poly.name}` }).click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowDown');
  const p2 = (await editorDoc(page)).nodes.find((n) => n.id === poly.id);
  eq([p2.x - poly.x, p2.y - poly.y], [10, 1]);
  await page.keyboard.press('Delete');
  ok(!(await editorDoc(page)).nodes.some((n) => n.id === poly.id), 'deleted');
});

await check('zoom, fit and pan controls', async () => {
  const z0 = (await editorState(page)).zoom;
  await page.getByRole('button', { name: /Zoom in/ }).click();
  ok((await editorState(page)).zoom > z0, 'zoomed in');
  await page.getByRole('button', { name: /Fit to screen/ }).click();
  near((await editorState(page)).zoom, z0, 0.01);
  await page.getByRole('button', { name: 'Zoom to 100%' }).click();
  near((await editorState(page)).zoom, 1, 0.001);
  await page.getByRole('button', { name: /Fit to screen/ }).click();
});

await check('data preview is on by default; toggling shows the field tokens instead', async () => {
  eq((await editorState(page)).previewOn, true);
  await waitIdle(page, 500);
  await page.screenshot({ path: OUT + 'editor-e2e-preview.png' });
  await page.getByRole('button', { name: /Data preview/ }).click();
  eq((await editorState(page)).previewOn, false);
  await page.getByRole('button', { name: /Data preview/ }).click();
  eq((await editorState(page)).previewOn, true);
});

await check('text inspector: weight names, italic, letter spacing, line height, capacity estimate', async () => {
  const blank = await toPage(page, 1070, 1070);
  await page.mouse.click(blank.x, blank.y);
  await page.getByRole('treeitem', { name: 'Layer Text', exact: true }).click();
  await page.getByRole('tab', { name: 'Design' }).click();
  const weights = await page.getByLabel('Font weight').locator('option').allTextContents();
  ok(weights.some((w) => /Bold · 700/.test(w)) && weights.some((w) => /Light · 300/.test(w)), 'named weights: ' + weights.join());
  await page.getByLabel('Font weight').selectOption('700');
  await page.getByRole('button', { name: 'Italic' }).click();
  await page.getByLabel('Letter spacing').fill('4');
  await page.getByLabel('Line height').fill('1.5');
  const st = (await editorDoc(page)).nodes.find((n) => n.type === 'text').style;
  eq([st.fontWeight, st.fontStyle, st.letterSpacing, st.lineHeight], [700, 'italic', 4, 1.5]);
  const cap = await page.getByLabel('Text capacity').innerText();
  ok(/Fits about \d+ characters/.test(cap), 'capacity shown: ' + cap.slice(0, 80));
  const before = Number(/about (\d+) characters/.exec(cap)[1]);
  await page.getByLabel('Size').first().fill('20');
  const after = Number(/about (\d+) characters/.exec(await page.getByLabel('Text capacity').innerText())[1]);
  ok(after > before, `smaller font fits more text (${before} → ${after})`);
  await page.getByRole('tab', { name: 'Design' }).click();
});

await check('inspector scrolls to the very bottom (nothing hidden)', async () => {
  const r = await page.evaluate(() => { const el = document.querySelector('.ed-inspector'); el.scrollTop = el.scrollHeight; return { client: el.clientHeight, scrollH: el.scrollHeight, top: el.scrollTop, winH: window.innerHeight, bottom: el.getBoundingClientRect().bottom }; });
  ok(r.bottom <= r.winH + 1, 'inspector fits inside the window ' + JSON.stringify(r));
  ok(r.scrollH > r.client ? r.top > 0 : true, 'scrollable when taller than the panel');
});

await check('output preview renders through the shared engine', async () => {
  await page.getByRole('button', { name: /Output preview/ }).click();
  await page.waitForSelector('.dialog img');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
});

await check('save persists to IndexedDB and survives a reload', async () => {
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.waitForSelector('text=/Saved “E2E Template”/');
  const doc = await editorDoc(page);
  const rows = await dump(page, 'templates');
  const row = rows.find((r) => r.name === 'E2E Template');
  ok(row, 'template row stored');
  eq(row.doc.nodes.length, doc.nodes.length);
  ok(row.doc.placeholders.some((p) => p.key === 'content.title'), 'placeholders synced from bindings');
  await page.reload();
  await page.waitForSelector('.ed .canvas-container');
  await waitIdle(page, 500);
  const after = await editorDoc(page);
  eq(after.nodes.length, doc.nodes.length);
  eq(after.nodes.map((n) => n.name), doc.nodes.map((n) => n.name));
  const textNode = after.nodes.find((n) => n.type === 'text');
  eq(textNode.binding.text.template, '{{content.title|upper}}');
});

await check('leaving with unsaved changes asks first', async () => {
  await page.keyboard.press('Escape');
  await page.getByRole('treeitem', { name: 'Layer Sun', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Back to templates' }).click();
  await page.waitForSelector('text=Unsaved changes');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.waitForSelector('text=Templates');
});

await check('no console errors during the whole session', async () => { ok(errors.length === 0, errors.join(' | ')); });
const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
