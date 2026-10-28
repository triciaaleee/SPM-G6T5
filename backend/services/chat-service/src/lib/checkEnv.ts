/**
 * Fail loudly at boot instead of at the first request. A missing JWT_SECRET
 * or service-role key otherwise surfaces as an opaque 500 from deep inside
 * jsonwebtoken or supabase-js, which is a miserable first run for anyone
 * who just cloned the repo.
 *
 * Its own module, imported right after lib/env.ts and BEFORE anything that
 * imports supabaseAdmin: ES imports run top-to-bottom before the importer's
 * own code, so a check written inline in index.ts ran too late —
 * createClient("") had already thrown "supabaseUrl is required." first.
 */
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET"] as const;
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missing.join(", ")}\n` +
      `Set them in backend/.env (see backend/.env.example).`,
  );
  process.exit(1);
}

export {};
