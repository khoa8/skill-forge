/** Original, deterministic PDF 1.4 fixtures; no external documents/libraries. */
export const PDF_GUIDE = [
  "# Widget API Guide",
  "Widget API processes widget configuration files and reports errors.",
  "## Setup",
  "1. Create a token.",
  "2. Configure the client.",
  "3. Send a request.",
  "Important: keep the token secret.",
  '<div class="example">Literal markup &amp; stays text.</div>',
];

export function pdfFixture(pages: string[][] = [PDF_GUIDE], activeContent = false): Buffer {
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R${activeContent ? ' /OpenAction << /S /JavaScript /JS (globalThis.pdfExecuted = true) >>' : ''} >>`,
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, lines] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R${activeContent ? ' /AA << /O << /S /URI /URI (https://example.invalid/resource) >> >>' : ''} >>`);
    const content = "BT /F1 12 Tf 14 TL 50 740 Td\n" + lines.map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`).join("\n") + "\nET";
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
