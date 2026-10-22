#!/usr/bin/env bash
# Builds a fresh database from supabase/migrations/ in filename order, then
# loads supabase/seed.sql. Run against an EMPTY database only — the local
# stack from `supabase start`, never the shared dev or production database.
#
#   supabase/scripts/build_database.sh "$(supabase status -o env | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
#
# Stops at the first failing statement, so a migration that doesn't apply
# cleanly from scratch fails loudly here.
set -euo pipefail

db_url="${1:?usage: build_database.sh <postgres connection url>}"
supabase_dir="$(cd "$(dirname "$0")/.." && pwd)"

# LC_ALL=C: plain byte order, so 0002_coordinator_... runs before
# 0002_organiser_... on every machine.
while IFS= read -r migration; do
  echo "applying $(basename "$migration")"
  psql "$db_url" --quiet -v ON_ERROR_STOP=1 -f "$migration" > /dev/null
done < <(find "$supabase_dir/migrations" -name '*.sql' | LC_ALL=C sort)

echo "seeding"
psql "$db_url" --quiet -v ON_ERROR_STOP=1 -f "$supabase_dir/seed.sql" > /dev/null

# The REST API caches the schema; make it pick up everything just created.
psql "$db_url" --quiet -c "notify pgrst, 'reload schema';"
