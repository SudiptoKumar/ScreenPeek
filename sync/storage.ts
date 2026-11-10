export type SqlValue = string | number | null;
export interface SqlStatement { sql: string; params?: SqlValue[]; }
export interface SqlBatchResult { rowsWritten: number; }
export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  batch(statements: SqlStatement[]): Promise<SqlBatchResult>;
}
