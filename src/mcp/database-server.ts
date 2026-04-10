/**
 * Database MCP Server — Custom in-process MCP server for Supabase Postgres
 *
 * Replaces @modelcontextprotocol/server-postgres which is read-only.
 * Provides a single db_query tool that handles SELECT, INSERT, UPDATE, DELETE
 * with parameterized queries (SQL injection safe).
 *
 * Tools:
 * - db_query: Execute parameterized SQL (any statement type)
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import pg from 'pg';

const { Pool } = pg;

let poolInstance: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!poolInstance) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    poolInstance = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      ssl: { rejectUnauthorized: false },
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    poolInstance.on('error', (err) => {
      console.error('[database-mcp] Pool error:', err.message);
    });
  }
  return poolInstance;
}

const dbQuery = tool(
  'db_query',
  'Execute a parameterized SQL query against the Supabase Postgres database. Supports SELECT, INSERT, UPDATE, DELETE, and any other statement. Use $1, $2, $3, etc. for parameter placeholders to prevent SQL injection. Returns rowCount and rows array (rows will be populated for SELECT and writes that include a RETURNING clause). For INSERT statements, ALWAYS include RETURNING id (or specific columns) to get back the inserted IDs.',
  {
    sql: z.string().describe('Parameterized SQL query. Use $1, $2, $3 for parameter placeholders.'),
    params: z.array(z.any()).optional().describe('Array of parameter values matching the placeholders in order. Use null for null values.'),
  },
  async (args) => {
    try {
      const pool = getPool();
      const result = await pool.query(args.sql, args.params || []);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            command: result.command,
            rowCount: result.rowCount,
            rows: result.rows,
          }),
        }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: `Database query failed: ${errorMessage}`,
            sql: args.sql.slice(0, 200),
          }),
        }],
        isError: true,
      };
    }
  }
);

export const databaseServer = createSdkMcpServer({
  name: 'database',
  version: '1.0.0',
  tools: [dbQuery],
});
