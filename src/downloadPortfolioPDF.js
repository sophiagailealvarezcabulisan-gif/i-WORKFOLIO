import jsPDF from "jspdf";

function valueToText(value) {
  if (value == null || value === "") return "Not provided";

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(valueToText).join("\n");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !key.toLowerCase().includes("path"))
      .map(([key, item]) => `${key}: ${valueToText(item)}`)
      .join("\n");
  }

  return String(value);
}

export function downloadPortfolioPDF({ student = {}, entries = [] }) {
  const pdf = new jsPDF();
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 18;
  const lineWidth = pageWidth - margin * 2;
  let y = 20;

  function addPageIfNeeded(height = 8) {
    if (y + height > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
  }

  function addText(text, size = 11, bold = false) {
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(size);

    const lines = pdf.splitTextToSize(
      String(text),
      lineWidth
    );

    for (const line of lines) {
      addPageIfNeeded(size * 0.5 + 2);
      pdf.text(line, margin, y);
      y += size * 0.5 + 2;
    }
  }

  addText("STUDENT WORK IMMERSION PORTFOLIO", 16, true);
  y += 4;

  addText(`Student Name: ${student.name || "Not provided"}`);
  addText(`Grade & Section: ${student.gradeSection || "Not provided"}`);
  addText(`Strand: ${student.strand || "Not provided"}`);
  addText(`School: ${student.school || "Not provided"}`);

  y += 5;
  pdf.setDrawColor(180);
  pdf.line(margin, y, pageWidth - margin, y);
  y += 8;

  if (!entries.length) {
    addText("No saved portfolio entries were provided.");
  }

  entries.forEach((entry) => {
    addText(entry.section || entry.title || "Portfolio Entry", 13, true);
    y += 2;

    addText(valueToText(entry.content ?? entry.answer));
    y += 6;
  });

  const safeName = (student.name || "Student")
    .replace(/[^a-z0-9_-]/gi, "_");

  pdf.save(`${safeName}_Work_Immersion_Portfolio.pdf`);
}