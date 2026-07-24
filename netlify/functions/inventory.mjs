import { getStore } from "@netlify/blobs";

// Read-only view of the flower inventory, gated behind the shared wholesale
// password when WHOLESALE_KEY is set.
export default async (req) => {
  const gate = process.env.WHOLESALE_KEY;
  if (gate && req.headers.get("x-shop-key") !== gate) {
    return Response.json({ error: "Password required" }, { status: 401 });
  }
  // Strong consistency so shoppers see Emma's updates (and reservations) right away.
  const store = getStore({ name: "flower-shop", consistency: "strong" });
  const data = (await store.get("inventory", { type: "json" })) || { flowers: [] };

  const flowers = (data.flowers || [])
    .filter((f) => f.active !== false)
    .map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description || "",
      pricePerStem: f.pricePerStem,
      qty: f.qty,
      image: f.imageKey
        ? `/api/flower-image?key=${encodeURIComponent(f.imageKey)}`
        : f.imageUrl || null,
    }));

  return Response.json(
    { flowers, updatedAt: data.updatedAt || null },
    { headers: { "cache-control": "no-store" } }
  );
};

export const config = { path: "/api/inventory" };
