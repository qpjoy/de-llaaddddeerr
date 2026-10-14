export async function downloadExcel(
  name: string,
  headers: string[],
  rows: unknown[][],
) {
  const { Workbook } = await import("exceljs");
  const book = new Workbook(),
    sheet = book.addWorksheet("DataPort");
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns.forEach((c) => {
    c.width = 24;
  });
  const bytes = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
