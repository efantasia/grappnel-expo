import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

// Writes text to a temporary file and opens the OS share sheet so the user can
// save or send it. The web sibling (download.web.ts) triggers a real browser
// download instead. Throws on failure so callers can surface an error.
export async function downloadTextFile(
  filename: string,
  content: string,
): Promise<void> {
  const uri = `${FileSystem.cacheDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(uri, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(uri, {
    mimeType: 'text/plain',
    dialogTitle: filename,
    UTI: 'public.plain-text',
  });
}

// Downloads a remote file (e.g. a signed GCS URL) to the cache directory and
// opens the OS share sheet so the user can save or send it. The web sibling
// hands the URL straight to the browser instead.
export async function downloadFileFromUrl(
  filename: string,
  url: string,
  mimeType: string,
): Promise<void> {
  const target = `${FileSystem.cacheDirectory}${filename}`;
  const result = await FileSystem.downloadAsync(url, target);
  if (result.status !== 200) {
    throw new Error(`Download failed (HTTP ${result.status}).`);
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(result.uri, { mimeType, dialogTitle: filename });
}
