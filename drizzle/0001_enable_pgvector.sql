-- pgvector, for vector search. On Azure Flexible Server, "vector" must be in the
-- azure.extensions server parameter and an Entra admin must create it before this runs
-- (README section 8.6). Azure rejects CREATE EXTENSION from non-admins even with
-- IF NOT EXISTS, so the app's identity only runs it when the extension is missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE EXTENSION vector;
  END IF;
END $$;
