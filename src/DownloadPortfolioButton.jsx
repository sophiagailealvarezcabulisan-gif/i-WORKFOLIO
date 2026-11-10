import { downloadPortfolioPDF } from "./downloadPortfolioPDF";

export default function DownloadPortfolioButton({
  student,
  entries,
}) {
  return (
    <button
      type="button"
      onClick={() =>
        downloadPortfolioPDF({ student, entries })
      }
    >
      Download Portfolio as PDF
    </button>
  );
}