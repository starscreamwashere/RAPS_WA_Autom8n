#!/bin/bash
# Runs once on first Postgres start. Creates a separate database for n8n
# and enables btree_gist in the app database (needed by the EXCLUDE constraint).
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE DATABASE ${N8N_DB:-n8n};
  CREATE EXTENSION IF NOT EXISTS btree_gist;
SQL
