import { notify } from './store';

/**
 * Copies text to the clipboard and says so in a toast. Falls back to a hidden text area where the Clipboard API is
 * refused (for example on an insecure page or in an older browser).
 */
export async function copyText(text: string, done = 'Copied to the clipboard.'): Promise<boolean> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
  }
  notify(ok ? 'success' : 'error', ok ? done : 'The text could not be copied. Select it and press Ctrl+C.');
  return ok;
}
