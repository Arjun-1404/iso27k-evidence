// What "download" hands back for a file whose real bytes the demo doesn't have: the sample files that came with the demo,
// and files uploaded before the tab was reloaded (uploaded bytes are kept in memory only, never saved).

/** A one-page PDF that really opens, saying what it is. ASCII only, so the byte offsets below are exact. */
export function minimalPdf(lines: string[]): Uint8Array {
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, "\\$&");
  const stream = ["BT", "/F1 13 Tf", "72 740 Td", "20 TL", ...lines.map((l, i) => `${i === 0 ? "" : "T* "}(${ascii(l)}) Tj`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export function placeholderFile(fileName: string, controlLabel: string): Blob {
  const lines = [
    "Sample evidence file (demo)",
    "",
    `File: ${fileName}`,
    `Control: ${controlLabel}`,
    "",
    "This is a made-up file from the demo of the ISO 27001 evidence portal.",
    "It holds no real data. In a real installation this would be the document",
    "someone uploaded, served from your own storage.",
  ];
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return new Blob([minimalPdf(lines) as BlobPart], { type: "application/octet-stream" });
  if (lower.endsWith(".csv")) return new Blob([`note,value\n"Sample evidence file (demo)",""\n"${fileName.replace(/"/g, "'")}","${controlLabel.replace(/"/g, "'")}"\n"No real data in this file",""\n`], { type: "application/octet-stream" });
  return new Blob([`${lines.join("\n")}\n`], { type: "application/octet-stream" });
}
