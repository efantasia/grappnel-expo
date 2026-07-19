// Triggers a browser download of the given text as a file. Mirrors the native
// download.ts (which shares via the OS share sheet).
export async function downloadTextFile(
  filename: string,
  content: string,
): Promise<void> {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// Hands a signed URL to the browser; its Content-Disposition: attachment
// header makes this a download (the anchor download attribute is ignored
// cross-origin, so the header is what actually names the file).
export async function downloadFileFromUrl(
  filename: string,
  url: string,
  _mimeType: string,
): Promise<void> {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
