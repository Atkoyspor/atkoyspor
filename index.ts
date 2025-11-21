<<<<<<< HEAD
// Supabase Edge Function: generate-monthly-fees
// Schedules monthly membership fee creation for all active students.
// - Runs via Supabase Cron (see supabase/config.toml)
// - Can be triggered manually (POST) with an optional shared secret header: X-FEE-SECRET

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Utility: format period as YYYY-MM
function getCurrentPeriod(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  return {
    year,
    month,
    period: `${year}-${String(month).padStart(2, "0")}`,
  };
}

// Build a map from branch id to fee and name
function buildBranchMap(branches: any[]) {
  const map: Record<string, any> = {};
  for (const b of branches || []) {
    map[String(b.id)] = b;
  }
  return map;
}

serve(async (req: Request) => {
  try {
    // Auth: allow scheduled runs without JWT; optional shared secret for manual trigger
    const secretFromEnv = Deno.env.get("FEE_TRIGGER_SECRET") || "";
    const incomingSecret = req.headers.get("X-FEE-SECRET") || "";
    const isManualTrigger = req.method !== "OPTIONS" && req.method !== "GET"; // POST/PUT/PATCH/DELETE considered manual

    if (isManualTrigger && secretFromEnv && incomingSecret !== secretFromEnv) {
      return new Response(JSON.stringify({ error: "Unauthorized manual trigger" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Missing SUPABASE_URL or SERVICE_ROLE key" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { year, month, period } = getCurrentPeriod();

    // 1) Fetch active students
    const { data: students, error: studentsError } = await supabase
      .from("students")
      .select("id, sport_branch_id, discount_rate, first_name, last_name, name, surname, status")
      .eq("status", "active");

    if (studentsError) throw studentsError;

    if (!students || students.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No active students" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2) Fetch sport branches for monthly fees
    const { data: branches, error: branchesError } = await supabase
      .from("sport_branches")
      .select("id, name, monthly_fee, fee");
    if (branchesError) throw branchesError;

    const branchMap = buildBranchMap(branches || []);

    // 3) Prevent duplicates: fetch already existing payment student ids for this period
    const { data: existing, error: existingError } = await supabase
      .from("payments")
      .select("student_id")
      .eq("payment_period", period);
    if (existingError) throw existingError;

    const already = new Set((existing || []).map((e: any) => String(e.student_id)));

    // 4) Build new payments
    const paymentsToInsert: any[] = [];
    for (const s of students) {
      if (already.has(String(s.id))) continue;
      const br = branchMap[String(s.sport_branch_id)] || {};
      const monthlyFee = typeof br.monthly_fee === "number" && !Number.isNaN(br.monthly_fee)
        ? br.monthly_fee
        : (typeof br.fee === "number" && !Number.isNaN(br.fee) ? br.fee : 500);
      const discountRate = typeof s.discount_rate === "number" ? s.discount_rate : 0;
      const amount = Number((monthlyFee * (1 - discountRate / 100)).toFixed(2));

      paymentsToInsert.push({
        student_id: s.id,
        amount: amount,
        payment_date: null,
        payment_method: null,
        period_month: month,
        period_year: year,
        payment_period: period,
        notes: `${br.name || "Spor"} branşı için aylık aidat - ${period}`,
        is_paid: false,
      });
    }

    if (paymentsToInsert.length === 0) {
      return new Response(JSON.stringify({ success: true, message: `No new payments to insert for ${period}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5) Insert in batches (avoid exceeding payload limits)
    const batchSize = 500;
    let insertedTotal = 0;

    for (let i = 0; i < paymentsToInsert.length; i += batchSize) {
      const batch = paymentsToInsert.slice(i, i + batchSize);
      const { error: insertError } = await supabase.from("payments").insert(batch);
      if (insertError) throw insertError;
      insertedTotal += batch.length;
    }

    // 6) Log activity (best-effort)
    await supabase.from("activity_logs").insert({
      action: "generate_monthly_fees",
      entity_type: "system",
      entity_id: null,
      description: `Generated ${insertedTotal} monthly fees for ${period}`,
      created_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({ success: true, period, inserted: insertedTotal }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("generate-monthly-fees error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error?.message || error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
=======
// Supabase Edge Function: generate-monthly-fees
// Schedules monthly membership fee creation for all active students.
// - Runs via Supabase Cron (see supabase/config.toml)
// - Can be triggered manually (POST) with an optional shared secret header: X-FEE-SECRET

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Utility: format period as YYYY-MM
function getCurrentPeriod(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  return {
    year,
    month,
    period: `${year}-${String(month).padStart(2, "0")}`,
  };
}

// Build a map from branch id to fee and name
function buildBranchMap(branches: any[]) {
  const map: Record<string, any> = {};
  for (const b of branches || []) {
    map[String(b.id)] = b;
  }
  return map;
}

serve(async (req: Request) => {
  try {
    // Auth: allow scheduled runs without JWT; optional shared secret for manual trigger
    const secretFromEnv = Deno.env.get("FEE_TRIGGER_SECRET") || "";
    const incomingSecret = req.headers.get("X-FEE-SECRET") || "";
    const isManualTrigger = req.method !== "OPTIONS" && req.method !== "GET"; // POST/PUT/PATCH/DELETE considered manual

    if (isManualTrigger && secretFromEnv && incomingSecret !== secretFromEnv) {
      return new Response(JSON.stringify({ error: "Unauthorized manual trigger" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Missing SUPABASE_URL or SERVICE_ROLE key" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { year, month, period } = getCurrentPeriod();

    // 1) Fetch active students
    const { data: students, error: studentsError } = await supabase
      .from("students")
      .select("id, sport_branch_id, discount_rate, first_name, last_name, name, surname, status")
      .eq("status", "active");

    if (studentsError) throw studentsError;

    if (!students || students.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No active students" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2) Fetch sport branches for monthly fees
    const { data: branches, error: branchesError } = await supabase
      .from("sport_branches")
      .select("id, name, monthly_fee, fee");
    if (branchesError) throw branchesError;

    const branchMap = buildBranchMap(branches || []);

    // 3) Prevent duplicates: fetch already existing payment student ids for this period
    const { data: existing, error: existingError } = await supabase
      .from("payments")
      .select("student_id")
      .eq("payment_period", period);
    if (existingError) throw existingError;

    const already = new Set((existing || []).map((e: any) => String(e.student_id)));

    // 4) Build new payments
    const paymentsToInsert: any[] = [];
    for (const s of students) {
      if (already.has(String(s.id))) continue;
      const br = branchMap[String(s.sport_branch_id)] || {};
      const monthlyFee = typeof br.monthly_fee === "number" && !Number.isNaN(br.monthly_fee)
        ? br.monthly_fee
        : (typeof br.fee === "number" && !Number.isNaN(br.fee) ? br.fee : 500);
      const discountRate = typeof s.discount_rate === "number" ? s.discount_rate : 0;
      const amount = Number((monthlyFee * (1 - discountRate / 100)).toFixed(2));

      paymentsToInsert.push({
        student_id: s.id,
        amount: amount,
        payment_date: null,
        payment_method: null,
        period_month: month,
        period_year: year,
        payment_period: period,
        notes: `${br.name || "Spor"} branşı için aylık aidat - ${period}`,
        is_paid: false,
      });
    }

    if (paymentsToInsert.length === 0) {
      return new Response(JSON.stringify({ success: true, message: `No new payments to insert for ${period}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5) Insert in batches (avoid exceeding payload limits)
    const batchSize = 500;
    let insertedTotal = 0;

    for (let i = 0; i < paymentsToInsert.length; i += batchSize) {
      const batch = paymentsToInsert.slice(i, i + batchSize);
      const { error: insertError } = await supabase.from("payments").insert(batch);
      if (insertError) throw insertError;
      insertedTotal += batch.length;
    }

    // 6) Log activity (best-effort)
    await supabase.from("activity_logs").insert({
      action: "generate_monthly_fees",
      entity_type: "system",
      entity_id: null,
      description: `Generated ${insertedTotal} monthly fees for ${period}`,
      created_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({ success: true, period, inserted: insertedTotal }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("generate-monthly-fees error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error?.message || error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
>>>>>>> ecd8f28074c2383e9e73d704d7b89ec7d410bbb2
