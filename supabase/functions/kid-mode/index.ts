// kid-mode Edge Function (replacement build).
//
// Portal dashboard backend for Kid Mode. Replaces the previous build whose
// POST handler hung. All routes are POST /functions/v1/kid-mode with a JSON
// body carrying an `action` field:
//
//   { action: "status" }                                  -> { ok, enabled, has_pin }
//   { action: "set_pin", pin, pin2 }                      -> { ok } (4-8 digits, pin === pin2)
//   { action: "change_pin", old_pin, pin, pin2 }          -> { ok } (verifies old first)
//   { action: "set_enabled", enabled, pin? }              -> { ok, enabled }
//        disabling with a PIN set requires the PIN; without it the
//        response is { ok: false, needs_pin: true }
//   { action: "sign_out_all" }                            -> { ok } (all sessions revoked)
//
// Auth: the caller's Supabase JWT in the Authorization header. The user_id is
// derived ONLY from that JWT via auth.getUser(). Service role is used for all
// table access so RLS is bypassed; ownership checks are explicit.
//
// PIN storage: Argon2id PHC strings (m=65536, t=3, p=4), matching the existing
// version-1 verifiers already in kid_mode_pin_verifiers. The PIN is never
// stored; only the verifier. Lockout: 5 wrong guesses -> 60s cooldown,
// enforced server-side where it cannot be tampered with.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.0";
import { argon2id } from "https://esm.sh/hash-wasm@4.12.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ARGON_M = 65536; // KiB (64 MiB)
const ARGON_T = 3;
const ARGON_P = 4;
const ARGON_HASH_LEN = 32;
const VERIFIER_VERSION = 1;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function b64ToBytes(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

interface PhcParams {
  m: number;
  t: number;
  p: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function parsePhc(phc: string): PhcParams | null {
  // $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
  const parts = phc.split("$");
  if (parts.length !== 6 || parts[1] !== "argon2id") return null;
  const paramParts = parts[3].split(",");
  const get = (k: string): number | null => {
    for (const pp of paramParts) {
      const [kk, vv] = pp.split("=");
      if (kk === k) {
        const n = parseInt(vv, 10);
        return Number.isFinite(n) ? n : null;
      }
    }
    return null;
  };
  const m = get("m");
  const t = get("t");
  const p = get("p");
  if (m === null || t === null || p === null) return null;
  try {
    return { m, t, p, salt: b64ToBytes(parts[4]), hash: b64ToBytes(parts[5]) };
  } catch {
    return null;
  }
}

async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return await argon2id({
    password: pin,
    salt,
    parallelism: ARGON_P,
    iterations: ARGON_T,
    memorySize: ARGON_M,
    hashLength: ARGON_HASH_LEN,
    outputType: "encoded",
  });
}

async function verifyPin(pin: string, storedPhc: string): Promise<boolean> {
  const params = parsePhc(storedPhc);
  if (!params) return false;
  const recomputed = await argon2id({
    password: pin,
    salt: params.salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: params.hash.length,
    outputType: "binary",
  });
  return timingSafeEqual(recomputed as Uint8Array, params.hash);
}

function validPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,8}$/.test(pin);
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method not allowed" });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON body" });
  }

  const action = body.action;
  if (typeof action !== "string") {
    return json(400, { ok: false, error: "missing action" });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json(401, { ok: false, error: "missing authorization" });
  }
  const userJwt = authHeader.slice("Bearer ".length).trim();

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await db.auth.getUser(userJwt);
  if (userErr || !userData?.user) {
    return json(401, { ok: false, error: "invalid session" });
  }
  const userId = userData.user.id;
  const now = new Date();

  const loadSettings = async () => {
    const { data } = await db
      .from("kid_mode_settings")
      .select("enabled")
      .eq("user_id", userId)
      .maybeSingle();
    return data;
  };

  const loadVerifier = async () => {
    const { data } = await db
      .from("kid_mode_pin_verifiers")
      .select("verifier, failed_attempts, locked_until")
      .eq("user_id", userId)
      .maybeSingle();
    return data;
  };

  // ---- status -----------------------------------------------------------
  if (action === "status") {
    const settings = await loadSettings();
    const verifier = await loadVerifier();
    return json(200, {
      ok: true,
      enabled: settings?.enabled === true,
      has_pin: verifier !== null,
    });
  }

  // ---- set_pin ----------------------------------------------------------
  if (action === "set_pin") {
    const pin = body.pin;
    const pin2 = body.pin2;
    if (!validPin(pin)) {
      return json(400, { ok: false, error: "PIN must be 4-8 digits" });
    }
    if (pin !== pin2) {
      return json(400, { ok: false, error: "PINs do not match" });
    }
    const verifier = await hashPin(pin);
    const { error } = await db.from("kid_mode_pin_verifiers").upsert(
      {
        user_id: userId,
        verifier,
        version: VERIFIER_VERSION,
        failed_attempts: 0,
        locked_until: null,
        updated_at: now.toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) return json(500, { ok: false, error: "could not save PIN" });
    return json(200, { ok: true });
  }

  // ---- change_pin -------------------------------------------------------
  if (action === "change_pin") {
    const oldPin = body.old_pin;
    const pin = body.pin;
    const pin2 = body.pin2;
    if (!validPin(pin)) {
      return json(400, { ok: false, error: "PIN must be 4-8 digits" });
    }
    if (pin !== pin2) {
      return json(400, { ok: false, error: "PINs do not match" });
    }
    const row = await loadVerifier();
    if (!row) {
      return json(400, { ok: false, error: "no PIN set" });
    }
    if (row.locked_until && new Date(row.locked_until) > now) {
      return json(429, { ok: false, locked: true, error: "too many tries, wait a minute" });
    }
    const good = await verifyPin(String(oldPin), row.verifier);
    if (!good) {
      const attempts = (row.failed_attempts || 0) + 1;
      await db.from("kid_mode_pin_verifiers").update({
        failed_attempts: attempts,
        locked_until: attempts >= MAX_ATTEMPTS
          ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
          : null,
        updated_at: now.toISOString(),
      }).eq("user_id", userId);
      return json(200, { ok: false, error: "wrong PIN" });
    }
    const verifier = await hashPin(pin);
    const { error } = await db.from("kid_mode_pin_verifiers").update({
      verifier,
      version: VERIFIER_VERSION,
      failed_attempts: 0,
      locked_until: null,
      updated_at: now.toISOString(),
    }).eq("user_id", userId);
    if (error) return json(500, { ok: false, error: "could not save PIN" });
    return json(200, { ok: true });
  }

  // ---- set_enabled ------------------------------------------------------
  if (action === "set_enabled") {
    const want = body.enabled === true;
    if (!want) {
      // Disabling requires the PIN when one is set.
      const row = await loadVerifier();
      if (row) {
        const pin = body.pin;
        if (!validPin(pin)) {
          return json(200, { ok: false, needs_pin: true });
        }
        if (row.locked_until && new Date(row.locked_until) > now) {
          return json(429, { ok: false, locked: true, error: "too many tries, wait a minute" });
        }
        const good = await verifyPin(String(pin), row.verifier);
        if (!good) {
          const attempts = (row.failed_attempts || 0) + 1;
          await db.from("kid_mode_pin_verifiers").update({
            failed_attempts: attempts,
            locked_until: attempts >= MAX_ATTEMPTS
              ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
              : null,
            updated_at: now.toISOString(),
          }).eq("user_id", userId);
          return json(200, { ok: false, error: "wrong PIN" });
        }
        await db.from("kid_mode_pin_verifiers").update({
          failed_attempts: 0,
          locked_until: null,
        }).eq("user_id", userId);
      }
    }
    const { error } = await db.from("kid_mode_settings").upsert(
      { user_id: userId, enabled: want, updated_at: now.toISOString() },
      { onConflict: "user_id" },
    );
    if (error) return json(500, { ok: false, error: "could not update setting" });
    return json(200, { ok: true, enabled: want });
  }

  // ---- sign_out_all -----------------------------------------------------
  if (action === "sign_out_all") {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await userClient.auth.signOut({ scope: "global" });
    if (error) {
      // Best effort: also revoke this session via the admin API.
      await db.auth.admin.signOut(userJwt).catch(() => null);
      return json(500, { ok: false, error: "could not sign out everywhere" });
    }
    return json(200, { ok: true });
  }

  return json(400, { ok: false, error: "unknown action" });
});
