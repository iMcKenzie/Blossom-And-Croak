import { getStore } from "@netlify/blobs";

const MAX_ATTEMPTS = 5;

export default async (req) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return Response.json(
      { error: "Admin is not configured yet. Set the ADMIN_KEY environment variable in Netlify." },
      { status: 503 }
    );
  }
  if (req.headers.get("x-admin-key") !== adminKey) {
    return Response.json({ error: "Wrong passcode." }, { status: 401 });
  }

  // Strong consistency: reads feed edits, so stale cached reads would make
  // etag-conditional writes fail forever.
  const store = getStore({ name: "flower-shop", consistency: "strong" });

  if (req.method === "GET") {
    const data = (await store.get("inventory", { type: "json" })) || { flowers: [] };
    const reservations = ((await store.get("reservations", { type: "json" })) || []).slice(0, 25);
    return Response.json({ flowers: data.flowers || [], reservations });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  if (body.action === "uploadImage") {
    const match = String(body.dataUrl || "").match(
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/
    );
    if (!match) {
      return Response.json({ error: "Unsupported image format." }, { status: 400 });
    }
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    if (bytes.length > 3 * 1024 * 1024) {
      return Response.json({ error: "Image too large (max 3 MB after resize)." }, { status: 400 });
    }
    const key = `${Date.now()}-${crypto.randomUUID()}`;
    const images = getStore("flower-images");
    await images.set(key, bytes.buffer, { metadata: { contentType: match[1] } });
    return Response.json({ imageKey: key });
  }

  if (body.action === "save") {
    const f = body.flower || {};
    const name = String(f.name || "").trim().slice(0, 100);
    if (!name) {
      return Response.json({ error: "The flower needs a name." }, { status: 400 });
    }
    const flower = {
      id: f.id || crypto.randomUUID(),
      name,
      description: String(f.description || "").trim().slice(0, 300),
      pricePerStem: Math.max(0, Math.round(Number(f.pricePerStem || 0) * 100) / 100),
      qty: Math.max(0, Math.min(9999, Number.parseInt(f.qty, 10) || 0)),
      imageKey: f.imageKey || null,
      active: f.active !== false,
    };
    const ok = await mutateInventory(store, (data) => {
      const idx = data.flowers.findIndex((x) => x.id === flower.id);
      if (idx >= 0) data.flowers[idx] = flower;
      else data.flowers.push(flower);
    });
    if (!ok) return busy();
    return Response.json({ ok: true, flower });
  }

  if (body.action === "delete") {
    const id = String(body.id || "");
    const ok = await mutateInventory(store, (data) => {
      data.flowers = data.flowers.filter((x) => x.id !== id);
    });
    if (!ok) return busy();
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

// Read-modify-write with etag-conditional set, retried on conflict.
async function mutateInventory(store, mutate) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await store.getWithMetadata("inventory", { type: "json" });
    const data = res?.data || { flowers: [] };
    if (!Array.isArray(data.flowers)) data.flowers = [];
    mutate(data);
    data.updatedAt = new Date().toISOString();
    // Prefer an etag-conditional write; if the blob is new use onlyIfNew; if
    // the platform returned no etag (e.g. netlify dev sandbox), last write wins.
    const conditions = res?.etag ? { onlyIfMatch: res.etag } : !res ? { onlyIfNew: true } : {};
    const result = await store.set("inventory", JSON.stringify(data), conditions);
    if (result.modified) return true;
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }
  return false;
}

function busy() {
  return Response.json(
    { error: "Someone else was saving at the same time — please try again." },
    { status: 503 }
  );
}

export const config = { path: "/api/admin" };
