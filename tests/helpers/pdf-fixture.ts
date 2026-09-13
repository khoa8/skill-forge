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

export function pdfFixture(pages: string[][] = [PDF_GUIDE], options: { activeContent?: boolean; encrypted?: boolean; externalCMap?: boolean } = {}): Buffer {
  const { activeContent, encrypted, externalCMap } = options;
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R${activeContent ? ' /OpenAction << /S /JavaScript /JS (globalThis.pdfExecuted = true) >>' : ''} >>`,
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    externalCMap
      ? `<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [${4 + pages.length * 2} 0 R] >>`
      : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, lines] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R${activeContent ? ' /AA << /O << /S /URI /URI (https://example.invalid/resource) >> >>' : ''} >>`);
    const content = "BT /F1 12 Tf 14 TL 50 740 Td\n" + lines.map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`).join("\n") + "\nET";
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if (externalCMap) {
    objects.push(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /FontDescriptor ${5 + pages.length * 2} 0 R /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> >>`);
    objects.push("<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 4 /Ascent 880 /Descent -120 /CapHeight 700 /ItalicAngle 0 /StemV 80 /FontBBox [0 -200 1000 900] >>");
  }
  // A syntactically valid Standard security dictionary with unknown keys:
  // a password is required before the unencrypted page streams can be read.
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> >>`);
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
