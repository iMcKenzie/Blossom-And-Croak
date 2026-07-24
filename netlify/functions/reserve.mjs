import { getStore } from "@netlify/blobs";

const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const gate = process.env.WHOLESALE_KEY;
  if (gate && req.headers.get("x-shop-key") !== gate) {
    return Response.json({ error: "Password required" }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const name = String(body.name || "").trim().slice(0, 100);
  const email = String(body.email || "").trim().slice(0, 200);
  const phone = String(body.phone || "").trim().slice(0, 40);
  const note = String(body.note || "").trim().slice(0, 500);

  if (!name || !EMAIL_RE.test(email)) {
    return Response.json({ error: "Please provide your name and a valid email." }, { status: 400 });
  }

  // Normalize basket items, merging duplicate flower ids.
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const wanted = new Map();
  for (const item of rawItems) {
    const id = String(item?.flowerId || "");
    const qty = Number.parseInt(item?.quantity, 10);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 500) {
      return Response.json({ error: "Please choose valid quantities." }, { status: 400 });
    }
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  if (wanted.size === 0 || wanted.size > 20) {
    return Response.json({ error: "Your basket is empty." }, { status: 400 });
  }

  // Strong consistency: the read feeds an etag-conditional write, and a stale
  // cached read would make the write fail on every retry.
  const store = getStore({ name: "flower-shop", consistency: "strong" });

  // Decrement every basket item in one all-or-nothing conditional write so two
  // simultaneous reservations can't both take the last stems.
  let reservedItems = null;
  let remaining = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await store.getWithMetadata("inventory", { type: "json" });
    const data = res?.data || { flowers: [] };
    const flowers = data.flowers || [];

    const shortages = {};
    const picks = [];
    for (const [id, qty] of wanted) {
      const flower = flowers.find((f) => f.id === id && f.active !== false);
      if (!flower) {
        shortages[id] = 0;
      } else if (flower.qty < qty) {
        shortages[id] = flower.qty;
      } else {
        picks.push({ flower, qty });
      }
    }
    if (Object.keys(shortages).length > 0) {
      return Response.json(
        {
          error: "Some flowers in your basket just sold down — we've updated the quantities.",
          available: shortages,
        },
        { status: 409 }
      );
    }

    for (const { flower, qty } of picks) {
      flower.qty -= qty;
    }
    data.updatedAt = new Date().toISOString();

    // Etag-conditional write where supported; the netlify dev sandbox returns
    // no etags, so fall back to a plain write there (last write wins).
    const result = await store.set(
      "inventory",
      JSON.stringify(data),
      res?.etag ? { onlyIfMatch: res.etag } : {}
    );
    if (result.modified) {
      reservedItems = picks.map(({ flower, qty }) => ({
        flowerId: flower.id,
        flowerName: flower.name,
        quantity: qty,
        pricePerStem: flower.pricePerStem,
      }));
      remaining = Object.fromEntries(picks.map(({ flower }) => [flower.id, flower.qty]));
      break;
    }
    // Someone else wrote in between — re-read and try again.
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }

  if (!reservedItems) {
    return Response.json(
      { error: "We're a little busy right now — please try again in a moment." },
      { status: 503 }
    );
  }

  const reservation = {
    id: crypto.randomUUID(),
    items: reservedItems,
    name,
    email,
    phone,
    note,
    at: new Date().toISOString(),
  };

  // Keep a record of reservations so nothing is lost even if email fails.
  try {
    const list = (await store.get("reservations", { type: "json" })) || [];
    list.unshift(reservation);
    await store.set("reservations", JSON.stringify(list.slice(0, 300)));
  } catch {
    // Non-fatal: the reservation already decremented inventory.
  }

  let emailSent = false;
  try {
    emailSent = await notifyEmma(reservation, remaining);
  } catch {
    emailSent = false;
  }

  return Response.json({ ok: true, remaining, emailSent });
};

async function notifyEmma(r, remaining) {
  const totalStems = r.items.reduce((sum, i) => sum + i.quantity, 0);
  const totalPrice = r.items.reduce((sum, i) => sum + i.quantity * (i.pricePerStem || 0), 0);
  const subject = `Flower reservation — ${r.name} (${totalStems} stems)`;
  const text = [
    `New reservation from the Wholesale Flowers page!`,
    ``,
    ...r.items.map(
      (i) =>
        `- ${i.quantity} x ${i.flowerName} @ $${Number(i.pricePerStem || 0).toFixed(2)}/stem (${remaining[i.flowerId]} left)`
    ),
    ``,
    `Estimated total: $${totalPrice.toFixed(2)}`,
    ``,
    `Name: ${r.name}`,
    `Email: ${r.email}`,
    r.phone ? `Phone: ${r.phone}` : null,
    r.note ? `Note: ${r.note}` : null,
    ``,
    `Reserved at: ${r.at}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  // Preferred: Resend (set RESEND_API_KEY, optionally RESEND_FROM / NOTIFY_EMAIL).
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "Blossom & Croak <onboarding@resend.dev>",
        to: [process.env.NOTIFY_EMAIL || "blossomandcroak@gmail.com"],
        reply_to: r.email,
        subject,
        text,
      }),
    });
    return res.ok;
  }

  // Fallback: Formspree (the site already uses it). Set FORMSPREE_ENDPOINT to a
  // dedicated form; defaults to the existing newsletter form.
  const endpoint = process.env.FORMSPREE_ENDPOINT || "https://formspree.io/f/xeeejydq";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      _subject: subject,
      name: r.name,
      email: r.email,
      message: text,
    }),
  });
  return res.ok;
}

export const config = { path: "/api/reserve" };
