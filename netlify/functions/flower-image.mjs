import { getStore } from "@netlify/blobs";

// Serves flower photos uploaded through the admin page.
export default async (req) => {
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });

  const store = getStore("flower-images");
  const res = await store.getWithMetadata(key, { type: "arrayBuffer" });
  if (!res || !res.data) return new Response("Not found", { status: 404 });

  return new Response(res.data, {
    headers: {
      "content-type": res.metadata?.contentType || "image/jpeg",
      // Keys are unique per upload, so the response can be cached forever.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};

export const config = { path: "/api/flower-image" };
