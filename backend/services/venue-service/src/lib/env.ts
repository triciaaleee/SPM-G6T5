import dotenv from "dotenv";

// Must be imported before anything that reads process.env at module scope
// (e.g. lib/supabaseAdmin.ts) — ES module imports execute top-to-bottom
// before any other code in the importer runs, so a dotenv.config() call
// placed as a plain statement in index.ts (after other imports) would run
// too late: those imports' own top-level code would already have tried to
// read empty env vars. Importing this side-effect-only module first, as
// index.ts's very first import, guarantees the env is loaded before any
// sibling import's top-level code runs.
dotenv.config({ path: "../../.env" });
