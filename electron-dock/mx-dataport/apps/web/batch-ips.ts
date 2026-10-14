import { read, utils } from "xlsx";
export function parseIpWorkbook(data: ArrayBuffer) {
  const book = read(data, {
    type: "array",
    sheetRows: 502,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
  });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw Error("文件中没有工作表。");
  const table = utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: true,
  });
  if (table.length > 501) throw Error("每次最多上传 500 行，请拆分文件。");
  const column =
    table[0]?.findIndex((v) => String(v).trim().toUpperCase() === "IP") ?? -1;
  if (column < 0) throw Error("第一行必须包含名为 IP 的列。");
  const ips = [
    ...new Set(
      table
        .slice(1)
        .map((row) => String(row[column] ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (!ips.length) throw Error("未找到 IP 地址。");
  return ips;
}
