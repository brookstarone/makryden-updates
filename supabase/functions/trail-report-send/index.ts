// trail-report-send — deliver Trail Report weekly emails.
// The function NEVER stores browsing data permanently. Stats arrive in the
// request body (device → function) and are discarded after the send, except
// for the transient outbox (flushed weekly by pg_cron, 7-day TTL).
//
// Routes (all under /functions/v1/trail-report-send):
//   POST /  {trail_token, stats, week, stage:true}  → stage stats in outbox
//   POST /  {trail_token, stats, week}              → validate + send now
//   POST /  {trail_token, sample:true}              → "send me a sample now"
//   POST /  {flush:true}  (service_role only)      → pg_cron weekly flush
//
// Resend: open/click tracking are disabled at the API-key level in the
// Resend dashboard; this function also never embeds pixels or tracked URLs.
// List-Unsubscribe header + footer link on every send.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.0";
import { renderHtml, renderText, renderSubject } from "../_shared/email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM = "StarBrook <starbrook@makrydensystems.com>";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const FUNCTION_BASE = `${SUPABASE_URL}/functions/v1`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isoWeek(d = new Date()): string {
  // ISO week key 'YYYY-WW' — the idempotency key for weekly sends.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - first.getTime()) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

interface Sub {
  id: string;
  user_id: string;
  email: string;
  trail_token: string;
  subscribed: boolean;
  frequency: string;
  last_sent_week: string | null;
}

async function sendResend(to: string, subject: string, html: string, text: string, unsubUrl: string): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      html,
      text,
      headers: { "List-Unsubscribe": `<${unsubUrl}>` },
    }),
  });
  if (!res.ok) {
    console.error("resend error", res.status, (await res.text().catch(() => "")).slice(0, 300));
  }
  return res.ok;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({}));
  const auth = req.headers.get("Authorization") || "";
  const isService = auth === `Bearer ${SERVICE_KEY}`;

  // ── Weekly flush (pg_cron, service_role only) ────────────────────
  if (body.flush === true) {
    if (!isService) return json({ ok: false, error: "forbidden" }, 403);
    const { data: rows } = await db
      .from("trail_report_outbox")
      .select("id,sub_id,week_key,stats,trail_report_subs!inner(id,email,trail_token,subscribed,frequency,user_id)")
      .limit(500);
    let sent = 0;
    for (const row of rows || []) {
      const sub = row.trail_report_subs as unknown as Sub;
      // Re-check Kid Mode at send time (defense in depth).
      const { data: km } = await db
        .from("kid_mode_settings")
        .select("enabled")
        .eq("user_id", sub.user_id)
        .maybeSingle();
      if (km?.enabled || !sub.subscribed) {
        await db.from("trail_report_outbox").delete().eq("id", row.id);
        continue;
      }
      if (sub.last_sent_week === row.week_key) {
        await db.from("trail_report_outbox").delete().eq("id", row.id);
        continue; // already sent (idempotent)
      }
      const stats = row.stats;
      const input = { stats, email: sub.email, trailToken: sub.trail_token, functionBase: FUNCTION_BASE };
      const html = renderHtml(input);
      const text = renderText(input);
      const unsub = `${FUNCTION_BASE}/trail-report-subscribe/unsubscribe?token=${sub.trail_token}`;
      const ok = await sendResend(sub.email, renderSubject(stats), html, text, unsub);
      if (ok) {
        await db.from("trail_report_subs").update({
          last_sent_week: row.week_key,
          updated_at: new Date().toISOString(),
        }).eq("id", sub.id);
        sent++;
      }
      // Delete the staged stats either way — never let browsing data linger.
      await db.from("trail_report_outbox").delete().eq("id", row.id);
    }
    return json({ ok: true, sent });
  }

  // ── Device-authenticated routes: resolve sub by trail_token ───────
  const token = String(body.trail_token || "");
  if (!token) return json({ ok: false, error: "trail_token required" }, 401);
  const { data: sub } = await db
    .from("trail_report_subs")
    .select("id,user_id,email,trail_token,subscribed,frequency,last_sent_week")
    .eq("trail_token", token)
    .maybeSingle();
  if (!sub || !sub.subscribed) {
    return json({ ok: false, error: "not subscribed" }, 403);
  }
  const { data: km } = await db
    .from("kid_mode_settings")
    .select("enabled")
    .eq("user_id", sub.user_id)
    .maybeSingle();
  if (km?.enabled) return json({ ok: false, error: "kid mode active" }, 403);

  const week = String(body.week || isoWeek());
  const stats = body.stats || {};
  const unsub = `${FUNCTION_BASE}/trail-report-subscribe/unsubscribe?token=${sub.trail_token}`;

  // ── "Send me a sample now" ───────────────────────────────────────
  if (body.sample === true) {
    const sampleStats = {
      trackers: 1412, ads: 386, bytesSaved: 214748364, msSaved: 2280000,
      days: [
        { date: "2026-10-15", trackers: 180, ads: 42 },
        { date: "2026-10-16", trackers: 220, ads: 61 },
        { date: "2026-10-17", trackers: 195, ads: 55 },
        { date: "2026-10-18", trackers: 240, ads: 70 },
        { date: "2026-10-19", trackers: 175, ads: 48 },
        { date: "2026-10-20", trackers: 210, ads: 58 },
        { date: "2026-10-21", trackers: 192, ads: 52 },
      ],
      topDomains: [
        { domain: "doubleclick.net", count: 214 },
        { domain: "googletagmanager.com", count: 186 },
        { domain: "facebook.net", count: 142 },
      ],
    };
    const input = { stats: sampleStats, email: sub.email, trailToken: sub.trail_token, functionBase: FUNCTION_BASE, sample: true };
    const ok = await sendResend(sub.email, renderSubject(sampleStats, true), renderHtml(input), renderText(input), unsub);
    return json({ ok });
  }

  // Basic stats sanity (never trust the client blindly, never persist it).
  if (typeof stats !== "object" || stats === null) {
    return json({ ok: false, error: "invalid stats" }, 400);
  }

  // ── Stage for the weekly flush ───────────────────────────────────
  if (body.stage === true) {
    const { error } = await db.from("trail_report_outbox").upsert(
      { sub_id: sub.id, week_key: week, stats, created_at: new Date().toISOString() },
      { onConflict: "sub_id,week_key" },
    );
    if (error) {
      console.error("outbox upsert", error.message);
      return json({ ok: false, error: "could not stage" }, 500);
    }
    return json({ ok: true, staged: true, week });
  }

  // ── Direct send (device-initiated, idempotent per week) ──────────
  if (sub.last_sent_week === week) {
    return json({ ok: true, already_sent: true, week });
  }
  const input = { stats, email: sub.email, trailToken: sub.trail_token, functionBase: FUNCTION_BASE };
  const ok = await sendResend(sub.email, renderSubject(stats), renderHtml(input), renderText(input), unsub);
  if (ok) {
    await db.from("trail_report_subs").update({
      last_sent_week: week,
      updated_at: new Date().toISOString(),
    }).eq("id", sub.id);
  }
  return json({ ok, week });
});
