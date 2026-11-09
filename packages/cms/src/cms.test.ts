import { describe, expect, it } from "vitest";
import { CmsStore, slugify } from "./index.js";

describe("CmsStore", () => {
  it("walks draft → in-review → published", () => {
    const store = new CmsStore();
    const entry = store.create({
      collection: "posts",
      data: { title: "Hello" },
      slug: slugify("Hello"),
      createdBy: "u1",
    });
    expect(entry.status).toBe("draft");
    expect(store.submitForReview(entry.id).status).toBe("in-review");
    expect(store.publish(entry.id).status).toBe("published");
  });

  it("rejects invalid transitions", () => {
    const store = new CmsStore();
    const entry = store.create({
      collection: "posts",
      data: {},
      slug: "x",
      createdBy: "u1",
    });
    expect(() => store.publish(entry.id)).toThrow(/Invalid transition/);
  });

  it("records revisions and restores them", () => {
    const store = new CmsStore();
    const entry = store.create({
      collection: "posts",
      data: { title: "v1" },
      slug: "x",
      createdBy: "u1",
    });
    store.update(entry.id, { title: "v2" });
    const revisions = store.revisionsFor(entry.id);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    const restored = store.restoreRevision(entry.id, revisions[0]!.id);
    expect(restored.data["title"]).toBe("v1");
  });

  it("slugifies titles", () => {
    expect(slugify("Hello, World! 123")).toBe("hello-world-123");
  });
});
