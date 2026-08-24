import { prisma } from "../config/db.config";

type TextColumn = {
  table_schema: string;
  table_name: string;
  column_name: string;
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function main(): Promise<void> {
  const columns = await prisma.$queryRawUnsafe<TextColumn[]>(
    "SELECT table_schema, table_name, column_name " +
      "FROM information_schema.columns " +
      "WHERE table_schema = 'public' " +
      "AND data_type IN ('text', 'character varying', 'json', 'jsonb') " +
      "ORDER BY table_name, column_name",
  );
  const hits: Array<{ table: string; column: string; count: number }> = [];
  for (const column of columns) {
    const table = `${quoteIdentifier(column.table_schema)}.${quoteIdentifier(
      column.table_name,
    )}`;
    const field = quoteIdentifier(column.column_name);
    const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM ${table} ` +
        `WHERE CAST(${field} AS text) LIKE '%res.cloudinary.com%'`,
    );
    const count = Number(rows[0]?.count ?? 0);
    if (count > 0) {
      hits.push({
        table: column.table_name,
        column: column.column_name,
        count,
      });
    }
  }
  console.log(JSON.stringify({ legacyCloudinaryColumns: hits }, null, 2));
}

await main().finally(() => prisma.$disconnect());
