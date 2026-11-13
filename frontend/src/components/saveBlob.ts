/**
 * Hands a downloaded file to the browser as a save-to-disk, under the name it was uploaded with.
 * Kept on its own so tests can stand in for it: a test environment has no real downloads.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName; // the name only; the browser decides the folder
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked a moment later: some browsers have not started reading the file the instant click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
