import { Router } from "express";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { signToken } from "../lib/jwt.js";

export const authRouter = Router();

const BCRYPT_ROUNDS = 10;

authRouter.post("/signup", async (req, res) => {
  const { name, email, password } = req.body ?? {};

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  if (typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "Email is required" });
    return;
  }
  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const { data: existing } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const { data: generatedId, error: idError } = await supabaseAdmin.rpc("generate_user_id", {
    p_role: "attendee",
  });

  if (idError || !generatedId) {
    res.status(500).json({ error: "Failed to create account" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { data: user, error } = await supabaseAdmin
    .from("users")
    .insert({
      id: generatedId,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password_hash: passwordHash,
      role: "attendee",
    })
    .select("id, name, email, role")
    .single();

  if (error || !user) {
    res.status(500).json({ error: "Failed to create account" });
    return;
  }

  const token = signToken({ sub: user.id, role: user.role });
  res.status(201).json({ token, user });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select("id, name, email, role, password_hash")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  if (error || !user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const token = signToken({ sub: user.id, role: user.role });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});
