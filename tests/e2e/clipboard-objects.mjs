/**
 * Design objects on the system clipboard: copy in one editor window, paste into ANOTHER editor window (another template),
 * ignore foreign text, and keep working when the clipboard holds damaged text. In the real app (headless Chromium).
 */
import { check, drag, editorDoc, eq, ok, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page } = t;

async function newTemplate(p, name) {
  await p.goto(t.url + '/#/templates');
  await p.getByRole('button', { name: /New template/ }).click();
  await p.getByRole('dialog').getByLabel('Name').fill(name);
  await p.getByRole('button', { name: /Create and open/ }).click();
  await p.waitForSelector('.ed .canvas-container');
  await waitIdle(p, 600);
}

/** A copy / paste event with a clipboard text, as the browser raises it for Ctrl+C / Ctrl+V. */
const pasteText = (p, text) => p.evaluate((txt) => { const dt = new DataTransfer(); dt.setData('text/plain', txt); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, text);

let payload = '';
await check('copy an object in window 1: the clipboard event carries it as text', async () => {
  await newTemplate(page, 'Clipboard source');
  await page.getByRole('button', { name: /^Rectangle/ }).click();
  await drag(page, [101, 103], [401, 303]);
  eq((await editorDoc(page)).nodes.length, 1);
  payload = await page.evaluate(() => { const dt = new DataTransfer(); const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }); document.dispatchEvent(ev); return dt.getData('text/plain'); });
  ok(payload.startsWith('{"dceClipboard":1'), 'the text is a DCE payload: ' + payload.slice(0, 40));
  ok(JSON.parse(payload).nodes[0].type === 'rect', 'it holds the rectangle');
});

await check('paste it in window 2 (a different template, its own in-memory state): the object appears, offset, selected', async () => {
  const page2 = await page.context().newPage();
  await newTemplate(page2, 'Clipboard target');
  eq((await editorDoc(page2)).nodes.length, 0);
  await pasteText(page2, payload);
  await waitIdle(page2, 400);
  const doc = await editorDoc(page2);
  eq(doc.nodes.length, 1);
  eq(doc.nodes[0].type, 'rect');
  eq([doc.nodes[0].x, doc.nodes[0].y], [124, 124]);                                       // 100 + 24: the first paste is offset
  ok(doc.nodes[0].id !== JSON.parse(payload).nodes[0].id, 'the pasted object has a new id');
  await pasteText(page2, payload);                                                         // the same payload again moves further
  await waitIdle(page2, 400);
  const doc2 = await editorDoc(page2);
  eq(doc2.nodes.length, 2); eq([doc2.nodes[1].x, doc2.nodes[1].y], [148, 148]);
  await pasteText(page2, 'some words copied from a web page');                            // foreign text: nothing happens
  await pasteText(page2, '{"dceClipboard":1,"nodes":[{"type":"bogus"}]}');                // damaged payload: nothing happens
  await waitIdle(page2, 300);
  eq((await editorDoc(page2)).nodes.length, 2);
  await page2.close();
});

await check('a real Ctrl+C then Ctrl+V in the same window still works (the older behaviour)', async () => {
  const before = (await editorDoc(page)).nodes.length;
  await page.getByRole('treeitem', { name: /Layer Rectangle/ }).first().click();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  eq((await editorDoc(page)).nodes.length, before + 1);
});

await t.close();
process.exit(0);
